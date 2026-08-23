const fold = (value) => value.normalize("NFKC").toLocaleLowerCase("en-US");
function tokenizeLine(line) {
    const links = [];
    let cursor = 0;
    let inlineCode = false;
    while (cursor < line.length) {
        if (line[cursor] === "`") {
            inlineCode = !inlineCode;
            cursor += 1;
            continue;
        }
        if (!inlineCode && line.startsWith("[[", cursor)) {
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
/** Extracts only unambiguous wiki syntax outside fenced and inline code. */
export function extractWikiLinks(source) {
    const links = [];
    let fenced = false;
    let fenceMarker = "";
    for (const line of source.split(/\r?\n/u)) {
        const fence = /^(?<indent>[ \t]*)(?<marker>`{3,}|~{3,})/u.exec(line);
        if (fence !== null) {
            const marker = fence.groups?.marker ?? "";
            if (!fenced) {
                fenced = true;
                fenceMarker = marker[0] ?? "";
            }
            else if (marker[0] === fenceMarker) {
                fenced = false;
                fenceMarker = "";
            }
            continue;
        }
        if (!fenced)
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