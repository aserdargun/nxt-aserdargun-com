import { EditorState, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";

export interface SlashMenuItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly keywords: readonly string[];
  readonly insert: (view: EditorView) => void;
}

export interface SlashMenuSnapshot {
  readonly open: boolean;
  readonly triggerFrom: number;
  readonly triggerTo: number;
  readonly filter: string;
  readonly cursorFrom: number;
  readonly cursorTo: number;
}

export const emptySlashMenuSnapshot = (): SlashMenuSnapshot => ({
  open: false,
  triggerFrom: 0,
  triggerTo: 0,
  filter: "",
  cursorFrom: 0,
  cursorTo: 0
});

/**
 * The slash menu is open when the user types `/` at the start of a line and
 * the characters immediately after are word-like (so prose like "1/2" still
 * keeps the menu closed). The trigger range is `[lineStart, cursor]` and the
 * `filter` is the substring between the `/` and the cursor.
 */
export const computeSlashMenuSnapshot = (state: EditorState): SlashMenuSnapshot => {
  const sel = state.selection.main;
  if (!sel.empty) return emptySlashMenuSnapshot();
  const from = sel.from;
  if (state.doc.length === 0) return emptySlashMenuSnapshot();
  const line = state.doc.lineAt(from);
  const before = state.doc.sliceString(line.from, from);
  if (before.length === 0 || before[0] !== "/") return emptySlashMenuSnapshot();
  if (!/^[\p{L}\p{N}_-]*$/u.test(before.slice(1))) return emptySlashMenuSnapshot();
  return {
    open: true,
    triggerFrom: line.from,
    triggerTo: from,
    filter: before.slice(1),
    cursorFrom: from,
    cursorTo: sel.to
  };
};

const slashMenuState = StateField.define<SlashMenuSnapshot>({
  create: () => emptySlashMenuSnapshot(),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection) return computeSlashMenuSnapshot(tr.state);
    return value;
  }
});

const triggerMark = Decoration.mark({ class: "cm-slash-trigger" });

const buildDecorations = (snapshot: SlashMenuSnapshot): DecorationSet => {
  if (!snapshot.open) return Decoration.none;
  if (snapshot.triggerFrom >= snapshot.triggerTo) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  builder.add(snapshot.triggerFrom, snapshot.triggerTo, triggerMark);
  return builder.finish();
};

const matchItems = (items: readonly SlashMenuItem[], snapshot: SlashMenuSnapshot): SlashMenuItem[] => {
  const filter = snapshot.filter.toLocaleLowerCase("en-US");
  if (filter.length === 0) return [...items];
  return items.filter((item) => {
    if (item.label.toLocaleLowerCase("en-US").includes(filter)) return true;
    return item.keywords.some((keyword) => keyword.toLocaleLowerCase("en-US").includes(filter));
  });
};

export const closeSlashMenu = (view: EditorView): boolean => {
  const snapshot = view.state.field(slashMenuState);
  if (!snapshot.open) return false;
  if (snapshot.triggerFrom < snapshot.triggerTo) {
    view.dispatch({
      changes: { from: snapshot.triggerFrom, to: snapshot.triggerTo },
      selection: { anchor: snapshot.triggerFrom },
      userEvent: "input.slash.close"
    });
  }
  return true;
};

export const acceptSlashMenu = (view: EditorView, item: SlashMenuItem): boolean => {
  const snapshot = view.state.field(slashMenuState);
  if (!snapshot.open) return false;
  view.dispatch({
    changes: { from: snapshot.triggerFrom, to: snapshot.cursorFrom, insert: "" },
    selection: { anchor: snapshot.triggerFrom },
    userEvent: "input.slash.accept"
  });
  item.insert(view);
  return true;
};

/**
 * Builds the CodeMirror extension bundle that drives the slash menu. The
 * returned `controller` exposes the imperative API the React overlay needs.
 */
export const createSlashMenu = (items: readonly SlashMenuItem[]): { readonly extension: Extension; readonly controller: SlashMenuController } => {
  let viewRef: EditorView | null = null;

  const capture = ViewPlugin.fromClass(class {
    public constructor(view: EditorView) {
      viewRef = view;
    }
    public destroy(): void {
      if (viewRef !== null) viewRef = null;
    }
  });

  const decorations = ViewPlugin.fromClass(class {
    public decorations: DecorationSet;
    public constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state.field(slashMenuState));
    }
    public update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.state.field(slashMenuState));
      }
    }
  }, { decorations: (plugin) => plugin.decorations });

  const extension: Extension = [
    slashMenuState,
    capture,
    decorations,
    keymap.of([
      { key: "Escape", run: closeSlashMenu },
      {
        key: "Enter",
        run: (view) => {
          const snapshot = view.state.field(slashMenuState);
          if (!snapshot.open) return false;
          const matches = matchItems(items, snapshot);
          const first = matches[0];
          if (first === undefined) {
            closeSlashMenu(view);
            return true;
          }
          return acceptSlashMenu(view, first);
        }
      }
    ])
  ];

  const controller: SlashMenuController = {
    getSnapshot: () => viewRef === null ? emptySlashMenuSnapshot() : viewRef.state.field(slashMenuState),
    getView: () => viewRef,
    match: (snapshot) => matchItems(items, snapshot),
    close: () => {
      if (viewRef !== null) closeSlashMenu(viewRef);
    },
    accept: (item) => {
      if (viewRef !== null) acceptSlashMenu(viewRef, item);
    }
  };

  return { extension, controller };
};

export interface SlashMenuController {
  readonly getSnapshot: () => SlashMenuSnapshot;
  readonly getView: () => EditorView | null;
  readonly match: (snapshot: SlashMenuSnapshot) => SlashMenuItem[];
  readonly close: () => void;
  readonly accept: (item: SlashMenuItem) => void;
}

/** Returns the screen-coordinate rectangle of the cursor for the floating menu. */
export const computeSlashMenuAnchor = (view: EditorView, snapshot: SlashMenuSnapshot): { readonly left: number; readonly top: number; readonly bottom: number } | null => {
  if (!snapshot.open) return null;
  try {
    const coords = view.coordsAtPos(snapshot.cursorFrom);
    if (coords === null) return null;
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch {
    return null;
  }
};
