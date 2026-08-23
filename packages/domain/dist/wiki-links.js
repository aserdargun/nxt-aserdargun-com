const fold = (value) => value.normalize("NFKC").toLocaleLowerCase("en-US");
function tokenizeLine(line) {
    const links = [];
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
            if (closing >= line.length)
                cursor += openingLength;
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
function openingFence(line) {
    const match = /^ {0,3}(?<marker>`{3,}|~{3,})/u.exec(line);
    if (match === null)
        return null;
    const marker = match.groups?.marker ?? "";
    const first = marker[0];
    if (first !== "`" && first !== "~")
        return null;
    return { marker: first, length: marker.length };
}
function closesFence(line, fence) {
    const marker = fence.marker.repeat(fence.length);
    return new RegExp(`^ {0,3}${marker}[\\t ]*$`, "u").test(line);
}
/** Extracts only unambiguous wiki syntax outside fenced and inline code. */
export function extractWikiLinks(source) {
    const links = [];
    let fence = null;
    for (const line of source.split(/\r?\n/u)) {
        if (fence !== null) {
            if (closesFence(line, fence))
                fence = null;
            continue;
        }
        fence = openingFence(line);
        if (fence === null)
            links.push(...tokenizeLine(line));
    }
    return links;
}
/** Resolves an exact title before considering aliases, never choosing a tie. */
export function resolveWikiTarget(target, notes) {
    const foldedTarget = fold(target);
    const titleMatches = notes.filter((note) => fold(note.title) === foldedTarget);
    const matches = titleMatches.length > 0
        ? titleMatches
        : notes.filter((note) => note.aliases.some((alias) => fold(alias) === foldedTarget));
    if (matches.length === 1)
        return { kind: "resolved", noteId: matches[0].id };
    if (matches.length === 0)
        return { kind: "unresolved" };
    return { kind: "ambiguous", candidateIds: matches.map((note) => note.id) };
}
export function resolveWikiLinks(sourceOrLinks, notes) {
    const links = typeof sourceOrLinks === "string" ? extractWikiLinks(sourceOrLinks) : sourceOrLinks;
    return links.map((link) => ({ ...link, resolution: resolveWikiTarget(link.target, notes) }));
}
//# sourceMappingURL=wiki-links.js.map