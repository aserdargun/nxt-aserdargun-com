import { MAX_NOTE_SOURCE_BYTES, NoteResponseSchema, type NoteResponse } from "@nxt/contracts";
import { parseNote } from "@nxt/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import type { NotesClient } from "../api/notes";
import type { ConflictResolution, EditorConflict } from "./conflict-dialog";
import type { DraftStore, LocalDraft } from "./draft-store";

export type SaveStatus = "Saving" | "Saved" | "Offline draft" | "Conflict" | "Error";

export interface EditorSessionState {
  readonly source: string | null;
  readonly title: string;
  readonly path: string;
  readonly status: SaveStatus;
  readonly conflict: EditorConflict | null;
  readonly conflictBusy: boolean;
  readonly conflictError: string | null;
}

interface UseAutosaveInput {
  readonly noteId: string;
  readonly notes: NotesClient;
  readonly drafts: DraftStore;
  readonly currentFolderId?: string | undefined;
  readonly now: () => Date;
}

interface AutosaveRuntime {
  active: boolean;
  readonly noteId: string;
  source: string | null;
  title: string;
  path: string;
  baseVersion: string;
  generation: number;
  localUpdatedAt: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  queued: boolean;
  conflict: EditorConflict | null;
  recoveredTitleTimestamp: string | null;
  change: (source: string) => void;
  changeMerge: (source: string) => void;
  resolve: (resolution: ConflictResolution) => void;
  setConflictOpen: (open: boolean) => void;
}

const INITIAL_STATE: EditorSessionState = {
  source: null,
  title: "",
  path: "",
  status: "Saving",
  conflict: null,
  conflictBusy: false,
  conflictError: null
};

const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const documentsEqual = (left: NoteResponse["note"], right: NoteResponse["note"]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

class ReadbackError extends Error {
  public constructor(message = "The saved note readback did not match the submitted source.") {
    super(message);
    this.name = "ReadbackError";
  }
}

const verifyResponse = async (response: unknown, noteId?: string): Promise<NoteResponse> => {
  const parsed = NoteResponseSchema.safeParse(response);
  if (!parsed.success) throw new ReadbackError("The application received an invalid note readback.");
  const value = parsed.data;
  let sourceNote: NoteResponse["note"];
  try {
    sourceNote = parseNote(value.source);
  } catch {
    throw new ReadbackError();
  }
  if (
    !documentsEqual(sourceNote, value.note) ||
    (noteId !== undefined && value.note.frontmatter.id !== noteId) ||
    value.checksum !== await sha256(value.source) ||
    !value.path.endsWith(".md") ||
    value.path.includes("\u0000")
  ) {
    throw new ReadbackError();
  }
  return value;
};

const verifyUpdateResponse = async (input: {
  readonly response: unknown;
  readonly noteId: string;
  readonly source: string;
  readonly expectedVersion: string;
  readonly expectedPath: string;
}): Promise<NoteResponse> => {
  const response = await verifyResponse(input.response, input.noteId);
  if (
    response.source !== input.source ||
    response.version === input.expectedVersion ||
    response.path !== input.expectedPath
  ) {
    throw new ReadbackError();
  }
  return response;
};

const canonicalBody = (value: string): string =>
  `\n${value.replace(/^\r?\n+/u, "").replace(/\r\n/gu, "\n").replace(/\n*$/u, "")}\n`;

const portableMarkdownFileName = (title: string): string => {
  const withoutMarkdown = title.normalize("NFKC").trim().replace(/\.md$/iu, "");
  const sanitized = [...withoutMarkdown]
    .map((character) => {
      const code = character.codePointAt(0) as number;
      return code <= 31 || code === 127 ? " - " : character;
    })
    .join("")
    .replace(/[\\/:*?"<>|]/gu, " - ")
    .replace(/\s+/gu, " ")
    .replace(/(?:\s*-\s*)+/gu, " - ")
    .replace(/[. ]+$/gu, "")
    .trim();
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") throw new ReadbackError();
  return `${sanitized}.md`;
};

const verifyCreateResponse = async (input: {
  readonly response: unknown;
  readonly title: string;
  readonly body: string;
}): Promise<NoteResponse> => {
  let response: NoteResponse;
  try {
    response = await verifyResponse(input.response);
  } catch {
    throw new ReadbackError("The recovered note did not match the local draft.");
  }
  if (
    response.note.frontmatter.title !== input.title ||
    response.note.body !== canonicalBody(input.body) ||
    !response.path.endsWith(`/${portableMarkdownFileName(input.title)}`)
  ) {
    throw new ReadbackError("The recovered note did not match the local draft.");
  }
  return response;
};

const recoveredTitle = (title: string, timestamp: string): string => {
  const suffix = ` Recovered ${timestamp}`;
  const available = Math.max(1, 160 - suffix.length);
  const base = title.slice(0, available).trimEnd() || title.slice(0, available);
  return `${base}${suffix}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The operation could not be completed.";

const isOfflineFailure = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof ApiClientError && error.code === "DRIVE_UNAVAILABLE");

const draftMetadata = (draft: LocalDraft): { readonly title: string; readonly path: string } => {
  try {
    const note = parseNote(draft.source);
    return { title: note.frontmatter.title, path: `${note.frontmatter.title}.md` };
  } catch {
    return { title: "", path: "" };
  }
};

export const useAutosave = ({
  noteId,
  notes,
  drafts,
  currentFolderId,
  now
}: UseAutosaveInput): {
  readonly state: EditorSessionState;
  readonly onSourceChange: (source: string) => void;
  readonly onMergeSourceChange: (source: string) => void;
  readonly onResolveConflict: (resolution: ConflictResolution) => void;
  readonly onConflictOpenChange: (open: boolean) => void;
  readonly onLimitExceeded: () => void;
} => {
  const [state, setState] = useState<EditorSessionState>(INITIAL_STATE);
  const runtimeRef = useRef<AutosaveRuntime | null>(null);
  const currentFolderIdRef = useRef(currentFolderId);

  useEffect(() => {
    currentFolderIdRef.current = currentFolderId;
  }, [currentFolderId]);

  useEffect(() => {
    const session: AutosaveRuntime = {
      active: true,
      noteId,
      source: null,
      title: "",
      path: "",
      baseVersion: "",
      generation: 0,
      localUpdatedAt: now().toISOString(),
      timer: null,
      inFlight: false,
      queued: false,
      conflict: null,
      recoveredTitleTimestamp: null,
      change: () => {},
      changeMerge: () => {},
      resolve: () => {},
      setConflictOpen: () => {}
    };
    runtimeRef.current = session;
    setState(INITIAL_STATE);

    const publish = (patch: Partial<EditorSessionState>): void => {
      if (!session.active) return;
      setState((current) => ({ ...current, ...patch }));
    };

    const clearTimer = (): void => {
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
    };

    const applyResponse = (response: NoteResponse, status: SaveStatus): void => {
      session.source = response.source;
      session.title = response.note.frontmatter.title;
      session.path = response.path;
      session.baseVersion = response.version;
      publish({
        source: response.source,
        title: session.title,
        path: session.path,
        status,
        conflict: session.conflict
      });
    };

    const showConflict = async (localSource: string): Promise<void> => {
      clearTimer();
      session.queued = false;
      publish({ status: "Conflict", conflictError: null });
      try {
        const latest = await verifyResponse(await notes.getNote(noteId), noteId);
        if (!session.active) return;
        session.conflict = {
          noteId,
          title: latest.note.frontmatter.title,
          localSource,
          localUpdatedAt: session.localUpdatedAt,
          drive: latest
        };
        session.recoveredTitleTimestamp = null;
        publish({ status: "Conflict", conflict: session.conflict, conflictError: null });
      } catch {
        if (session.active) publish({ status: "Conflict", conflict: null });
      }
    };

    const startSave = async (): Promise<void> => {
      if (!session.active || session.source === null || session.conflict !== null) return;
      if (session.inFlight) {
        session.queued = true;
        return;
      }
      session.inFlight = true;
      session.queued = false;
      const submittedSource = session.source;
      const submittedGeneration = session.generation;
      const expectedVersion = session.baseVersion;
      const expectedPath = session.path;
      let resumeQueued = false;
      try {
        const response = await verifyUpdateResponse({
          response: await notes.updateNote(noteId, {
            expectedVersion,
            source: submittedSource
          }),
          noteId,
          source: submittedSource,
          expectedVersion,
          expectedPath
        });
        if (!session.active) return;
        session.baseVersion = response.version;
        session.path = response.path;
        session.title = response.note.frontmatter.title;
        await drafts.markConfirmed({ noteId, source: submittedSource });
        if (!session.active) return;
        if (session.generation === submittedGeneration && session.source === submittedSource) {
          applyResponse(response, "Saved");
        } else {
          publish({ status: "Saving", title: session.title, path: session.path });
          resumeQueued = session.queued;
        }
      } catch (error) {
        if (!session.active) return;
        clearTimer();
        session.queued = false;
        if (error instanceof ApiClientError && error.status === 409 && error.code === "CONFLICT") {
          await showConflict(session.source ?? submittedSource);
        } else {
          publish({ status: isOfflineFailure(error) ? "Offline draft" : "Error" });
        }
      } finally {
        session.inFlight = false;
        if (session.active && resumeQueued && session.conflict === null) void startSave();
      }
    };

    const scheduleSave = (): void => {
      clearTimer();
      session.timer = setTimeout(() => {
        session.timer = null;
        if (session.inFlight) {
          session.queued = true;
          return;
        }
        void startSave();
      }, 1000);
    };

    session.change = (nextSource) => {
      if (!session.active || session.source === null || session.conflict !== null) return;
      session.source = nextSource;
      session.generation += 1;
      session.localUpdatedAt = now().toISOString();
      try {
        const parsed = parseNote(nextSource);
        session.title = parsed.frontmatter.title;
      } catch {
        // Invalid in-progress Markdown stays recoverable and will fail closed at readback.
      }
      const draft: LocalDraft = {
        noteId,
        source: nextSource,
        baseVersion: session.baseVersion,
        localUpdatedAt: session.localUpdatedAt,
        confirmedAt: null
      };
      void drafts.put(draft).catch(() => publish({ status: "Error" }));
      publish({ source: nextSource, title: session.title, status: "Saving", conflictError: null });
      scheduleSave();
    };

    session.changeMerge = (nextSource) => {
      if (!session.active || session.conflict === null) return;
      if (utf8Size(nextSource) > MAX_NOTE_SOURCE_BYTES) {
        publish({ status: "Error", conflictError: "The local draft is too large." });
        return;
      }
      session.generation += 1;
      session.source = nextSource;
      session.localUpdatedAt = now().toISOString();
      session.conflict = {
        ...session.conflict,
        localSource: nextSource,
        localUpdatedAt: session.localUpdatedAt
      };
      void drafts.put({
        noteId,
        source: nextSource,
        baseVersion: session.conflict.drive.version,
        localUpdatedAt: session.localUpdatedAt,
        confirmedAt: null
      }).catch(() => publish({ status: "Error", conflictError: "The local draft could not be stored." }));
      publish({
        source: nextSource,
        status: "Conflict",
        conflict: session.conflict,
        conflictError: null
      });
    };

    const preserve = async (conflict: EditorConflict, removeMatchingDraft: boolean): Promise<void> => {
      await drafts.preserveRecovery({
        noteId,
        name: `Local draft ${conflict.localUpdatedAt}`,
        source: conflict.localSource,
        baseVersion: conflict.drive.version,
        recoveredAt: now().toISOString(),
        removeMatchingDraft
      });
    };

    session.resolve = (resolution) => {
      const conflict = session.conflict;
      if (!session.active || conflict === null) return;
      publish({ conflictBusy: true, conflictError: null });
      void (async () => {
        try {
          if (resolution === "keep-drive") {
            await preserve(conflict, true);
            if (!session.active) return;
            session.conflict = null;
            applyResponse(conflict.drive, "Saved");
            publish({ conflict: null, conflictBusy: false, conflictError: null });
            return;
          }

          if (resolution === "save-new") {
            const recoveryFolderId = currentFolderIdRef.current;
            if (recoveryFolderId === undefined) {
              await preserve(conflict, false);
              if (session.active) {
                publish({
                  status: "Conflict",
                  conflictBusy: false,
                  conflictError: "Select a folder before recovering this note."
                });
              }
              return;
            }
            session.recoveredTitleTimestamp ??= now().toISOString();
            const title = recoveredTitle(conflict.title, session.recoveredTitleTimestamp);
            await verifyCreateResponse({
              response: await notes.createNote({
                title,
                body: conflict.localSource,
                folderId: recoveryFolderId
              }),
              title,
              body: conflict.localSource
            });
            if (!session.active) return;
            await drafts.markConfirmed({ noteId, source: conflict.localSource });
            if (!session.active) return;
            session.conflict = null;
            applyResponse(conflict.drive, "Saved");
            publish({ conflict: null, conflictBusy: false, conflictError: null });
            return;
          }

          const merged = conflict.localSource;
          let response: NoteResponse;
          try {
            response = await verifyUpdateResponse({
              response: await notes.updateNote(noteId, {
                expectedVersion: conflict.drive.version,
                source: merged
              }),
              noteId,
              source: merged,
              expectedVersion: conflict.drive.version,
              expectedPath: conflict.drive.path
            });
          } catch (error) {
            if (error instanceof ApiClientError && error.status === 409 && error.code === "CONFLICT") {
              const latest = await verifyResponse(await notes.getNote(noteId), noteId);
              if (!session.active) return;
              session.conflict = { ...conflict, localSource: merged, drive: latest };
              publish({
                status: "Conflict",
                conflict: session.conflict,
                conflictBusy: false,
                conflictError: null
              });
              return;
            }
            throw error;
          }
          if (!session.active) return;
          await drafts.markConfirmed({ noteId, source: merged });
          if (!session.active) return;
          session.conflict = null;
          applyResponse(response, "Saved");
          publish({ conflict: null, conflictBusy: false, conflictError: null });
        } catch (error) {
          if (session.active) {
            publish({
              status: "Conflict",
              conflictBusy: false,
              conflictError: errorMessage(error)
            });
          }
        }
      })();
    };

    session.setConflictOpen = (open) => {
      if (!session.active || open || session.conflict === null) return;
      session.conflict = null;
      publish({ conflict: null, conflictBusy: false, conflictError: null, status: "Conflict" });
    };

    void (async () => {
      const [draftResult, driveResult] = await Promise.allSettled([
        drafts.get(noteId),
        notes.getNote(noteId).then((response) => verifyResponse(response, noteId))
      ]);

      if (draftResult.status === "rejected") {
        publish({ status: "Error" });
        return;
      }
      const draft = draftResult.value;

      if (driveResult.status === "rejected") {
        if (!session.active) return;
        if (draft !== null) {
          const metadata = draftMetadata(draft);
          session.source = draft.source;
          session.baseVersion = draft.baseVersion;
          session.title = metadata.title;
          session.path = metadata.path;
          session.localUpdatedAt = draft.localUpdatedAt;
          publish({
            source: draft.source,
            title: metadata.title,
            path: metadata.path,
            status: isOfflineFailure(driveResult.reason) ? "Offline draft" : "Error"
          });
        } else {
          publish({ status: isOfflineFailure(driveResult.reason) ? "Offline draft" : "Error" });
        }
        return;
      }
      if (!session.active) return;
      const drive = driveResult.value;

      session.title = drive.note.frontmatter.title;
      session.path = drive.path;
      if (draft === null || draft.source === drive.source) {
        session.source = drive.source;
        session.baseVersion = drive.version;
        if (draft !== null) {
          try {
            await drafts.markConfirmed({ noteId, source: drive.source });
          } catch {
            publish({ status: "Error" });
            return;
          }
        }
        if (!session.active) return;
        applyResponse(drive, "Saved");
      } else {
        session.source = draft.source;
        session.baseVersion = draft.baseVersion;
        session.localUpdatedAt = draft.localUpdatedAt;
        publish({
          source: draft.source,
          title: drive.note.frontmatter.title,
          path: drive.path,
          status: "Offline draft"
        });
      }
    })();

    return () => {
      session.active = false;
      clearTimer();
      if (runtimeRef.current === session) runtimeRef.current = null;
    };
  }, [drafts, noteId, notes, now]);

  const onSourceChange = useCallback((source: string) => runtimeRef.current?.change(source), []);
  const onMergeSourceChange = useCallback((source: string) => runtimeRef.current?.changeMerge(source), []);
  const onResolveConflict = useCallback(
    (resolution: ConflictResolution) => runtimeRef.current?.resolve(resolution),
    []
  );
  const onConflictOpenChange = useCallback(
    (open: boolean) => runtimeRef.current?.setConflictOpen(open),
    []
  );
  const onLimitExceeded = useCallback(() => {
    setState((current) => ({ ...current, status: "Error" }));
  }, []);

  return {
    state,
    onSourceChange,
    onMergeSourceChange,
    onResolveConflict,
    onConflictOpenChange,
    onLimitExceeded
  };
};
