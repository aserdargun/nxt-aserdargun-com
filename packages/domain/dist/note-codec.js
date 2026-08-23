import { NoteDocumentSchema } from "@nxt/contracts";
import { parseDocument } from "yaml";
const OPENING_DELIMITER = /^---[\t ]*\r?\n/u;
const CLOSING_DELIMITER = /^---[\t ]*\r?\n?/mu;
function normalizeBody(body) {
    return `${body.replace(/^\r?\n+/u, "").replace(/\r\n/gu, "\n").replace(/\n*$/u, "")}\n`;
}
function quoted(value) {
    return JSON.stringify(value);
}
function stringList(values) {
    return `[${values.map(quoted).join(", ")}]`;
}
/** Parses the portable Markdown note format without altering the source. */
export function parseNote(source) {
    const opening = source.match(OPENING_DELIMITER);
    if (opening === null || opening.index !== 0) {
        throw new Error("note must start with a YAML frontmatter delimiter");
    }
    const bodyOffset = opening[0].length;
    const closing = CLOSING_DELIMITER.exec(source.slice(bodyOffset));
    if (closing === null || closing.index === undefined) {
        throw new Error("note frontmatter is missing its closing delimiter");
    }
    const yamlSource = source.slice(bodyOffset, bodyOffset + closing.index);
    const document = parseDocument(yamlSource, { uniqueKeys: true });
    if (document.errors.length > 0) {
        throw new Error(`invalid note frontmatter: ${document.errors.map((error) => error.message).join("; ")}`);
    }
    const frontmatter = document.toJS({ maxAliasCount: 0 });
    return NoteDocumentSchema.parse({
        frontmatter,
        body: source.slice(bodyOffset + closing.index + closing[0].length)
    });
}
/** Serializes notes in the stable on-disk field order. */
export function serializeNote(note) {
    const parsed = NoteDocumentSchema.parse(note);
    const { aliases, created, id, tags, title, updated } = parsed.frontmatter;
    const frontmatter = [
        `id: ${quoted(id)}`,
        `title: ${quoted(title)}`,
        `created: ${quoted(created)}`,
        `updated: ${quoted(updated)}`,
        `tags: ${stringList(tags)}`,
        `aliases: ${stringList(aliases)}`
    ].join("\n");
    return `---\n${frontmatter}\n---\n\n${normalizeBody(parsed.body)}`;
}
//# sourceMappingURL=note-codec.js.map