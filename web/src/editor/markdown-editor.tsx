import * as React from "react";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { MAX_NOTE_SOURCE_BYTES } from "@nxt/contracts";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import CodeMirror, { EditorState, EditorView, type Extension } from "@uiw/react-codemirror";
import { createSlashMenu, type SlashMenuController, type SlashMenuItem } from "./slash-menu-extension";

export interface MarkdownEditorHandle {
  readonly wrapSelection: (before: string, after?: string, placeholder?: string) => void;
  readonly prefixLine: (prefix: string) => void;
  readonly insertAtCursor: (text: string) => void;
  readonly getView: () => EditorView | null;
  readonly getSlashMenu: () => SlashMenuController | null;
}

export interface MarkdownEditorProps {
  readonly value: string;
  readonly onChange: (source: string) => void;
  readonly onLimitExceeded?: () => void;
  readonly readOnly?: boolean;
  readonly onViewReady?: ((view: EditorView) => void) | undefined;
  readonly slashMenuItems?: readonly SlashMenuItem[] | undefined;
}

const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--text)",
      backgroundColor: "var(--bg)"
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
      fontSize: "15px",
      lineHeight: "1.62"
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "18px 0 32px",
      caretColor: "var(--yellow)"
    },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": {
      borderRight: "1px solid var(--border)",
      color: "var(--muted)",
      backgroundColor: "var(--bg)"
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "52px",
      padding: "0 13px 0 8px"
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--selection)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection) !important"
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--yellow)" },
    ".cm-matchingBracket": {
      color: "var(--green)",
      backgroundColor: "var(--selection)",
      outline: "1px solid var(--yellow)"
    },
    "&.cm-focused": { outline: "none" }
  },
  { dark: true }
);

const gruvboxHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--yellow)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--blue)" },
  { tag: [tags.keyword, tags.operator], color: "var(--orange)" },
  { tag: [tags.string, tags.bool], color: "var(--green)" },
  { tag: [tags.comment, tags.meta], color: "var(--muted)" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "700" },
  { tag: tags.invalid, color: "var(--red)" }
]);

const fixedExtensions: readonly Extension[] = [
  markdown(),
  EditorView.lineWrapping,
  editorTheme,
  syntaxHighlighting(gruvboxHighlight),
  EditorView.contentAttributes.of({
    "aria-label": "Markdown editor",
    "aria-multiline": "true",
    spellcheck: "true"
  })
];

const MarkdownEditorInner = (
  { value, onChange, onLimitExceeded, readOnly = false, onViewReady, slashMenuItems }: MarkdownEditorProps,
  ref: React.ForwardedRef<MarkdownEditorHandle>
): React.JSX.Element => {
  if (utf8Size(value) > MAX_NOTE_SOURCE_BYTES) {
    throw new RangeError("Markdown source exceeds the shared note limit.");
  }

  const viewRef = useRef<EditorView | null>(null);
  const slashControllerRef = useRef<SlashMenuController | null>(null);

  useImperativeHandle(ref, () => ({
    wrapSelection: (before, after = before, placeholder = "") => {
      const view = viewRef.current;
      if (view === null) return;
      const { from, to, empty } = view.state.selection.main;
      const insert = empty ? `${before}${placeholder}${after}` : `${before}${view.state.sliceDoc(from, to)}${after}`;
      const cursorStart = from + before.length;
      const cursorEnd = empty ? cursorStart + placeholder.length : cursorStart + (to - from);
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: cursorStart, head: cursorEnd },
        userEvent: "input.format"
      });
      view.focus();
    },
    prefixLine: (prefix) => {
      const view = viewRef.current;
      if (view === null) return;
      const { from, to } = view.state.selection.main;
      const startLine = view.state.doc.lineAt(from);
      const endLine = view.state.doc.lineAt(to);
      const changes: { from: number; to: number; insert: string }[] = [];
      for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        changes.push({ from: line.from, to: line.from, insert: prefix });
      }
      view.dispatch({ changes, userEvent: "input.format" });
      view.focus();
    },
    insertAtCursor: (text) => {
      const view = viewRef.current;
      if (view === null) return;
      const { from } = view.state.selection.main;
      view.dispatch({
        changes: { from, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.format"
      });
      view.focus();
    },
    getView: () => viewRef.current,
    getSlashMenu: () => slashControllerRef.current
  }), []);

  const slashBundle = useMemo(() => {
    if (slashMenuItems === undefined) return null;
    return createSlashMenu(slashMenuItems);
  }, [slashMenuItems]);

  const extensions = useMemo<Extension[]>(
    () => [
      ...fixedExtensions,
      EditorState.transactionFilter.of((transaction) => {
        if (!transaction.docChanged || utf8Size(transaction.newDoc.toString()) <= MAX_NOTE_SOURCE_BYTES) {
          return transaction;
        }
        onLimitExceeded?.();
        return [];
      }),
      ...(slashBundle === null ? [] : [slashBundle.extension])
    ],
    [onLimitExceeded, slashBundle]
  );

  return (
    <CodeMirror
      className="markdown-editor"
      value={value}
      height="100%"
      minHeight="100%"
      theme={editorTheme}
      extensions={extensions}
      onCreateEditor={(view) => {
        viewRef.current = view;
        slashControllerRef.current = slashBundle?.controller ?? null;
        onViewReady?.(view);
      }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightSpecialChars: true,
        history: true,
        foldGutter: false,
        drawSelection: true,
        dropCursor: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        syntaxHighlighting: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        rectangularSelection: true,
        crosshairCursor: true,
        highlightActiveLine: true,
        highlightSelectionMatches: true,
        closeBracketsKeymap: true,
        defaultKeymap: true,
        searchKeymap: true,
        historyKeymap: true,
        foldKeymap: true,
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

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(MarkdownEditorInner);
MarkdownEditor.displayName = "MarkdownEditor";
