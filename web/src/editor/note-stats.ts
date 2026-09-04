import { attachmentReferenceProjection, extractWikiLinks, parseNote } from "@nxt/domain";

export interface NoteStats {
  readonly words: number;
  readonly chars: number;
  readonly readingMinutes: number;
  readonly headings: number;
  readonly codeBlocks: number;
  readonly links: number;
  readonly attachments: number;
  readonly created: string | null;
  readonly updated: string | null;
}

const READING_WPM = 220;
const WORD_RE = /\S+/gu;
const HEADING_RE = /^ {0,3}#{1,6}(?=\s|$)/u;
const FENCE_RE = /^ {0,3}(?<marker>`{3,}|~{3,})/u;

const splitFrontmatter = (source: string): { body: string; yaml: string | null } => {
  const match = /^---[\t ]*\r?\n[\s\S]*?\n---[\t ]*(?:\r?\n|$)/u.exec(source);
  if (match === null) return { body: source, yaml: null };
  return { yaml: source.slice(match[0].indexOf("\n") + 1, match[0].lastIndexOf("\n---")), body: source.slice(match[0].length) };
};

const countHeadings = (body: string): number => {
  let count = 0;
  for (const line of body.split("\n")) if (HEADING_RE.test(line)) count += 1;
  return count;
};

const countCodeBlocks = (body: string): number => {
  let openFence: { marker: "`" | "~"; length: number } | null = null;
  let count = 0;
  for (const line of body.split("\n")) {
    const match = FENCE_RE.exec(line);
    if (match === null) continue;
    const marker = match.groups?.marker ?? "";
    const first = marker[0];
    if (first !== "`" && first !== "~") continue;
    const length = marker.length;
    if (openFence === null) {
      openFence = { marker: first, length };
    } else if (first === openFence.marker && length >= openFence.length) {
      count += 1;
      openFence = null;
    }
  }
  return count;
};

/**
 * Mirrors `deriveIndex` in `@nxt/domain/indexer`: parses the body via the same
 * `parseNote` codec, then derives link/attachment/heading/code counts from the
 * same source-of-truth helpers. Falls back to a frontmatter strip when the
 * source is a partial draft so word counts remain visible while typing.
 */
export const computeNoteStats = (source: string, notePath: string): NoteStats => {
  let body: string;
  let created: string | null = null;
  let updated: string | null = null;
  try {
    const parsed = parseNote(source);
    body = parsed.body;
    created = typeof parsed.frontmatter.created === "string" ? parsed.frontmatter.created : null;
    updated = typeof parsed.frontmatter.updated === "string" ? parsed.frontmatter.updated : null;
  } catch {
    body = splitFrontmatter(source).body;
  }

  const words = (body.match(WORD_RE) ?? []).length;
  const chars = body.length;
  const readingMinutes = Math.max(1, Math.round(words / READING_WPM));
  const headings = countHeadings(body);
  const codeBlocks = countCodeBlocks(body);
  const links = extractWikiLinks(body).length;
  const attachments = attachmentReferenceProjection(body, notePath).length;

  return { words, chars, readingMinutes, headings, codeBlocks, links, attachments, created, updated };
};

export const formatReadingTime = (minutes: number): string =>
  minutes < 1 ? "< 1 min read" : `${minutes} min read`;

export const formatStatNumber = (n: number): string => n.toLocaleString("en-US");

const formatTimestamp = (value: string | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export interface NoteStatsCardModel {
  readonly words: string;
  readonly chars: string;
  readonly readingTime: string;
  readonly headings: string;
  readonly codeBlocks: string;
  readonly links: string;
  readonly attachments: string;
  readonly createdLabel: string | null;
  readonly updatedLabel: string | null;
}

export const formatNoteStatsForCard = (stats: NoteStats): NoteStatsCardModel => ({
  words: formatStatNumber(stats.words),
  chars: formatStatNumber(stats.chars),
  readingTime: formatReadingTime(stats.readingMinutes),
  headings: formatStatNumber(stats.headings),
  codeBlocks: formatStatNumber(stats.codeBlocks),
  links: formatStatNumber(stats.links),
  attachments: formatStatNumber(stats.attachments),
  createdLabel: formatTimestamp(stats.created),
  updatedLabel: formatTimestamp(stats.updated)
});
