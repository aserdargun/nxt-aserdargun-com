import { createHash } from "node:crypto";
import { MAX_NOTE_SOURCE_BYTES, type CreateNoteRequest, type NoteResponse, type UpdateNoteRequest } from "@nxt/contracts";
import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { QueryClient } from "@tanstack/react-query";
import { EditorView } from "@uiw/react-codemirror";
import { attachmentIsReferenced, attachmentReferenceProjection, createPortableAttachmentMarkdown, projectionReferencesAttachment } from "@nxt/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";
import { ApiClientError, ApiContractError } from "../api/client";
import type { AttachmentClient } from "../api/attachments";
import { notesClient, type NotesClient } from "../api/notes";
import type { CompleteVault, VaultClient } from "../api/vault";
import { OwnerShell } from "../app/owner-shell";
import { AppProviders } from "../app/providers";
import { appRoutes } from "../app/router";
import type {
  DraftStore,
  LocalDraft,
  RecoveryCopy,
  RecoveryInput
} from "../editor/draft-store";
import { EditorWorkspace, type EditorWorkspaceState } from "../editor/editor-workspace";
import { MarkdownEditor } from "../editor/markdown-editor";
import { MarkdownPreview } from "../editor/markdown-preview";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const OTHER_NOTE_ID = "028f47d2-6a34-7b2a-9f21-8a7034963aef";
const RECOVERED_NOTE_ID = "038f47d2-6a34-7b2a-9f21-8a7034963aef";
const FOLDER_ID = "v1.abcdefghijklmnop.folder_1.abcdefghijklmnopqrstuv";
const ATTACHMENT_ID = "v1.abcdefghijklmnop.asset_1.abcdefghijklmnopqrstuv";
const INBOX_FOLDER_ID = "v1.abcdefghijklmnop.folder_2.abcdefghijklmnopqrstuv";
const PLANS_FOLDER_ID = "v1.abcdefghijklmnop.folder_3.abcdefghijklmnopqrstuv";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

const source = (
  body: string,
  input: {
    readonly aliases?: readonly string[];
    readonly id?: string;
    readonly title?: string;
    readonly updated?: string;
  } = {}
): string => `---
id: "${input.id ?? NOTE_ID}"
title: "${input.title ?? "Plan"}"
created: "2026-08-23T09:00:00.000Z"
updated: "${input.updated ?? "2026-08-23T09:03:00.000Z"}"
tags: []
aliases: [${(input.aliases ?? []).map((alias) => JSON.stringify(alias)).join(", ")}]
---

${body.replace(/\n*$/u, "")}
`;

const BASE_SOURCE = source("# Drive");
const LOCAL_SOURCE = source("# Local");
const NEWER_SOURCE = source("# Newer local");
const LATEST_DRIVE_SOURCE = source("# Latest Drive", { updated: "2026-08-23T09:15:00.000Z" });
const MERGED_SOURCE = source("# Merged", { updated: "2026-08-23T09:16:00.000Z" });

const noteDocument = (
  body: string,
  input: {
    readonly aliases?: readonly string[];
    readonly id?: string;
    readonly title?: string;
    readonly updated?: string;
  } = {}
): NoteResponse["note"] => ({
  frontmatter: {
    id: input.id ?? NOTE_ID,
    title: input.title ?? "Plan",
    created: "2026-08-23T09:00:00.000Z",
    updated: input.updated ?? "2026-08-23T09:03:00.000Z",
    tags: [],
    aliases: [...(input.aliases ?? [])]
  },
  body: `\n${body.replace(/^\n+|\n+$/gu, "")}\n`
});

const response = (
  body: string,
  input: {
    readonly aliases?: readonly string[];
    readonly id?: string;
    readonly title?: string;
    readonly updated?: string;
    readonly version?: string;
    readonly path?: string;
  } = {}
): NoteResponse => {
  const renderedSource = source(body, input);
  return {
    note: noteDocument(body, input),
    source: renderedSource,
    version: input.version ?? "7",
    path: input.path ?? "Notes/Plan.md",
    checksum: createHash("sha256").update(renderedSource).digest("hex")
  };
};

const BASE_RESPONSE = response("# Drive");
const LOCAL_RESPONSE = response("# Local", { version: "8" });
const NEWER_RESPONSE = response("# Newer local", { version: "9" });
const LATEST_DRIVE_RESPONSE = response("# Latest Drive", {
  updated: "2026-08-23T09:15:00.000Z",
  version: "8"
});
const MERGED_RESPONSE = response("# Merged", {
  updated: "2026-08-23T09:16:00.000Z",
  version: "9"
});

const OWNER_VAULT: CompleteVault = {
  entries: [
    {
      id: NOTE_ID,
      title: "Plan",
      aliases: [],
      path: "Notes/Plan.md",
      created: "2026-08-23T09:00:00.000Z",
      updated: "2026-08-23T09:03:00.000Z",
      driveVersion: "7",
      tags: ["plan"],
      searchText: "drive plan other",
      excerpt: "Drive",
      outboundNoteIds: [OTHER_NOTE_ID],
      unresolvedWikiTargets: ["Missing"],
      attachments: [{
        assetId: ATTACHMENT_ID,
        name: "diagram.png",
        mimeType: "image/png",
        size: 42,
        disposition: "inline"
      }],
      backlinks: [OTHER_NOTE_ID]
    },
    {
      id: OTHER_NOTE_ID,
      title: "Other",
      aliases: ["Reference"],
      path: "Notes/Other.md",
      created: "2026-08-23T09:00:00.000Z",
      updated: "2026-08-23T09:03:00.000Z",
      driveVersion: "2",
      tags: ["reference"],
      searchText: "other reference",
      excerpt: "Other",
      outboundNoteIds: [],
      unresolvedWikiTargets: [],
      attachments: [],
      backlinks: [NOTE_ID]
    }
  ],
  folders: [
    { id: FOLDER_ID, name: "Notes", path: "Notes", version: "3", protected: true },
    { id: INBOX_FOLDER_ID, name: "Inbox", path: "Notes/Inbox", version: "2", protected: true }
  ],
  preferences: { schemaVersion: 1, favorites: [NOTE_ID], recent: [NOTE_ID], theme: "dark" },
  treeVersion: "a".repeat(64)
};

class MemoryDraftStore implements DraftStore {
  public readonly drafts = new Map<string, LocalDraft>();
  public readonly recoveries: RecoveryCopy[] = [];
  public recoveryFailuresRemaining = 0;

  public get(noteId: string): Promise<LocalDraft | null> {
    return Promise.resolve(this.drafts.get(noteId) ?? null);
  }

  public put(draft: LocalDraft): Promise<void> {
    this.drafts.set(draft.noteId, { ...draft });
    return Promise.resolve();
  }

  public markConfirmed(input: {
    readonly noteId: string;
    readonly source: string;
    readonly localUpdatedAt: string;
  }): Promise<void> {
    const current = this.drafts.get(input.noteId);
    if (current?.source === input.source && current.localUpdatedAt === input.localUpdatedAt) {
      this.drafts.delete(input.noteId);
    }
    return Promise.resolve();
  }

  public remove(noteId: string): Promise<void> {
    this.drafts.delete(noteId);
    return Promise.resolve();
  }

  public preserveRecovery(input: RecoveryInput): Promise<void> {
    if (this.recoveryFailuresRemaining > 0) {
      this.recoveryFailuresRemaining -= 1;
      return Promise.reject(new Error("Recovery storage is unavailable."));
    }
    const id = `${input.noteId}:${input.localUpdatedAt}`;
    const existing = this.recoveries.find((copy) => copy.id === id);
    if (existing !== undefined && existing.source !== input.source) {
      return Promise.reject(new Error("The recovery key is already used by different content."));
    }
    if (existing === undefined) this.recoveries.push({ ...input, id });
    if (input.removeMatchingDraft && this.drafts.get(input.noteId)?.source === input.source) {
      this.drafts.delete(input.noteId);
    }
    return Promise.resolve();
  }

  public listRecoveries(
    noteId: string,
    options: { readonly cursor?: string; readonly limit: number }
  ): Promise<{
    readonly items: RecoveryCopy[];
    readonly nextCursor: string | null;
    readonly totalCount: number;
  }> {
    const matching = this.recoveries.filter((copy) => copy.noteId === noteId);
    const start = options.cursor === undefined
      ? 0
      : Math.max(0, matching.findIndex((copy) => copy.id === options.cursor) + 1);
    const items = matching.slice(start, start + options.limit);
    return Promise.resolve({
      items,
      nextCursor: start + items.length < matching.length ? items.at(-1)?.id ?? null : null,
      totalCount: matching.length
    });
  }
}

interface NotesHarness {
  readonly client: NotesClient;
  readonly getNote: ReturnType<typeof vi.fn<NotesClient["getNote"]>>;
  readonly updateNote: ReturnType<typeof vi.fn<NotesClient["updateNote"]>>;
  readonly createNote: ReturnType<typeof vi.fn<NotesClient["createNote"]>>;
  readonly moveNote: ReturnType<typeof vi.fn<NotesClient["moveNote"]>>;
  readonly archiveNote: ReturnType<typeof vi.fn<NotesClient["archiveNote"]>>;
  readonly trashNote: ReturnType<typeof vi.fn<NotesClient["trashNote"]>>;
}

const notesHarness = (initial: NoteResponse = BASE_RESPONSE): NotesHarness => {
  const getNote = vi.fn<NotesClient["getNote"]>().mockResolvedValue(initial);
  const updateNote = vi.fn<NotesClient["updateNote"]>().mockResolvedValue(LOCAL_RESPONSE);
  const createNote = vi.fn<NotesClient["createNote"]>();
  const moveNote = vi.fn<NotesClient["moveNote"]>();
  const archiveNote = vi.fn<NotesClient["archiveNote"]>();
  const trashNote = vi.fn<NotesClient["trashNote"]>();
  return {
    client: { getNote, updateNote, createNote, moveNote, archiveNote, trashNote },
    getNote,
    updateNote,
    createNote,
    moveNote,
    archiveNote,
    trashNote
  };
};

const stubMutableViewport = (initialWidth: number): {
  readonly setWidth: (width: number) => void;
} => {
  let width = initialWidth;
  const listeners = new Set<EventListener>();
  vi.stubGlobal("matchMedia", vi.fn((query: string): MediaQueryList => {
    const constraints = Array.from(
      query.matchAll(/\((min|max)-width:\s*(\d+)px\)/gu),
      ([, boundary, value]) => ({ boundary, value: Number(value) })
    );
    return {
      get matches(): boolean {
        return constraints.every(({ boundary, value }) =>
          boundary === "min" ? width >= value : width <= value
        );
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject | null) => {
        if (event === "change" && typeof listener === "function") listeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject | null) => {
        if (event === "change" && typeof listener === "function") listeners.delete(listener);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    };
  }));
  return {
    setWidth(nextWidth: number): void {
      width = nextWidth;
      act(() => {
        for (const listener of listeners) listener(new Event("change"));
      });
    }
  };
};

const deferred = <T,>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const getEditorView = async (): Promise<EditorView> => {
  const textbox = await screen.findByRole("textbox", { name: "Markdown editor" });
  const view = EditorView.findFromDOM(textbox);
  if (view === null) throw new Error("CodeMirror view is unavailable.");
  return view;
};

const installCodeMirrorGeometryHarness = (lineCount: number): {
  readonly getScrollTop: () => number;
  readonly getWindowScrollCalls: () => readonly unknown[][];
  readonly resetScrollWrites: () => void;
  readonly restore: () => void;
  readonly scrollWrites: readonly number[];
} => {
  const viewportHeight = 240;
  const viewportWidth = 640;
  const lineHeight = 20;
  const documentHeight = lineCount * lineHeight;
  let scrollTop = 0;
  const scrollWrites: number[] = [];
  const restores: Array<() => void> = [];
  const override = (target: object, key: PropertyKey, descriptor: PropertyDescriptor): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, descriptor);
    restores.push(() => {
      if (original === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, original);
    });
  };
  const isScroller = (element: Element): boolean => element.classList.contains("cm-scroller");
  const readNativeNumber = (
    descriptor: PropertyDescriptor | undefined,
    receiver: object
  ): number => {
    if (descriptor?.get === undefined) return 0;
    const value: unknown = descriptor.get.call(receiver);
    if (typeof value !== "number") throw new Error("A native geometry accessor returned a non-number.");
    return value;
  };
  const writeNativeNumber = (
    descriptor: PropertyDescriptor,
    receiver: object,
    value: number
  ): void => {
    if (descriptor.set === undefined) throw new Error("A native geometry setter is unavailable.");
    descriptor.set.call(receiver, value);
  };
  const callNativeZeroArgumentMethod = (
    descriptor: PropertyDescriptor | undefined,
    receiver: object
  ): unknown => {
    const method: unknown = descriptor?.value;
    if (typeof method !== "function") throw new Error("A native geometry method is unavailable.");
    return Reflect.apply(method, receiver, []);
  };
  const readNativeRect = (
    descriptor: PropertyDescriptor | undefined,
    receiver: object
  ): DOMRect => {
    const value = callNativeZeroArgumentMethod(descriptor, receiver);
    if (
      value === null ||
      typeof value !== "object" ||
      !("x" in value) || typeof value.x !== "number" ||
      !("y" in value) || typeof value.y !== "number" ||
      !("width" in value) || typeof value.width !== "number" ||
      !("height" in value) || typeof value.height !== "number"
    ) {
      throw new Error("A native geometry method returned a non-rectangle.");
    }
    return new DOMRect(value.x, value.y, value.width, value.height);
  };
  const toDomRectList = (values: readonly DOMRect[]): DOMRectList => {
    const rects = [...values];
    return Object.assign(rects, {
      item: (index: number): DOMRect | null => rects[index] ?? null
    });
  };
  const readNativeRectList = (
    descriptor: PropertyDescriptor | undefined,
    receiver: object
  ): DOMRectList => {
    const value = callNativeZeroArgumentMethod(descriptor, receiver);
    const isRectArray = (candidate: unknown): candidate is DOMRect[] =>
      Array.isArray(candidate) && candidate.every((item: unknown) => item instanceof DOMRect);
    if (!isRectArray(value)) {
      throw new Error("A native geometry method returned a non-rectangle-list.");
    }
    return toDomRectList(value);
  };

  const elementPrototype = Element.prototype;
  const htmlElementPrototype = HTMLElement.prototype;
  const nativeClientHeight = Object.getOwnPropertyDescriptor(elementPrototype, "clientHeight");
  const nativeClientWidth = Object.getOwnPropertyDescriptor(elementPrototype, "clientWidth");
  const nativeScrollHeight = Object.getOwnPropertyDescriptor(elementPrototype, "scrollHeight");
  const nativeScrollWidth = Object.getOwnPropertyDescriptor(elementPrototype, "scrollWidth");
  const nativeScrollTop = Object.getOwnPropertyDescriptor(elementPrototype, "scrollTop");
  const nativeOffsetHeight = Object.getOwnPropertyDescriptor(htmlElementPrototype, "offsetHeight");
  const nativeOffsetWidth = Object.getOwnPropertyDescriptor(htmlElementPrototype, "offsetWidth");
  if (nativeScrollTop?.get === undefined || nativeScrollTop.set === undefined) {
    throw new Error("jsdom scrollTop accessors are unavailable.");
  }

  override(elementPrototype, "clientHeight", {
    configurable: true,
    get(this: Element): number {
      return isScroller(this) ? viewportHeight : readNativeNumber(nativeClientHeight, this);
    }
  });
  override(elementPrototype, "clientWidth", {
    configurable: true,
    get(this: Element): number {
      return isScroller(this) ? viewportWidth : readNativeNumber(nativeClientWidth, this);
    }
  });
  override(elementPrototype, "scrollHeight", {
    configurable: true,
    get(this: Element): number {
      return isScroller(this) ? documentHeight : readNativeNumber(nativeScrollHeight, this);
    }
  });
  override(elementPrototype, "scrollWidth", {
    configurable: true,
    get(this: Element): number {
      return isScroller(this) ? viewportWidth : readNativeNumber(nativeScrollWidth, this);
    }
  });
  override(elementPrototype, "scrollTop", {
    configurable: true,
    get(this: Element): number {
      return isScroller(this) ? scrollTop : readNativeNumber(nativeScrollTop, this);
    },
    set(this: Element, value: number) {
      if (isScroller(this)) {
        scrollTop = Math.max(0, Math.min(Number(value), documentHeight - viewportHeight));
        scrollWrites.push(scrollTop);
      } else {
        writeNativeNumber(nativeScrollTop, this, value);
      }
    }
  });
  override(htmlElementPrototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (isScroller(this) || this.classList.contains("cm-editor")) return viewportHeight;
      if (this.classList.contains("cm-content")) return documentHeight;
      if (this.classList.contains("cm-line")) return lineHeight;
      return readNativeNumber(nativeOffsetHeight, this);
    }
  });
  override(htmlElementPrototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.closest(".cm-editor") !== null) return viewportWidth;
      return readNativeNumber(nativeOffsetWidth, this);
    }
  });

  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    new DOMRect(left, top, width, height);
  const nativeElementRect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  const elementRectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function(this: Element): DOMRect {
      if (isScroller(this) || this.classList.contains("cm-editor")) {
        return rect(0, 0, viewportWidth, viewportHeight);
      }
      if (this.classList.contains("cm-content")) {
        return rect(0, -scrollTop, viewportWidth, documentHeight);
      }
      if (this.classList.contains("cm-line")) {
        const lineNumber = Number(/^line (\d+)$/u.exec(this.textContent?.trim() ?? "")?.[1]);
        const top = Number.isFinite(lineNumber) ? (lineNumber - 1) * lineHeight - scrollTop : 0;
        return rect(0, top, viewportWidth, lineHeight);
      }
      return readNativeRect(nativeElementRect, this);
    }
  );

  const nativeRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const nativeRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  const windowScrollBySpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  const rangeRectsSpy = vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
    function(this: Range): DOMRectList {
      const startElement = this.startContainer.nodeType === Node.ELEMENT_NODE
        ? this.startContainer as Element
        : this.startContainer.parentElement;
      const line = startElement?.closest(".cm-line");
      if (line === null || line === undefined) return readNativeRectList(nativeRangeRects, this);
      const lineRect = line.getBoundingClientRect();
      const start = this.startOffset;
      const end = Math.max(start + 1, this.endOffset);
      return toDomRectList([rect(72 + start * 8, lineRect.top, (end - start) * 8, lineHeight)]);
    }
  );
  const rangeRectSpy = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
    function(this: Range): DOMRect {
      return this.getClientRects()[0] ?? readNativeRect(nativeRangeRect, this);
    }
  );

  return {
    getScrollTop: () => scrollTop,
    getWindowScrollCalls: () => windowScrollBySpy.mock.calls,
    resetScrollWrites: () => {
      scrollWrites.length = 0;
      windowScrollBySpy.mockClear();
    },
    restore: () => {
      rangeRectSpy.mockRestore();
      rangeRectsSpy.mockRestore();
      elementRectSpy.mockRestore();
      windowScrollBySpy.mockRestore();
      for (const restore of restores.reverse()) restore();
    },
    scrollWrites
  };
};

const replaceEditorSource = (view: EditorView, nextSource: string): void => {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextSource } });
  });
};

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

const conflictError = (): ApiClientError =>
  new ApiClientError(409, {
    error: { code: "CONFLICT", message: "Version conflict", requestId: REQUEST_ID }
  });

const driveUnavailable = (): ApiClientError =>
  new ApiClientError(503, {
    error: {
      code: "DRIVE_UNAVAILABLE",
      message: "The service is temporarily unavailable.",
      requestId: REQUEST_ID
    }
  });

const openConflict = async (input: {
  readonly store: MemoryDraftStore;
  readonly notes: NotesHarness;
  readonly folderId?: string;
  readonly now?: () => Date;
}): Promise<EditorView> => {
  input.notes.getNote
    .mockResolvedValueOnce(BASE_RESPONSE)
    .mockResolvedValueOnce(LATEST_DRIVE_RESPONSE);
  input.notes.updateNote.mockRejectedValueOnce(conflictError());
  render(
    <EditorWorkspace
      noteId={NOTE_ID}
      hiddenEditor={false}
      hiddenPreview={false}
      draftStore={input.store}
      notes={input.notes.client}
      currentFolderId={input.folderId}
      now={input.now ?? (() => new Date("2026-08-23T09:12:00.000Z"))}
    />
  );
  const view = await getEditorView();
  vi.useFakeTimers();
  replaceEditorSource(view, LOCAL_SOURCE);
  await flushMicrotasks();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await flushMicrotasks();
  vi.useRealTimers();
  expect(await screen.findByRole("dialog", { name: "Version conflict" })).toBeVisible();
  return view;
};

const responseJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("production note request boundary", () => {
  it("uses only same-origin typed GET, PUT, and POST JSON routes", async () => {
    const created = response("# recovered", {
      id: RECOVERED_NOTE_ID,
      title: "Plan Recovered 2026-08-23T12:34:56.789Z",
      version: "1",
      path: "Notes/Plan Recovered 2026-08-23T12:34:56.789Z.md"
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(responseJson(BASE_RESPONSE))
      .mockResolvedValueOnce(responseJson(LOCAL_RESPONSE))
      .mockResolvedValueOnce(responseJson(created, 201));
    vi.stubGlobal("fetch", fetchMock);

    await notesClient.getNote(NOTE_ID);
    await notesClient.updateNote(NOTE_ID, { expectedVersion: "7", source: LOCAL_SOURCE });
    await notesClient.createNote({ title: "Recovered", body: "# recovered", folderId: FOLDER_ID });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [getPath, getInit] = fetchMock.mock.calls[0]!;
    expect(getPath).toBe(`/api/private/notes/${NOTE_ID}`);
    expect(getInit).toMatchObject({ method: "GET", credentials: "same-origin" });
    const [putPath, putInit] = fetchMock.mock.calls[1]!;
    expect(putPath).toBe(`/api/private/notes/${NOTE_ID}`);
    expect(putInit).toMatchObject({ method: "PUT", credentials: "same-origin" });
    expect(new Headers(putInit?.headers).get("accept")).toBe("application/json");
    expect(new Headers(putInit?.headers).get("content-type")).toBe("application/json");
    const putBody = putInit?.body;
    if (typeof putBody !== "string") throw new Error("Expected a serialized PUT body");
    expect(JSON.parse(putBody) as UpdateNoteRequest).toEqual({
      expectedVersion: "7",
      source: LOCAL_SOURCE
    });
    const [postPath, postInit] = fetchMock.mock.calls[2]!;
    expect(postPath).toBe("/api/private/notes");
    expect(postInit).toMatchObject({ method: "POST", credentials: "same-origin" });
    const postBody = postInit?.body;
    if (typeof postBody !== "string") throw new Error("Expected a serialized POST body");
    expect(JSON.parse(postBody) as CreateNoteRequest).toEqual({
      title: "Recovered",
      body: "# recovered",
      folderId: FOLDER_ID
    });
  });

  it("rejects malformed successful note JSON at the shared schema boundary", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(responseJson({ source: "x" })));
    await expect(notesClient.getNote(NOTE_ID)).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe("editor load and durable drafts", () => {
  it("retains the Markdown editor DOM node when editor visibility changes", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const props = {
      noteId: NOTE_ID,
      draftStore: store,
      notes: notes.client,
      hiddenEditor: false,
      hiddenPreview: false
    };
    const view = render(<EditorWorkspace {...props} />);

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    view.rerender(<EditorWorkspace {...props} hiddenEditor hiddenPreview={false} />);

    expect(screen.getByRole("textbox", { name: "Markdown editor", hidden: true })).toBe(editor);
  });

  it("restores a differing local draft without silently replacing it", async () => {
    const store = new MemoryDraftStore();
    await store.put({
      noteId: NOTE_ID,
      source: LOCAL_SOURCE,
      baseVersion: "7",
      path: "Notes/Plan.md",
      localUpdatedAt: "2026-08-23T12:00:00.000Z",
      confirmedAt: null
    });
    const notes = notesHarness();
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );

    const view = await getEditorView();
    expect(view.state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Offline draft");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
  });

  it("clears a same-source draft after the exact Drive load confirms it", async () => {
    const store = new MemoryDraftStore();
    await store.put({
      noteId: NOTE_ID,
      source: BASE_SOURCE,
      baseVersion: "7",
      path: "Notes/Plan.md",
      localUpdatedAt: "2026-08-23T12:00:00.000Z",
      confirmedAt: null
    });
    const notes = notesHarness();
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );

    expect((await getEditorView()).state.doc.toString()).toBe(BASE_SOURCE);
    await waitFor(() => expect(store.drafts.has(NOTE_ID)).toBe(false));
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
  });

  it("restores a durable draft but reports Error for a malformed Drive readback", async () => {
    const store = new MemoryDraftStore();
    await store.put({
      noteId: NOTE_ID,
      source: LOCAL_SOURCE,
      baseVersion: "7",
      path: "Notes/Plan.md",
      localUpdatedAt: "2026-08-23T12:00:00.000Z",
      confirmedAt: null
    });
    const notes = notesHarness({ ...BASE_RESPONSE, checksum: "f".repeat(64) });
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );

    expect((await getEditorView()).state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
  });

  it("uses the production adapter to reconcile a pathless offline draft before an exact confirmed save", async () => {
    const store = new MemoryDraftStore();
    await store.put({
      noteId: NOTE_ID,
      source: LOCAL_SOURCE,
      baseVersion: "7",
      path: null,
      localUpdatedAt: "2026-08-23T12:00:00.000Z",
      confirmedAt: null
    });
    const reconnectedResponse = response("# Newer local", { version: "8" });
    let getAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (input !== `/api/private/notes/${NOTE_ID}`) {
        const requestedPath =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        return Promise.reject(new Error(`Unexpected request: ${requestedPath}`));
      }
      if (init?.method === "GET") {
        getAttempts += 1;
        return getAttempts === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(responseJson(BASE_RESPONSE));
      }
      if (init?.method === "PUT") return Promise.resolve(responseJson(reconnectedResponse));
      return Promise.reject(new Error(`Unexpected method: ${String(init?.method)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
      />
    );

    const view = await getEditorView();
    expect(view.state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Offline draft");
    expect(screen.queryByLabelText(/Active note path:/u)).not.toBeInTheDocument();
    vi.useFakeTimers();
    replaceEditorSource(view, NEWER_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    vi.useRealTimers();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/private/notes/${NOTE_ID}`,
      expect.objectContaining({ method: "GET" })
    );
    const putInit = fetchMock.mock.calls[2]?.[1];
    expect(putInit).toMatchObject({ method: "PUT" });
    if (typeof putInit?.body !== "string") throw new Error("Expected a serialized PUT body");
    expect(JSON.parse(putInit.body) as UpdateNoteRequest).toEqual({
      expectedVersion: "7",
      source: NEWER_SOURCE
    });
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    await waitFor(() => expect(screen.getByLabelText("Active note path: Notes/Plan.md")).toBeVisible());
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("opens the normal conflict after reconnect when Drive advanced beyond a pathless draft", async () => {
    const store = new MemoryDraftStore();
    await store.put({
      noteId: NOTE_ID,
      source: LOCAL_SOURCE,
      baseVersion: "7",
      path: null,
      localUpdatedAt: "2026-08-23T12:00:00.000Z",
      confirmedAt: null
    });
    const notes = notesHarness();
    notes.getNote
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(LATEST_DRIVE_RESPONSE);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, NEWER_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(notes.getNote).toHaveBeenCalledTimes(2);
    expect(notes.updateNote).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect(await screen.findByRole("dialog", { name: "Version conflict" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Drive version" })).toHaveTextContent("Latest Drive");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(NEWER_SOURCE);
  });

  it("reports Error instead of Offline draft when no relevant source is durable", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.getNote.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );

    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Error"));
    expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
  });

  it("waits for the matching durable write after the exact 1000ms debounce", async () => {
    const store = new MemoryDraftStore();
    const write = deferred<void>();
    vi.spyOn(store, "put").mockImplementation((nextDraft) =>
      write.promise.then(() => {
        store.drafts.set(nextDraft.noteId, { ...nextDraft });
      })
    );
    const notes = notesHarness();
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(notes.updateNote).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(notes.updateNote).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");

    write.resolve();
    await flushMicrotasks();
    expect(notes.updateNote).toHaveBeenCalledWith(NOTE_ID, {
      expectedVersion: "7",
      source: LOCAL_SOURCE
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  });

  it("keeps a quota failure as Error and never sends that generation", async () => {
    const store = new MemoryDraftStore();
    vi.spyOn(store, "put").mockRejectedValue(new Error("Quota exceeded"));
    const notes = notesHarness();
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(notes.updateNote).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
  });

  it("does not claim Offline draft until the matching write has succeeded", async () => {
    const store = new MemoryDraftStore();
    const write = deferred<void>();
    vi.spyOn(store, "put").mockImplementation((nextDraft) =>
      write.promise.then(() => {
        store.drafts.set(nextDraft.noteId, { ...nextDraft });
      })
    );
    const notes = notesHarness();
    notes.updateNote.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(notes.updateNote).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");

    write.resolve();
    await flushMicrotasks();
    expect(notes.updateNote).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Offline draft");
  });

  it("fences a stale local-write failure from a newer durable generation", async () => {
    const store = new MemoryDraftStore();
    const first = deferred<void>();
    const second = deferred<void>();
    vi.spyOn(store, "put")
      .mockImplementationOnce((nextDraft) => first.promise.then(() => {
        store.drafts.set(nextDraft.noteId, { ...nextDraft });
      }))
      .mockImplementationOnce((nextDraft) => second.promise.then(() => {
        store.drafts.set(nextDraft.noteId, { ...nextDraft });
      }));
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(NEWER_RESPONSE);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    replaceEditorSource(view, NEWER_SOURCE);
    first.reject(new Error("Old write failed"));
    second.resolve();
    await flushMicrotasks();

    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    expect(notes.updateNote).toHaveBeenCalledWith(NOTE_ID, {
      expectedVersion: "7",
      source: NEWER_SOURCE
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  });

  it("persists every editor change immediately and waits exactly 1000ms before PUT", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const pending = deferred<NoteResponse>();
    notes.updateNote.mockReturnValueOnce(pending.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    expect(notes.updateNote).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(notes.updateNote).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(notes.updateNote).toHaveBeenCalledWith(NOTE_ID, {
      expectedVersion: "7",
      source: LOCAL_SOURCE
    });
    expect(screen.getByLabelText("Save status")).not.toHaveTextContent("Saved");

    pending.resolve(LOCAL_RESPONSE);
    await flushMicrotasks();
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("fences an in-flight response and resaves the latest generation with the advanced version", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const first = deferred<NoteResponse>();
    const second = deferred<NoteResponse>();
    notes.updateNote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, NEWER_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(notes.updateNote).toHaveBeenCalledTimes(1);

    first.resolve(LOCAL_RESPONSE);
    await flushMicrotasks();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(NEWER_SOURCE);
    vi.useRealTimers();
    await waitFor(() => expect(notes.updateNote).toHaveBeenCalledTimes(2));
    expect(notes.updateNote).toHaveBeenLastCalledWith(NOTE_ID, {
      expectedVersion: "8",
      source: NEWER_SOURCE
    });

    second.resolve(NEWER_RESPONSE);
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("adopts the exact canonical same-parent rename response and confirms its submitted draft", async () => {
    const renamedSource = source("# Local", { title: "Renamed" });
    const canonicalSource = source("# Local", { title: "Renamed", aliases: ["Plan"] });
    const canonicalResponse = response("# Local", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Renamed.md"
    });
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(canonicalResponse);
    let latestState: EditorWorkspaceState | undefined;
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
        onStateChange={(state) => {
          latestState = state;
        }}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, renamedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    vi.useRealTimers();

    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(view.state.doc.toString()).toBe(canonicalSource);
    expect(latestState).toMatchObject({
      source: canonicalSource,
      version: "8",
      path: "Notes/Renamed.md",
      status: "Saved"
    });
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("rebases a newer local generation onto the canonical rename without losing its body", async () => {
    const submittedSource = source("# First body", { title: "Renamed" });
    const newerSource = source("# Newer body", { title: "Renamed" });
    const canonicalSubmittedSource = source("# First body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const rebasedNewerSource = source("# Newer body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const first = deferred<NoteResponse>();
    const second = deferred<NoteResponse>();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, submittedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, newerSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(notes.updateNote).toHaveBeenCalledTimes(1);

    first.resolve(response("# First body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Renamed.md"
    }));
    await flushMicrotasks();
    vi.useRealTimers();

    await waitFor(() => expect(notes.updateNote).toHaveBeenCalledTimes(2));
    expect(notes.updateNote).toHaveBeenNthCalledWith(1, NOTE_ID, {
      expectedVersion: "7",
      source: submittedSource
    });
    expect(notes.updateNote).toHaveBeenNthCalledWith(2, NOTE_ID, {
      expectedVersion: "8",
      source: rebasedNewerSource
    });
    expect(view.state.doc.toString()).toBe(rebasedNewerSource);
    expect(view.state.doc.toString()).toContain("# Newer body");
    expect(view.state.doc.toString()).not.toBe(canonicalSubmittedSource);
    expect(store.drafts.get(NOTE_ID)).toMatchObject({
      source: rebasedNewerSource,
      baseVersion: "8",
      path: "Notes/Renamed.md"
    });
    expect(screen.queryByRole("dialog", { name: "Version conflict" })).not.toBeInTheDocument();

    second.resolve(response("# Newer body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "9",
      path: "Notes/Renamed.md"
    }));
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("durably rebases the current generation before resuming a canonical rename save", async () => {
    const submittedSource = source("# First body", { title: "Renamed" });
    const newerSource = source("# Newer body", { title: "Renamed" });
    const thirdSource = source("# Third body", { title: "Renamed" });
    const rebasedNewerSource = source("# Newer body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const rebasedThirdSource = source("# Third body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const firstResponse = deferred<NoteResponse>();
    const secondResponse = deferred<NoteResponse>();
    const firstRebaseWrite = deferred<void>();
    const currentRebaseWrite = deferred<void>();
    const store = new MemoryDraftStore();
    let firstRebaseStarted = false;
    let currentRebaseStarted = false;
    vi.spyOn(store, "put").mockImplementation((draft) => {
      const persist = (): void => {
        store.drafts.set(draft.noteId, { ...draft });
      };
      if (draft.source === rebasedNewerSource && draft.baseVersion === "8") {
        firstRebaseStarted = true;
        return firstRebaseWrite.promise.then(persist);
      }
      if (draft.source === rebasedThirdSource && draft.baseVersion === "8") {
        currentRebaseStarted = true;
        return currentRebaseWrite.promise.then(persist);
      }
      persist();
      return Promise.resolve();
    });
    const notes = notesHarness();
    notes.updateNote
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, submittedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, newerSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    firstResponse.resolve(response("# First body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Renamed.md"
    }));
    await flushMicrotasks();
    vi.useRealTimers();
    await waitFor(() => expect(firstRebaseStarted).toBe(true));
    expect(view.state.doc.toString()).toBe(newerSource);

    vi.useFakeTimers();
    replaceEditorSource(view, thirdSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(notes.updateNote).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    firstRebaseWrite.resolve();
    await flushMicrotasks();
    await waitFor(() => expect(currentRebaseStarted).toBe(true));
    expect(notes.updateNote).toHaveBeenCalledTimes(1);

    currentRebaseWrite.resolve();
    await flushMicrotasks();
    await waitFor(() => expect(notes.updateNote).toHaveBeenCalledTimes(2));
    expect(notes.updateNote).toHaveBeenNthCalledWith(2, NOTE_ID, {
      expectedVersion: "8",
      source: rebasedThirdSource
    });
    expect(store.drafts.get(NOTE_ID)).toMatchObject({
      source: rebasedThirdSource,
      baseVersion: "8",
      path: "Notes/Renamed.md"
    });
    expect(view.state.doc.toString()).toBe(rebasedThirdSource);

    secondResponse.resolve(response("# Third body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "9",
      path: "Notes/Renamed.md"
    }));
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("does not resume a canonical rename save when its rebase draft write fails", async () => {
    const submittedSource = source("# First body", { title: "Renamed" });
    const newerSource = source("# Newer body", { title: "Renamed" });
    const rebasedNewerSource = source("# Newer body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const firstResponse = deferred<NoteResponse>();
    const rebaseWrite = deferred<void>();
    const store = new MemoryDraftStore();
    let rebaseStarted = false;
    vi.spyOn(store, "put").mockImplementation((draft) => {
      if (draft.source === rebasedNewerSource && draft.baseVersion === "8") {
        rebaseStarted = true;
        return rebaseWrite.promise;
      }
      store.drafts.set(draft.noteId, { ...draft });
      return Promise.resolve();
    });
    const notes = notesHarness();
    notes.updateNote.mockReturnValueOnce(firstResponse.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, submittedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, newerSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    firstResponse.resolve(response("# First body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Renamed.md"
    }));
    await flushMicrotasks();
    vi.useRealTimers();
    await waitFor(() => expect(rebaseStarted).toBe(true));

    rebaseWrite.reject(new Error("Draft storage failed"));
    await flushMicrotasks();

    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
    expect(notes.updateNote).toHaveBeenCalledTimes(1);
    expect(store.drafts.get(NOTE_ID)).toMatchObject({
      source: newerSource,
      baseVersion: "7",
      path: "Notes/Plan.md"
    });
  });

  it("does not resume a canonical rename save with a malformed generation typed during rebase", async () => {
    const submittedSource = source("# First body", { title: "Renamed" });
    const newerSource = source("# Newer body", { title: "Renamed" });
    const malformedSource = "---\nid: not-a-valid-note\n---\n\n# Third body\n";
    const rebasedNewerSource = source("# Newer body", {
      title: "Renamed",
      aliases: ["Plan"]
    });
    const firstResponse = deferred<NoteResponse>();
    const rebaseWrite = deferred<void>();
    const store = new MemoryDraftStore();
    let rebaseStarted = false;
    vi.spyOn(store, "put").mockImplementation((draft) => {
      const persist = (): void => {
        store.drafts.set(draft.noteId, { ...draft });
      };
      if (draft.source === rebasedNewerSource && draft.baseVersion === "8") {
        rebaseStarted = true;
        return rebaseWrite.promise.then(persist);
      }
      persist();
      return Promise.resolve();
    });
    const notes = notesHarness();
    notes.updateNote.mockReturnValueOnce(firstResponse.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();

    replaceEditorSource(view, submittedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, newerSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    firstResponse.resolve(response("# First body", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Renamed.md"
    }));
    await flushMicrotasks();
    vi.useRealTimers();
    await waitFor(() => expect(rebaseStarted).toBe(true));

    vi.useFakeTimers();
    replaceEditorSource(view, malformedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    vi.useRealTimers();
    rebaseWrite.resolve();
    await flushMicrotasks();

    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
    expect(notes.updateNote).toHaveBeenCalledTimes(1);
    expect(store.drafts.get(NOTE_ID)?.source).toBe(malformedSource);
  });

  it("does not let a stale network failure relabel or drop a newer queued edit", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const first = deferred<NoteResponse>();
    const second = deferred<NoteResponse>();
    notes.updateNote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    replaceEditorSource(view, NEWER_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(notes.updateNote).toHaveBeenCalledTimes(1);

    first.reject(new TypeError("Failed to fetch"));
    await flushMicrotasks();
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saving");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(NEWER_SOURCE);
    vi.useRealTimers();
    await waitFor(() => expect(notes.updateNote).toHaveBeenCalledTimes(2));
    expect(notes.updateNote).toHaveBeenLastCalledWith(NOTE_ID, {
      expectedVersion: "7",
      source: NEWER_SOURCE
    });

    second.resolve(NEWER_RESPONSE);
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  });

  it.each([
    ["different source", { ...LOCAL_RESPONSE, source: NEWER_SOURCE, checksum: createHash("sha256").update(NEWER_SOURCE).digest("hex") }],
    ["wrong checksum", { ...LOCAL_RESPONSE, checksum: "f".repeat(64) }],
    ["wrong note", { ...LOCAL_RESPONSE, note: { ...LOCAL_RESPONSE.note, frontmatter: { ...LOCAL_RESPONSE.note.frontmatter, id: OTHER_NOTE_ID } } }],
    ["unchanged version", { ...LOCAL_RESPONSE, version: "7" }],
    ["unrelated path", { ...LOCAL_RESPONSE, path: "Archive/Other.md" }]
  ] as const)("keeps the draft and reports Error for an exact readback mismatch: %s", async (_label, mismatch) => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(mismatch);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    vi.useRealTimers();

    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Error"));
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
  });

  it("rejects a renamed-note readback outside the original parent path", async () => {
    const renamedSource = source("# Local", { title: "Renamed" });
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(response("# Local", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Archive/Renamed.md"
    }));
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, renamedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    vi.useRealTimers();

    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Error"));
    expect(store.drafts.get(NOTE_ID)?.source).toBe(renamedSource);
  });

  it("rejects a same-parent rename response that injects an unrelated alias", async () => {
    const renamedSource = source("# Local", { title: "Renamed" });
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(response("# Local", {
      title: "Renamed",
      aliases: ["Plan", "Unrelated"],
      version: "8",
      path: "Notes/Renamed.md"
    }));
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, renamedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(renamedSource);
  });

  it("rejects a canonical rename response with an unrelated same-parent basename", async () => {
    const renamedSource = source("# Local", { title: "Renamed" });
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockResolvedValueOnce(response("# Local", {
      title: "Renamed",
      aliases: ["Plan"],
      version: "8",
      path: "Notes/Other.md"
    }));
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, renamedSource);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(screen.getByLabelText("Save status")).toHaveTextContent("Error");
    expect(store.drafts.get(NOTE_ID)?.source).toBe(renamedSource);
  });

  it.each([
    ["offline network", new TypeError("Failed to fetch")],
    ["Drive unavailable", driveUnavailable()]
  ])("retains local content as Offline draft after %s", async (_label, failure) => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote.mockRejectedValueOnce(failure);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(view.state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Offline draft");
  });

  it("fetches the exact latest Drive source after a typed 409 and retains the local draft", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const view = await openConflict({ store, notes });

    expect(notes.getNote).toHaveBeenNthCalledWith(1, NOTE_ID);
    expect(notes.getNote).toHaveBeenNthCalledWith(2, NOTE_ID);
    const dialog = screen.getByRole("dialog", { name: "Version conflict" });
    const localEditor = within(dialog).getByRole("textbox", { name: "Local draft" });
    const conflictView = EditorView.findFromDOM(localEditor);
    if (conflictView === null) throw new Error("Local conflict editor is unavailable.");
    expect(conflictView.state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(within(dialog).getByRole("region", { name: "Drive version" })).toHaveTextContent("# Latest Drive");
    expect(view.state.doc.toString()).toBe(LOCAL_SOURCE);
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Conflict");
  });

  it("retains the draft and Conflict status when the latest GET after 409 fails", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.getNote.mockResolvedValueOnce(BASE_RESPONSE).mockRejectedValueOnce(driveUnavailable());
    notes.updateNote.mockRejectedValueOnce(conflictError());
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();

    expect(notes.getNote).toHaveBeenCalledTimes(2);
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Conflict");
    expect(screen.queryByRole("dialog", { name: "Version conflict" })).not.toBeInTheDocument();
  });

  it("cancels a pending debounce on unmount", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const mounted = render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    mounted.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(notes.updateNote).not.toHaveBeenCalled();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
  });

  it("cannot let an old note response clear a new note draft after a note switch", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const pending = deferred<NoteResponse>();
    notes.getNote.mockImplementation((noteId) =>
      Promise.resolve(
        noteId === NOTE_ID
          ? BASE_RESPONSE
          : response("# Other Drive", { id: OTHER_NOTE_ID, title: "Other", path: "Notes/Other.md" })
      )
    );
    notes.updateNote.mockReturnValueOnce(pending.promise);
    const mounted = render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    vi.useRealTimers();
    await store.put({
      noteId: OTHER_NOTE_ID,
      source: source("# Other local", { id: OTHER_NOTE_ID, title: "Other" }),
      baseVersion: "7",
      path: "Notes/Other.md",
      localUpdatedAt: "2026-08-23T12:01:00.000Z",
      confirmedAt: null
    });

    mounted.rerender(
      <EditorWorkspace
        noteId={OTHER_NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    pending.resolve(LOCAL_RESPONSE);
    await flushMicrotasks();

    const nextView = await getEditorView();
    expect(nextView.state.doc.toString()).toContain("# Other local");
    expect(store.drafts.get(OTHER_NOTE_ID)?.source).toContain("# Other local");
  });

  it.each(["draft store", "note client"])(
    "catches a synchronously throwing injected %s during initial load",
    async (thrower) => {
      const store = new MemoryDraftStore();
      const notes = notesHarness();
      if (thrower === "draft store") {
        vi.spyOn(store, "get").mockImplementation(() => {
          throw new Error("Synchronous draft failure");
        });
      } else {
        notes.getNote.mockImplementation(() => {
          throw new Error("Synchronous note failure");
        });
      }
      render(
        <EditorWorkspace
          noteId={NOTE_ID}
          hiddenEditor={false}
          hiddenPreview={false}
          draftStore={store}
          notes={notes.client}
        />
      );

      await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Error"));
    }
  );
});

describe("conflict recovery outcomes", () => {
  it("does not display Drive until a named local recovery succeeds, then retries safely", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    store.recoveryFailuresRemaining = 1;
    const notes = notesHarness();
    const view = await openConflict({ store, notes });
    const keep = screen.getByRole("button", { name: "Keep Drive version" });

    await user.click(keep);
    expect(await screen.findByRole("alert")).toHaveTextContent("Recovery storage is unavailable.");
    expect(screen.getByRole("dialog", { name: "Version conflict" })).toBeVisible();
    expect(view.state.doc.toString()).toBe(LOCAL_SOURCE);
    await user.click(keep);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version conflict" })).not.toBeInTheDocument());
    expect(view.state.doc.toString()).toBe(LATEST_DRIVE_SOURCE);
    expect(store.drafts.has(NOTE_ID)).toBe(false);
    expect(store.recoveries).toEqual([
      expect.objectContaining({
        name: "Local draft 2026-08-23T09:12:00.000Z",
        source: LOCAL_SOURCE,
        baseVersion: "7",
        localUpdatedAt: "2026-08-23T09:12:00.000Z"
      })
    ]);
  });

  it("preserves a recovery and explains the missing injected folder without pretending success", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    await openConflict({ store, notes });

    await user.click(screen.getByRole("button", { name: "Save local as a new note" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Select a folder before recovering this note.");
    expect(screen.getByRole("dialog", { name: "Version conflict" })).toBeVisible();
    expect(notes.createNote).not.toHaveBeenCalled();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    expect(store.recoveries.at(-1)?.source).toBe(LOCAL_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save local as a new note" }));
    expect(store.recoveries).toHaveLength(1);
  });

  it("uses the canonical UTC recovered-title suffix and clears only after exact create readback", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const recoveredTitle = "Plan Recovered 2026-08-23T12:34:56.789Z";
    const recoveredPath = "Notes/Plan Recovered 2026 - 08 - 23T12 - 34 - 56.789Z.md";
    const created = response(LOCAL_SOURCE, {
      id: RECOVERED_NOTE_ID,
      title: recoveredTitle,
      version: "1",
      path: recoveredPath
    });
    notes.createNote
      .mockResolvedValueOnce({ ...created, note: { ...created.note, body: "wrong\n" } })
      .mockResolvedValueOnce(created);
    const view = await openConflict({
      store,
      notes,
      folderId: FOLDER_ID,
      now: () => new Date("2026-08-23T15:34:56.789+03:00")
    });
    const saveNew = screen.getByRole("button", { name: "Save local as a new note" });

    await user.click(saveNew);
    expect(await screen.findByRole("alert")).toHaveTextContent("The recovered note did not match the local draft.");
    expect(screen.getByRole("dialog", { name: "Version conflict" })).toBeVisible();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(LOCAL_SOURCE);
    await user.click(saveNew);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version conflict" })).not.toBeInTheDocument());
    expect(notes.createNote).toHaveBeenNthCalledWith(1, {
      title: recoveredTitle,
      body: LOCAL_SOURCE,
      folderId: FOLDER_ID
    });
    expect(notes.createNote).toHaveBeenNthCalledWith(2, {
      title: recoveredTitle,
      body: LOCAL_SOURCE,
      folderId: FOLDER_ID
    });
    expect(view.state.doc.toString()).toBe(LATEST_DRIVE_SOURCE);
    expect(store.drafts.has(NOTE_ID)).toBe(false);
  });

  it("keeps an editable merged draft through failure and retries PUT against the latest version", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.updateNote
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(MERGED_RESPONSE);
    notes.getNote
      .mockResolvedValueOnce(BASE_RESPONSE)
      .mockResolvedValueOnce(LATEST_DRIVE_RESPONSE);
    render(
      <EditorWorkspace
        noteId={NOTE_ID}
        hiddenEditor={false}
        hiddenPreview={false}
        draftStore={store}
        notes={notes.client}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    vi.useRealTimers();
    const mergeEditor = await screen.findByRole("textbox", { name: "Local draft" });
    const mergeView = EditorView.findFromDOM(mergeEditor);
    if (mergeView === null) throw new Error("Local conflict editor is unavailable.");
    replaceEditorSource(mergeView, MERGED_SOURCE);
    await flushMicrotasks();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(MERGED_SOURCE);
    const merge = screen.getByRole("button", { name: "Merge versions" });

    await user.click(merge);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to fetch");
    expect(screen.getByRole("dialog", { name: "Version conflict" })).toBeVisible();
    expect(store.drafts.get(NOTE_ID)?.source).toBe(MERGED_SOURCE);
    await user.click(merge);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version conflict" })).not.toBeInTheDocument());
    expect(notes.updateNote).toHaveBeenNthCalledWith(2, NOTE_ID, {
      expectedVersion: "8",
      source: MERGED_SOURCE
    });
    expect(notes.updateNote).toHaveBeenNthCalledWith(3, NOTE_ID, {
      expectedVersion: "8",
      source: MERGED_SOURCE
    });
    expect(view.state.doc.toString()).toBe(MERGED_SOURCE);
    expect(store.drafts.has(NOTE_ID)).toBe(false);
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
  });
});

describe("safe Markdown preview", () => {
  it.each([
    { name: "<done>.png", inlineImage: true },
    { name: "mail <user@example.com>.pdf", inlineImage: false },
    { name: `punct !"#$%&'()*+,-.:;<=>?@[]^_\`{|}~.txt`, inlineImage: false },
    { name: "Café [世界] <δοκιμή> #?.pdf", inlineImage: false }
  ])("renders the exact portable attachment label without nested Markdown for $name", async ({ name, inlineImage }) => {
    const markdown = createPortableAttachmentMarkdown({
      notePath: "Notes/Inbox/Plan.md",
      noteId: NOTE_ID,
      name,
      inlineImage
    });
    const expected = name.normalize("NFC");
    const { container } = render(
      <MarkdownPreview
        source={markdown}
        notePath="Notes/Inbox/Plan.md"
        resolveAttachment={() => ATTACHMENT_ID}
      />
    );

    const renderedAttachment = inlineImage
      ? await screen.findByRole("img", { name: expected })
      : await screen.findByRole("link", { name: expected });
    expect(renderedAttachment).toHaveAttribute(
      inlineImage ? "src" : "href",
      `/api/private/attachments/${ATTACHMENT_ID}`
    );
    expect(renderedAttachment.textContent).toBe(inlineImage ? "" : expected);
    expect(container.querySelectorAll("a")).toHaveLength(inlineImage ? 0 : 1);
    expect(container.querySelectorAll("[href], [src]")).toHaveLength(1);
    expect(container.querySelector("[href^='mailto:'], script, iframe, object, svg, done")).toBeNull();
  });

  it("sanitizes active content and resolves only canonical application attachments", async () => {
    const resolver = vi.fn((reference: string) =>
      reference === `_assets/${NOTE_ID}/diagram.png` ? ATTACHMENT_ID : "https://attacker.example/raw"
    );
    render(
      <MarkdownPreview
        source={`# Preview\n\n<script>window.__nxtExecuted = true</script>\n\n![diagram](../_assets/${NOTE_ID}/diagram.png)\n![external](https://attacker.example/track.png)`}
        notePath="Notes/Plan.md"
        resolveAttachment={resolver}
      />
    );

    expect(await screen.findByRole("heading", { name: "Preview" })).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("img", { name: "diagram" })).toHaveAttribute(
      "src",
      `/api/private/attachments/${ATTACHMENT_ID}`
    );
    expect(screen.getByRole("img", { name: "external" })).not.toHaveAttribute("src");
    expect(document.body.innerHTML).not.toContain("attacker.example");
    expect(resolver).toHaveBeenCalledWith(`_assets/${NOTE_ID}/diagram.png`);
  });

  it("navigates resolved wiki links only through the injected note callback and leaves other links inert", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <MarkdownPreview
        source="[[Plan|Open plan]] [[Missing]] [[Tie]] [[Unsafe]]"
        notePath="Notes/Plan.md"
        resolveWikiLink={(target) => {
          if (target === "Plan") return { kind: "resolved", noteId: OTHER_NOTE_ID };
          if (target === "Tie") return { kind: "ambiguous", candidateIds: [NOTE_ID, OTHER_NOTE_ID] };
          if (target === "Unsafe") return { kind: "resolved", noteId: "javascript:alert(1)" };
          return { kind: "unresolved" };
        }}
        onWikiNavigate={onNavigate}
      />
    );

    const resolved = await screen.findByRole("button", { name: "Open plan" });
    await user.click(resolved);
    expect(onNavigate).toHaveBeenCalledWith(OTHER_NOTE_ID);
    for (const label of ["Missing", "Tie", "Unsafe"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
      expect(screen.getByText(label)).toHaveAttribute("aria-disabled", "true");
    }
  });
});

describe("CodeMirror production configuration", () => {
  it("uses Markdown parsing, line wrapping, bracket matching, history, and keyboard editing without executing code", async () => {
    const onChange = vi.fn();
    const editorSource = "# Heading\n\n(pair)\n\n```html\n<script>window.__nxtExecuted = true</script>\n```\n";
    render(<MarkdownEditor value={editorSource} onChange={onChange} />);
    const view = await getEditorView();

    expect(view.state.doc.toString()).toBe(editorSource);
    const cursor = syntaxTree(view.state).cursor();
    const syntaxNames: string[] = [];
    do syntaxNames.push(cursor.name); while (cursor.next());
    expect(syntaxNames).toEqual(expect.arrayContaining([expect.stringMatching(/ATXHeading1|HeaderMark/u), "FencedCode"]));
    expect(document.querySelector(".cm-lineWrapping")).not.toBeNull();
    const pairOffset = editorSource.indexOf("(") + 1;
    act(() => view.dispatch({ selection: { anchor: pairOffset } }));
    await waitFor(() => expect(document.querySelector(".cm-matchingBracket")).not.toBeNull());

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "edited" } }));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(editorSource);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${editorSource}edited`);
    expect((globalThis as typeof globalThis & { __nxtExecuted?: boolean }).__nxtExecuted).not.toBe(true);
  });

  it("blocks an over-contract editor transaction before it reaches drafts or callbacks", async () => {
    const onChange = vi.fn();
    const onLimitExceeded = vi.fn();
    render(
      <MarkdownEditor
        value={BASE_SOURCE}
        onChange={onChange}
        onLimitExceeded={onLimitExceeded}
      />
    );
    const view = await getEditorView();

    replaceEditorSource(view, "x".repeat(MAX_NOTE_SOURCE_BYTES + 1));

    expect(view.state.doc.toString()).toBe(BASE_SOURCE);
    expect(onChange).not.toHaveBeenCalled();
    expect(onLimitExceeded).toHaveBeenCalledTimes(1);
  });

  it("keeps the native scrollDOM authoritative with a leading mobile path in a long document", async () => {
    const geometry = installCodeMirrorGeometryHarness(600);
    const editorSource = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n");
    const leadingContent = (
      <div className="mobile-content-path" data-testid="editor-leading-path">Notes/Long.md</div>
    );
    const editorElement = (content?: React.ReactNode): React.JSX.Element => (
      <StrictMode>
        <MarkdownEditor value={editorSource} onChange={vi.fn()} leadingContent={content} />
      </StrictMode>
    );
    try {
      const rendered = render(editorElement(leadingContent));
      const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
      const view = EditorView.findFromDOM(editor);
      if (view === null) throw new Error("CodeMirror view is unavailable.");
      const scrollDOM = view.scrollDOM;
      const leadingPath = screen.getByTestId("editor-leading-path");

      expect(editor.closest(".cm-scroller")).toBe(scrollDOM);
      expect(scrollDOM).toHaveClass("workspace-scroll-target");
      expect(scrollDOM).toContainElement(leadingPath);
      expect(scrollDOM.firstElementChild).toHaveClass("markdown-editor-leading-slot");
      expect(scrollDOM.firstElementChild?.firstElementChild).toBe(leadingPath);
      expect(getComputedStyle(scrollDOM).overflow).toBe("auto");
      await waitFor(() => expect(view.defaultLineHeight).toBe(20));

      const targetOffset = view.state.doc.line(550).from;
      expect(view.viewport.to).toBeLessThan(targetOffset);
      expect(view.visibleRanges.some(({ from, to }) => from <= targetOffset && to >= targetOffset)).toBe(false);
      act(() => {
        scrollDOM.scrollTop = 320;
        fireEvent.scroll(scrollDOM);
      });
      expect(geometry.getScrollTop()).toBe(320);
      geometry.resetScrollWrites();

      act(() => {
        view.dispatch({
          selection: { anchor: targetOffset },
          effects: EditorView.scrollIntoView(targetOffset, { y: "center" })
        });
      });

      await waitFor(() => expect(geometry.getScrollTop()).toBeGreaterThan(320));
      expect(geometry.scrollWrites.at(-1)).toBe(geometry.getScrollTop());
      expect(geometry.getWindowScrollCalls().every(([, vertical]) => vertical === 0)).toBe(true);
      expect(view.scrollDOM).toBe(scrollDOM);
      expect(view.state.doc.toString()).toBe(editorSource);
      expect(view.state.selection.main.head).toBe(targetOffset);
      expect(view.viewport.from).toBeLessThanOrEqual(targetOffset);
      expect(view.viewport.to).toBeGreaterThanOrEqual(targetOffset);
      expect(view.visibleRanges.some(({ from, to }) => from <= targetOffset && to >= targetOffset)).toBe(true);
      const targetRect = view.coordsAtPos(targetOffset);
      expect(targetRect).not.toBeNull();
      expect(targetRect?.top).toBeGreaterThanOrEqual(scrollDOM.getBoundingClientRect().top);
      expect(targetRect?.bottom).toBeLessThanOrEqual(scrollDOM.getBoundingClientRect().bottom);

      rendered.rerender(editorElement());
      expect(view.scrollDOM).toBe(scrollDOM);
      expect(scrollDOM).not.toHaveClass("workspace-scroll-target");
      expect(screen.queryByTestId("editor-leading-path")).not.toBeInTheDocument();

      rendered.rerender(editorElement(leadingContent));
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBe(editor);
      expect(view.scrollDOM).toBe(scrollDOM);
      expect(scrollDOM.firstElementChild?.firstElementChild).toBe(screen.getByTestId("editor-leading-path"));

      const leadingSlot = scrollDOM.firstElementChild;
      rendered.unmount();
      expect(leadingSlot?.isConnected).toBe(false);
    } finally {
      cleanup();
      geometry.restore();
    }
  });
});

describe("owner-shell integration", () => {
  it("places the live note breadcrumb inside the mobile editor and preview scroll containers", async () => {
    const viewport = stubMutableViewport(390);
    const user = userEvent.setup();
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notesHarness().client}
        draftStore={new MemoryDraftStore()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    const editorView = EditorView.findFromDOM(editor);
    if (editorView === null) throw new Error("CodeMirror view is unavailable.");
    const editorScroll = editorView.scrollDOM;
    const editorCanvas = editor.closest(".editor-canvas");
    await waitFor(() => expect(within(editorScroll).getByLabelText(
      "Active note path: Notes/Plan.md"
    )).toBeVisible());
    expect(editorScroll).toHaveClass("workspace-scroll-target");
    expect(editorScroll.firstElementChild).toHaveClass("markdown-editor-leading-slot");
    expect(editorScroll.firstElementChild?.firstElementChild).toHaveClass("mobile-content-path");

    viewport.setWidth(1024);
    expect(editorScroll).not.toHaveClass("workspace-scroll-target");
    expect(within(editorScroll).queryByLabelText("Active note path: Notes/Plan.md")).not.toBeInTheDocument();
    viewport.setWidth(390);
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBe(editor);
    expect(editor.closest(".editor-canvas")).toBe(editorCanvas);
    expect(editorView.scrollDOM).toBe(editorScroll);
    expect(editorScroll.firstElementChild?.firstElementChild).toHaveClass("mobile-content-path");

    await user.click(within(screen.getByRole("navigation", { name: "Mobile destinations" })).getByRole(
      "button",
      { name: "Preview" }
    ));
    const preview = screen.getByRole("region", { name: "Preview" });
    const previewScroll = preview.querySelector(".preview-content");
    expect(previewScroll).toHaveClass("workspace-scroll-target");
    expect(previewScroll?.firstElementChild).toHaveClass("mobile-content-path");
    expect(within(preview).getByLabelText("Active note path: Notes/Plan.md")).toBeVisible();
  });

  it("preserves the active note and Markdown editor DOM node across workspace layout changes", async () => {
    const viewport = stubMutableViewport(1200);
    const user = userEvent.setup();
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notesHarness().client}
        draftStore={new MemoryDraftStore()}
      />
    );

    const ownerShell = screen.getByTestId("owner-shell");
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });

    expect(ownerShell).toHaveAttribute("data-layout", "desktop");
    viewport.setWidth(1024);
    await user.click(screen.getByRole("button", { name: "Info" }));
    expect(ownerShell).toHaveAttribute("data-mobile-destination", "info");
    viewport.setWidth(390);

    expect(screen.getByTestId("owner-shell")).toBe(ownerShell);
    expect(ownerShell).toHaveAttribute("data-layout", "mobile");
    expect(ownerShell).toHaveAttribute("data-mobile-destination", "info");
    expect(ownerShell.querySelector(".mobile-title")).toHaveTextContent("Plan");
    expect(screen.getByRole("textbox", { name: "Markdown editor", hidden: true })).toBe(editor);
  });

  it("turns an empty vault into an editable first note from the visible editor action", async () => {
    const user = userEvent.setup();
    const created = response("", {
      id: RECOVERED_NOTE_ID,
      title: "First note",
      version: "1",
      path: "Notes/Plans/First note.md"
    });
    const createdEntry = {
      ...OWNER_VAULT.entries[0]!,
      id: RECOVERED_NOTE_ID,
      title: "First note",
      path: created.path,
      driveVersion: created.version,
      tags: [],
      searchText: "first note",
      excerpt: "",
      outboundNoteIds: [],
      unresolvedWikiTargets: [],
      attachments: [],
      backlinks: []
    };
    const emptyVault: CompleteVault = {
      ...OWNER_VAULT,
      entries: [],
      folders: [
        ...OWNER_VAULT.folders,
        { id: PLANS_FOLDER_ID, name: "Plans", path: "Notes/Plans", version: "2", protected: true }
      ],
      preferences: { ...OWNER_VAULT.preferences, favorites: [], recent: [] }
    };
    const populatedVault: CompleteVault = {
      ...emptyVault,
      entries: [createdEntry],
      preferences: { ...emptyVault.preferences, recent: [RECOVERED_NOTE_ID] }
    };
    const notes = notesHarness(created);
    notes.createNote.mockResolvedValueOnce(created);

    const Harness = (): React.JSX.Element => {
      const [noteId, setNoteId] = useState<string>();
      const [vault, setVault] = useState(emptyVault);
      return (
        <OwnerShell
          {...(noteId === undefined ? {} : { noteId })}
          vault={vault}
          notes={notes.client}
          draftStore={new MemoryDraftStore()}
          onRefreshVault={() => {
            setVault(populatedVault);
            return Promise.resolve();
          }}
          onNavigateNote={setNoteId}
        />
      );
    };

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Create first note" }));
    const dialog = screen.getByRole("dialog", { name: "New note" });
    expect(within(dialog).getByRole("combobox", { name: "Folder" })).toHaveValue(PLANS_FOLDER_ID);
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "First note");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(EditorView.findFromDOM(editor)?.state.doc.toString()).toBe(created.source);
  });

  it("reports zero referenced attachments when persisted assets are absent from the saved source", async () => {
    const user = userEvent.setup();
    const notes = notesHarness(response("# Drive"));
    const publicationApi = { getStatus: vi.fn().mockResolvedValue(null), publish: vi.fn(), revoke: vi.fn() };

    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={new MemoryDraftStore()}
        publicationApi={publicationApi}
      />
    );

    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(screen.getByRole("dialog", { name: "Publish note" })).toHaveTextContent(
      "0 referenced attachments"
    );
  });

  it("counts each selected-note attachment once across duplicate canonical and opaque references", async () => {
    const user = userEvent.setup();
    const secondAssetId = `v1.${"e".repeat(16)}.asset_second.${"f".repeat(22)}`;
    const thirdAssetId = `v1.${"g".repeat(16)}.asset_third.${"h".repeat(22)}`;
    const attachments = [
      OWNER_VAULT.entries[0]!.attachments[0]!,
      { assetId: secondAssetId, name: "second.pdf", mimeType: "application/pdf", size: 84, disposition: "download" as const },
      { assetId: thirdAssetId, name: "unreferenced.txt", mimeType: "text/plain", size: 21, disposition: "download" as const }
    ];
    const vault: CompleteVault = {
      ...OWNER_VAULT,
      entries: [{ ...OWNER_VAULT.entries[0]!, attachments }, OWNER_VAULT.entries[1]!]
    };
    const notes = notesHarness(response(
      `# Drive\n\n![diagram](../_assets/${NOTE_ID}/diagram.png)\n\n![duplicate](<../_assets/${NOTE_ID}/diagram.png>)\n\n[opaque](/api/private/attachments/${secondAssetId})`
    ));
    const publicationApi = { getStatus: vi.fn().mockResolvedValue(null), publish: vi.fn(), revoke: vi.fn() };

    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={vault}
        notes={notes.client}
        draftStore={new MemoryDraftStore()}
        publicationApi={publicationApi}
      />
    );

    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(screen.getByRole("dialog", { name: "Publish note" })).toHaveTextContent(
      "2 referenced attachments"
    );
  });

  it("keeps publish disabled until the current note has authoritative saved state", async () => {
    const pending = deferred<NoteResponse>();
    const notes = notesHarness();
    notes.getNote.mockReturnValueOnce(pending.promise);
    const publicationApi = { getStatus: vi.fn().mockResolvedValue(null), publish: vi.fn(), revoke: vi.fn() };

    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={new MemoryDraftStore()}
        publicationApi={publicationApi}
      />
    );

    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute("title", "Select a saved note first.");

    pending.resolve(BASE_RESPONSE);
    await act(async () => { await pending.promise; });
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    expect(publish).toBeEnabled();
  });

  it.each([
    [1505, "editor"],
    [390, "info"]
  ] as const)("redirects publication details only outside desktop at %ipx", async (width, destination) => {
    stubMutableViewport(width);
    const user = userEvent.setup();
    const notes = notesHarness();
    const publicationApi = {
      getStatus: vi.fn().mockResolvedValue(null),
      publish: vi.fn().mockResolvedValue({
        publicId: "A".repeat(22),
        publishedAt: "2026-08-29T12:00:00.000Z",
        sourceVersion: "7",
        attachmentCount: 1
      }),
      revoke: vi.fn()
    };
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={new MemoryDraftStore()}
        publicationApi={publicationApi}
      />
    );

    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);
    await user.click(screen.getByRole("button", { name: "Publish snapshot" }));
    await waitFor(() => expect(screen.getByTestId("owner-shell")).toHaveAttribute(
      "data-mobile-destination",
      destination
    ));
  });

  it("inserts the persisted server name as a portable nested reference used by preview and fences", async () => {
    const user = userEvent.setup();
    const name = "Café [draft] #1? report).png";
    const assetId = `v1.${"c".repeat(16)}.asset_weird.${"d".repeat(22)}`;
    const asset = {
      assetId,
      name,
      mimeType: "image/png",
      size: 4,
      disposition: "inline" as const
    };
    const nestedResponse = response("# Drive", { path: "Notes/Inbox/Plan.md" });
    const nestedEntry = { ...OWNER_VAULT.entries[0]!, path: nestedResponse.path, attachments: [] };
    const initialVault = { ...OWNER_VAULT, entries: [nestedEntry, OWNER_VAULT.entries[1]!] };
    const refreshedVault = {
      ...initialVault,
      entries: [{ ...nestedEntry, attachments: [asset] }, OWNER_VAULT.entries[1]!]
    };
    const notes = notesHarness(nestedResponse);
    const store = new MemoryDraftStore();
    const upload = vi.fn<AttachmentClient["upload"]>().mockResolvedValue({ asset });
    const attachmentApi: AttachmentClient = { upload, trash: vi.fn() };
    const publicationApi = { getStatus: vi.fn().mockResolvedValue(null), publish: vi.fn(), revoke: vi.fn() };
    const onRefreshVault = vi.fn(() => Promise.resolve());

    const Harness = (): React.JSX.Element => {
      const [vault, setVault] = useState(initialVault);
      return (
        <OwnerShell
          noteId={NOTE_ID}
          vault={vault}
          notes={notes.client}
          draftStore={store}
          attachmentApi={attachmentApi}
          publicationApi={publicationApi}
          onRefreshVault={() => {
            void onRefreshVault();
            setVault(refreshedVault);
            return Promise.resolve();
          }}
        />
      );
    };

    render(<Harness />);
    const view = await getEditorView();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled());
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "client name.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(() => Promise.resolve(Uint8Array.of(1, 2, 3, 4).buffer))
    });
    await user.upload(screen.getByLabelText("Add attachment"), file);

    const markdown = `![Café \\[draft\\] \\#1\\? report\\)\\.png](<../../_assets/${NOTE_ID}/Caf%C3%A9%20%5Bdraft%5D%20%231%3F%20report%29.png>)`;
    await waitFor(() => expect(view.state.doc.toString()).toContain(markdown));
    expect(onRefreshVault).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(await within(preview).findByRole("img", { name })).toHaveAttribute(
      "src",
      `/api/private/attachments/${assetId}`
    );
    const projection = attachmentReferenceProjection(view.state.doc.toString(), nestedResponse.path);
    expect(projection).toEqual([`_assets/${NOTE_ID}/${name}`]);
    expect(attachmentIsReferenced({ source: view.state.doc.toString(), notePath: nestedResponse.path, noteId: NOTE_ID, name, opaqueId: assetId })).toBe(true);
    expect(projectionReferencesAttachment(projection, { noteId: NOTE_ID, name, opaqueId: assetId })).toBe(true);
  });

  it("mounts the real editor with actual title, path, preview, and save state", async () => {
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    render(<OwnerShell noteId={NOTE_ID} notes={notes.client} draftStore={store} />);

    expect((await getEditorView()).state.doc.toString()).toBe(BASE_SOURCE);
    const paths = screen.getAllByLabelText("Active note path: Notes/Plan.md");
    expect(paths).toHaveLength(2);
    expect(paths.filter((path) => path.matches(".workspace-header-center .desktop-header-path"))).toHaveLength(1);
    expect(paths.filter((path) => path.matches(".editor-region .desktop-path"))).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("region", { name: "Preview" })).toHaveTextContent("Drive"));
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  });

  it("injects the complete vault tree, canonical attachment, and exact wiki navigation", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const linked = response(
      `# Drive\n\n[[Other|Open other]]\n\n![diagram](../_assets/${NOTE_ID}/diagram.png)`
    );
    const notes = notesHarness(linked);
    const onNavigateNote = vi.fn();

    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={store}
        onNavigateNote={onNavigateNote}
      />
    );

    expect(await screen.findByRole("tree", { name: "Files" })).toBeVisible();
    expect(await screen.findByRole("searchbox", { name: "Search files" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "diagram" })).toHaveAttribute(
      "src",
      `/api/private/attachments/${ATTACHMENT_ID}`
    );
    await user.click(screen.getByRole("button", { name: "Open other" }));
    expect(onNavigateNote).toHaveBeenCalledWith(OTHER_NOTE_ID);

    const preview = screen.getByRole("region", { name: "Preview" });
    await user.click(within(preview).getByRole("tab", { name: "Outline" }));
    expect(within(preview).getByRole("navigation", { name: "Outline" })).toHaveTextContent("Drive");
    await user.click(within(preview).getByRole("tab", { name: "Backlinks" }));
    expect(within(preview).getAllByLabelText("Other, Resolved")[0]).toBeVisible();
    expect(within(preview).getByLabelText("Missing, Unresolved")).toHaveAttribute("aria-disabled", "true");
  });

  it("scrolls the exact rendered heading ID instead of a positional heading match", async () => {
    const user = userEvent.setup();
    const notes = notesHarness(response("# Repeat\n\n> # Nested quote\n\n# Repeat"));
    const scrolledIds: string[] = [];
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn(function (this: HTMLElement) {
      scrolledIds.push(this.id);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      render(
        <OwnerShell
          noteId={NOTE_ID}
          vault={OWNER_VAULT}
          notes={notes.client}
          draftStore={new MemoryDraftStore()}
        />
      );
      const preview = screen.getByRole("region", { name: "Preview" });
      await waitFor(() => expect(preview.querySelector("#nxt-heading-repeat-2")).not.toBeNull());

      await user.click(within(preview).getByRole("tab", { name: "Outline" }));
      await user.click(within(preview).getAllByRole("button", { name: "Repeat" })[1]!);

      await waitFor(() => expect(scrolledIds).toEqual(["nxt-heading-repeat-2"]));
    } finally {
      if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    }
  });

  it("derives the recovery destination from the selected note's exact opaque parent", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    notes.getNote.mockResolvedValueOnce(BASE_RESPONSE).mockResolvedValueOnce(LATEST_DRIVE_RESPONSE);
    notes.updateNote.mockRejectedValueOnce(conflictError());
    const recoveredTitle = "Plan Recovered 2026-08-23T12:34:56.789Z";
    notes.createNote.mockResolvedValueOnce(response(LOCAL_SOURCE, {
      id: RECOVERED_NOTE_ID,
      title: recoveredTitle,
      version: "1",
      path: "Notes/Plan Recovered.md"
    }));
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={store}
        now={() => new Date("2026-08-23T15:34:56.789+03:00")}
      />
    );
    const view = await getEditorView();
    vi.useFakeTimers();
    replaceEditorSource(view, LOCAL_SOURCE);
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushMicrotasks();
    vi.useRealTimers();

    await user.click(await screen.findByRole("button", { name: "Save local as a new note" }));
    expect(notes.createNote).toHaveBeenCalledWith({
      title: recoveredTitle,
      body: LOCAL_SOURCE,
      folderId: FOLDER_ID
    });
  });

  it("creates and moves a note keyboard-only through real command handlers and restores focus", async () => {
    const user = userEvent.setup();
    const store = new MemoryDraftStore();
    const notes = notesHarness();
    const created = response("", {
      id: RECOVERED_NOTE_ID,
      title: "New idea",
      version: "1",
      path: "Notes/New idea.md"
    });
    notes.createNote.mockResolvedValueOnce(created);
    notes.moveNote.mockResolvedValueOnce({ ...BASE_RESPONSE, path: "Notes/Inbox/Plan.md", version: "8" });
    const vaultApi: VaultClient = {
      loadCompleteVault: vi.fn(() => Promise.resolve(OWNER_VAULT)),
      createFolder: vi.fn(),
      updateFolder: vi.fn(),
      trashFolder: vi.fn(),
      updatePreferences: vi.fn(() => Promise.resolve(OWNER_VAULT.preferences)),
      rescanVault: vi.fn(() => Promise.resolve([]))
    };
    const onNavigateNote = vi.fn();
    const onRefreshVault = vi.fn(() => Promise.resolve());
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={OWNER_VAULT}
        notes={notes.client}
        draftStore={store}
        vaultApi={vaultApi}
        onNavigateNote={onNavigateNote}
        onRefreshVault={onRefreshVault}
      />
    );
    await getEditorView();
    const origin = screen.getByRole("button", { name: "Add attachment" });
    origin.focus();

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("textbox", { name: "Search commands" }), "New note{Enter}");
    const newNoteDialog = await screen.findByRole("dialog", { name: "New note" });
    await user.type(within(newNoteDialog).getByRole("textbox", { name: "Title" }), "New idea{Enter}");
    await waitFor(() => expect(notes.createNote).toHaveBeenCalledWith({
      title: "New idea",
      body: "",
      folderId: FOLDER_ID
    }));
    expect(onNavigateNote).toHaveBeenCalledWith(RECOVERED_NOTE_ID);

    origin.focus();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("textbox", { name: "Search commands" }), "Move{Enter}");
    const moveDialog = await screen.findByRole("dialog", { name: "Move note" });
    const destination = within(moveDialog).getByRole("combobox", { name: "Destination" });
    destination.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(within(moveDialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(notes.moveNote).toHaveBeenCalledWith(NOTE_ID, {
      expectedVersion: "7",
      folderId: INBOX_FOLDER_ID
    }));

    origin.focus();
    await user.keyboard("{Control>}k{/Control}{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(onRefreshVault).toHaveBeenCalledTimes(2);
  });

  it("refreshes the vault after a stale folder confirmation conflict", async () => {
    const user = userEvent.setup();
    const customFolder = {
      id: "v1.abcdefghijklmnop.folder_3.abcdefghijklmnopqrstuv",
      name: "Plans",
      path: "Notes/Plans",
      version: "3",
      protected: false,
      deleteConfirmation: {
        descendantCount: 0,
        treeVersion: "a".repeat(64),
        expiresAt: "2026-08-25T12:05:00.000Z",
        confirmationToken: `c1.${"b".repeat(120)}.${"c".repeat(43)}`
      }
    } as const;
    const stale = conflictError();
    const trashFolder = vi.fn(() => Promise.reject(stale));
    const vaultApi: VaultClient = {
      loadCompleteVault: vi.fn(() => Promise.resolve(OWNER_VAULT)),
      createFolder: vi.fn(),
      updateFolder: vi.fn(),
      trashFolder,
      updatePreferences: vi.fn(() => Promise.resolve(OWNER_VAULT.preferences)),
      rescanVault: vi.fn(() => Promise.resolve([]))
    };
    const onRefreshVault = vi.fn(() => Promise.resolve());
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={{ ...OWNER_VAULT, folders: [...OWNER_VAULT.folders, customFolder] }}
        notes={notesHarness().client}
        draftStore={new MemoryDraftStore()}
        vaultApi={vaultApi}
        onRefreshVault={onRefreshVault}
        now={() => new Date("2026-08-25T12:04:00.000Z")}
      />
    );
    await user.click(screen.getByRole("button", { name: "Plans actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    await user.click(within(screen.getByRole("dialog", { name: "Move Plans to Trash" })).getByRole("button", { name: "Move to Trash" }));

    await waitFor(() => expect(onRefreshVault).toHaveBeenCalledOnce());
    expect(trashFolder).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("confirmation is stale");
  });

  it("reaches the selected production note through the exact deep owner route", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/private/session") {
        return Promise.resolve(responseJson({ user: { userDetails: "owner" } }));
      }
      if (input === "/api/private/vault?limit=100") {
        return Promise.resolve(responseJson({
          ...OWNER_VAULT,
          preferencesChecksum: "f".repeat(64),
          cursor: null,
          complete: true
        }));
      }
      if (input === `/api/private/notes/${NOTE_ID}`) return Promise.resolve(responseJson(BASE_RESPONSE));
      const requestedPath = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      return Promise.reject(new Error(`Unexpected request: ${requestedPath}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(appRoutes, { initialEntries: [`/app/notes/${NOTE_ID}`] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    );

    expect((await getEditorView()).state.doc.toString()).toBe(BASE_SOURCE);
    expect(router.state.location.pathname).toBe(`/app/notes/${NOTE_ID}`);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private/vault?limit=100",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/private/notes/${NOTE_ID}`,
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
  });

  it("renders controlled Not Found for an invalid note deep link without calling clients", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("No client call expected"));
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(appRoutes, { initialEntries: ["/app/notes/not-a-note-id"] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    );

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
