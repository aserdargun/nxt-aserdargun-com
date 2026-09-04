import CodeMirror, {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type Extension
} from "@uiw/react-codemirror";
import { useMemo } from "react";
import type { ConflictDiffLine } from "./conflict-diff";

export interface ConflictSourceEditorProps {
  readonly value: string;
  readonly lines: readonly ConflictDiffLine[];
  readonly label: string;
  readonly summaryId: string;
  readonly readOnly: boolean;
  readonly onChange?: ((source: string) => void) | undefined;
}

type ChangedLineKind = "addition" | "removal";

class ConflictDiffMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(
    private readonly kind: ChangedLineKind | "spacer"
  ) {
    super();
    this.elementClass = kind === "spacer" ? "conflict-diff-marker-spacer" : `conflict-diff-marker-${kind}`;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ConflictDiffMarker && other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "conflict-diff-marker";
    marker.setAttribute("aria-hidden", "true");
    if (this.kind === "spacer") {
      marker.textContent = " ";
      return marker;
    }
    marker.dataset.diffMarker = this.kind;
    marker.textContent = this.kind === "addition" ? "+" : "−";
    return marker;
  }
}

const additionMarker = new ConflictDiffMarker("addition");
const removalMarker = new ConflictDiffMarker("removal");
const spacerMarker = new ConflictDiffMarker("spacer");

const conflictEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--bg)"
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
    fontSize: "13px",
    lineHeight: "1.6"
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "12px 0"
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    borderRight: "1px solid var(--separator)",
    color: "var(--text-muted-strong)",
    backgroundColor: "var(--surface)"
  },
  ".conflict-diff-gutter .cm-gutterElement": {
    minWidth: "28px",
    padding: "0 7px",
    textAlign: "center"
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--yellow)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important"
  },
  "&.cm-focused": { outline: "none" }
});

const changedLineExtensions = (
  lines: readonly ConflictDiffLine[],
  label: string,
  summaryId: string,
  readOnly: boolean
): Extension[] => {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const markers = new Map<number, GutterMarker>();
  let offset = 0;

  lines.forEach(({ kind, text }, index) => {
    if (kind !== "unchanged") {
      decorations.push(Decoration.line({
        attributes: {
          class: `conflict-diff-line conflict-diff-line-${kind}`,
          "data-diff-state": kind
        }
      }).range(offset));
      markers.set(offset, kind === "addition" ? additionMarker : removalMarker);
    }
    offset += text.length + (index < lines.length - 1 ? 1 : 0);
  });

  return [
    EditorView.lineWrapping,
    conflictEditorTheme,
    EditorView.decorations.of(Decoration.set(decorations)),
    gutter({
      class: "conflict-diff-gutter",
      renderEmptyElements: true,
      initialSpacer: () => spacerMarker,
      lineMarker: (_view, block) => markers.get(block.from) ?? null
    }),
    EditorView.contentAttributes.of({
      "aria-label": label,
      "aria-describedby": summaryId,
      "aria-multiline": "true",
      "aria-readonly": readOnly ? "true" : "false",
      spellcheck: "false",
      tabindex: "0"
    })
  ];
};

const ignoreChange = (): void => {};

export const ConflictSourceEditor = ({
  value,
  lines,
  label,
  summaryId,
  readOnly,
  onChange = ignoreChange
}: ConflictSourceEditorProps): React.JSX.Element => {
  const extensions = useMemo(
    () => changedLineExtensions(lines, label, summaryId, readOnly),
    [label, lines, readOnly, summaryId]
  );

  return (
    <CodeMirror
      className="conflict-source"
      value={value}
      height="100%"
      minHeight="100%"
      theme={conflictEditorTheme}
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        highlightActiveLineGutter: false,
        highlightSpecialChars: true,
        history: true,
        foldGutter: false,
        drawSelection: true,
        dropCursor: true,
        allowMultipleSelections: false,
        indentOnInput: true,
        syntaxHighlighting: false,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        rectangularSelection: false,
        crosshairCursor: false,
        highlightActiveLine: false,
        highlightSelectionMatches: false,
        closeBracketsKeymap: true,
        defaultKeymap: true,
        searchKeymap: true,
        historyKeymap: true,
        foldKeymap: false,
        completionKeymap: false,
        lintKeymap: false
      }}
      indentWithTab
      readOnly={readOnly}
      editable={!readOnly}
      onChange={onChange}
    />
  );
};
