import { VaultIndexSchema, type VaultAttachment, type VaultIndex } from "@nxt/contracts";
import { parseNote } from "./note-codec.js";
import { deriveMarkdownPlainText } from "./render-markdown.js";
import { extractWikiLinks, resolveWikiTarget } from "./wiki-links.js";

export interface IndexedSourceNote {
  source: string;
  driveId: string;
  path: string;
  driveVersion: string;
  attachments: readonly VaultAttachment[];
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");

/** Derives the stored index from source notes; backlinks are always recomputed. */
export function deriveIndex(records: readonly IndexedSourceNote[]): VaultIndex {
  const parsed = records.map((record) => ({ record, note: parseNote(record.source) }));
  const seenIds = new Set<string>();
  for (const { note } of parsed) {
    if (seenIds.has(note.frontmatter.id)) throw new Error(`duplicate note id: ${note.frontmatter.id}`);
    seenIds.add(note.frontmatter.id);
  }

  const targets = parsed.map(({ note }) => ({
    id: note.frontmatter.id,
    title: note.frontmatter.title,
    aliases: note.frontmatter.aliases
  }));
  const backlinks = new Map<string, string[]>();
  const entries = parsed.map(({ note, record }) => {
    const resolutions = extractWikiLinks(note.body).map((link) => ({
      target: link.target,
      resolution: resolveWikiTarget(link.target, targets)
    }));
    const outboundNoteIds = unique(resolutions.flatMap(({ resolution }) => resolution.kind === "resolved" ? [resolution.noteId] : []));
    const unresolvedWikiTargets = unique(resolutions
      .filter(({ resolution }) => resolution.kind !== "resolved")
      .map(({ target }) => target));
    for (const targetId of outboundNoteIds) {
      const linkedFrom = backlinks.get(targetId) ?? [];
      linkedFrom.push(note.frontmatter.id);
      backlinks.set(targetId, linkedFrom);
    }
    const bodyText = deriveMarkdownPlainText(note.body);
    const searchText = fold([note.frontmatter.title, ...note.frontmatter.aliases, ...note.frontmatter.tags, bodyText].join(" ")).slice(0, 100_000);

    return {
      id: note.frontmatter.id,
      title: note.frontmatter.title,
      aliases: [...note.frontmatter.aliases],
      driveId: record.driveId,
      path: record.path,
      created: note.frontmatter.created,
      updated: note.frontmatter.updated,
      driveVersion: record.driveVersion,
      tags: [...note.frontmatter.tags],
      searchText,
      excerpt: bodyText.slice(0, 4_000),
      outboundNoteIds,
      unresolvedWikiTargets,
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
      backlinks: [] as string[]
    };
  });

  for (const entry of entries) entry.backlinks = unique(backlinks.get(entry.id) ?? []);
  return VaultIndexSchema.parse({ schemaVersion: 1, entries });
}
