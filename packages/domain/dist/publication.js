/** Creates a 128-bit URL-safe identifier using the browser Web Crypto API. */
export function createPublicId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
//# sourceMappingURL=publication.js.map