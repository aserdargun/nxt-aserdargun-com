import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computeSlashMenuSnapshot, emptySlashMenuSnapshot } from "../editor/slash-menu-extension";

const makeState = (doc: string, anchor: number): EditorState => EditorState.create({ doc, selection: { anchor } });

const host = (() => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  return div;
})();

const mountView = (state: EditorState): EditorView => new EditorView({ state, parent: host });

describe("computeSlashMenuSnapshot", () => {
  it("is closed for an empty document", () => {
    expect(computeSlashMenuSnapshot(makeState("", 0))).toEqual(emptySlashMenuSnapshot());
  });

  it("is closed when the cursor is not at line start", () => {
    const state = makeState("hello", 5);
    expect(computeSlashMenuSnapshot(state).open).toBe(false);
  });

  it("opens when / is the first character of a line", () => {
    const state = makeState("/", 1);
    const snapshot = computeSlashMenuSnapshot(state);
    expect(snapshot.open).toBe(true);
    expect(snapshot.triggerFrom).toBe(0);
    expect(snapshot.triggerTo).toBe(1);
    expect(snapshot.filter).toBe("");
  });

  it("captures the filter text after the / trigger", () => {
    const state = makeState("/he", 3);
    const snapshot = computeSlashMenuSnapshot(state);
    expect(snapshot.open).toBe(true);
    expect(snapshot.filter).toBe("he");
    expect(snapshot.triggerFrom).toBe(0);
    expect(snapshot.triggerTo).toBe(3);
  });

  it("stays closed for a fraction like 1/2", () => {
    const state = makeState("1/2", 3);
    expect(computeSlashMenuSnapshot(state).open).toBe(false);
  });

  it("stays closed for whitespace-prefixed slash on a non-first line", () => {
    const state = makeState("paragraph\n /x", 12);
    expect(computeSlashMenuSnapshot(state).open).toBe(false);
  });

  it("opens for a slash at the start of a later line", () => {
    const state = makeState("paragraph\n/he", 13);
    const snapshot = computeSlashMenuSnapshot(state);
    expect(snapshot.open).toBe(true);
    expect(snapshot.triggerFrom).toBe(10);
    expect(snapshot.filter).toBe("he");
  });

  it("rejects non-word filter characters (so //foo closes the menu)", () => {
    const state = makeState("/!", 2);
    expect(computeSlashMenuSnapshot(state).open).toBe(false);
  });

  it("rejects non-empty selection", () => {
    const state = EditorState.create({ doc: "/", selection: { anchor: 0, head: 1 } });
    expect(computeSlashMenuSnapshot(state).open).toBe(false);
  });

  it("is exposed via a mounted editor view's state field", () => {
    const view = mountView(makeState("/h", 2));
    expect(view).toBeDefined();
    view.destroy();
  });
});
