export interface WikiLink {
  target: string;
  label: string | null;
}

export interface WikiLinkTarget {
  id: string;
  title: string;
  aliases: readonly string[];
}

export type WikiTargetResolution =
  | { kind: "resolved"; noteId: string }
  | { kind: "unresolved" }
  | { kind: "ambiguous"; candidateIds: string[] };

export interface ResolvedWikiLink extends WikiLink {
  resolution: WikiTargetResolution;
}

const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");

function tokenizeLine(line: string): WikiLink[] {
  const links: WikiLink[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const openingLength = line.slice(cursor).match(/^`+/u)?.[0].length ?? 0;
      let closing = cursor + openingLength;
      while (closing < line.length) {
        if (line[closing] !== "`") {
          closing += 1;
          continue;
        }
        const closingLength = line.slice(closing).match(/^`+/u)?.[0].length ?? 0;
        if (closingLength === openingLength) {
          cursor = closing + closingLength;
          break;
        }
        closing += closingLength;
      }
      if (closing >= line.length) cursor += openingLength;
      continue;
    }
    if (line.startsWith("[[", cursor)) {
      const close = line.indexOf("]]", cursor + 2);
      if (close !== -1) {
        const raw = line.slice(cursor + 2, close);
        const separator = raw.indexOf("|");
        const target = (separator === -1 ? raw : raw.slice(0, separator)).trim();
        const label = separator === -1 ? null : raw.slice(separator + 1).trim();
        if (target.length > 0 && (label === null || label.length > 0)) {
          links.push({ target, label });
        }
        cursor = close + 2;
        continue;
      }
    }
    cursor += 1;
  }

  return links;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(?<marker>`{3,}|~{3,})/u.exec(line);
  if (match === null) return null;
  const marker = match.groups?.marker ?? "";
  const first = marker[0];
  if (first !== "`" && first !== "~") return null;
  return { marker: first, length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = new RegExp(`^ {0,3}(?<marker>${fence.marker}+)[\\t ]*$`, "u").exec(line);
  const marker = match?.groups?.marker ?? "";
  return marker.length >= fence.length;
}

/** Extracts only unambiguous wiki syntax outside fenced and inline code. */
export function extractWikiLinks(source: string): WikiLink[] {
  const links: WikiLink[] = [];
  let fence: Fence | null = null;

  for (const line of source.split(/\r?\n/u)) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = openingFence(line);
    if (fence === null) links.push(...tokenizeLine(line));
  }

  return links;
}

/** Resolves an exact title before considering aliases, never choosing a tie. */
export function resolveWikiTarget(target: string, notes: readonly WikiLinkTarget[]): WikiTargetResolution {
  const foldedTarget = fold(target);
  const titleMatches = notes.filter((note) => fold(note.title) === foldedTarget);
  const matches = titleMatches.length > 0
    ? titleMatches
    : notes.filter((note) => note.aliases.some((alias) => fold(alias) === foldedTarget));

  if (matches.length === 1) return { kind: "resolved", noteId: matches[0]!.id };
  if (matches.length === 0) return { kind: "unresolved" };
  return { kind: "ambiguous", candidateIds: matches.map((note) => note.id) };
}

export function resolveWikiLinks(source: string, notes: readonly WikiLinkTarget[]): ResolvedWikiLink[];
export function resolveWikiLinks(links: readonly WikiLink[], notes: readonly WikiLinkTarget[]): ResolvedWikiLink[];
export function resolveWikiLinks(sourceOrLinks: string | readonly WikiLink[], notes: readonly WikiLinkTarget[]): ResolvedWikiLink[] {
  const links = typeof sourceOrLinks === "string" ? extractWikiLinks(sourceOrLinks) : sourceOrLinks;
  return links.map((link) => ({ ...link, resolution: resolveWikiTarget(link.target, notes) }));
}
