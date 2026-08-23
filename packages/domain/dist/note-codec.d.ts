import { type NoteDocument } from "@nxt/contracts";
/** Parses the portable Markdown note format without altering the source. */
export declare function parseNote(source: string): NoteDocument;
/** Serializes notes in the stable on-disk field order. */
export declare function serializeNote(note: NoteDocument): string;
//# sourceMappingURL=note-codec.d.ts.map