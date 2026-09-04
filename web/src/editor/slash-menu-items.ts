import type { EditorView } from "@codemirror/view";
import type { SlashMenuItem } from "./slash-menu-extension";

const atLineStart = (view: EditorView, prefix: string): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  if (line.from === from) {
    view.dispatch({ changes: { from, insert: prefix } });
  } else {
    view.dispatch({
      changes: { from, insert: `\n${prefix}` },
      selection: { anchor: from + 1 + prefix.length }
    });
  }
  view.focus();
};

const wrapSelection = (view: EditorView, before: string, after: string, placeholder: string): void => {
  const { from, to, empty } = view.state.selection.main;
  if (empty) {
    view.dispatch({
      changes: { from, insert: `${before}${placeholder}${after}` },
      selection: { anchor: from + before.length, head: from + before.length + placeholder.length }
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: `${before}${view.state.sliceDoc(from, to)}${after}` },
      selection: { anchor: from + before.length + (to - from) + after.length }
    });
  }
  view.focus();
};

/**
 * Default slash-menu palette mirroring the Obsidian "insert block" affordance.
 * The `id` is the unique menu key, the `keywords` drive the substring filter,
 * and `insert` performs the actual CodeMirror transaction.
 */
export const buildDefaultSlashMenuItems = (): SlashMenuItem[] => [
  {
    id: "h1",
    label: "Heading 1",
    hint: "Big section title",
    keywords: ["h1", "heading", "title"],
    insert: (view) => atLineStart(view, "# ")
  },
  {
    id: "h2",
    label: "Heading 2",
    hint: "Section title",
    keywords: ["h2", "heading", "subtitle"],
    insert: (view) => atLineStart(view, "## ")
  },
  {
    id: "h3",
    label: "Heading 3",
    hint: "Sub-section",
    keywords: ["h3", "heading"],
    insert: (view) => atLineStart(view, "### ")
  },
  {
    id: "bullet",
    label: "Bulleted list",
    hint: "- item",
    keywords: ["ul", "list", "bullet"],
    insert: (view) => atLineStart(view, "- ")
  },
  {
    id: "numbered",
    label: "Numbered list",
    hint: "1. item",
    keywords: ["ol", "list", "number"],
    insert: (view) => atLineStart(view, "1. ")
  },
  {
    id: "todo",
    label: "Task list",
    hint: "- [ ] task",
    keywords: ["todo", "task", "checkbox"],
    insert: (view) => atLineStart(view, "- [ ] ")
  },
  {
    id: "quote",
    label: "Quote",
    hint: "> quote",
    keywords: ["quote", "blockquote"],
    insert: (view) => atLineStart(view, "> ")
  },
  {
    id: "code",
    label: "Code",
    hint: "`inline`",
    keywords: ["code", "inline"],
    insert: (view) => wrapSelection(view, "`", "`", "code")
  },
  {
    id: "codeblock",
    label: "Code block",
    hint: "```",
    keywords: ["code", "fence", "block"],
    insert: (view) => atLineStart(view, "```\n\n```\n")
  },
  {
    id: "divider",
    label: "Divider",
    hint: "---",
    keywords: ["divider", "rule", "hr"],
    insert: (view) => atLineStart(view, "---\n")
  }
];
