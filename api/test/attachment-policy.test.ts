import { describe, expect, it } from "vitest";
import { ApiResponseError } from "../src/http/api-response.js";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentNameLength,
  classifyAttachment,
  detectAttachment,
  normalizeAttachmentName,
  resolveAttachmentName
} from "../src/services/attachment-policy.js";

const validPng = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const validGif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
// A real 1x1 lossy WebP produced by cwebp 1.6.0. Its VP8 frame declares a
// ten-byte first partition and retains a non-empty token partition.
const validWebp = Uint8Array.from(Buffer.from("UklGRiYAAABXRUJQVlA4IBoAAABQAQCdASoBAAEAAgA0JZwABAAAAP75HbIQAA==", "base64"));
const minimalJpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9
]);
const classicPdf = (changes: {
  beforeXref?: string;
  betweenTrailerAndStartxref?: string;
  mutateXref?: (xref: string, offsets: readonly number[]) => string;
  trailer?: string;
  trailing?: string;
  extraObject?: string;
} = {}): Uint8Array => {
  const header = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>\nendobj\n",
    ...(changes.extraObject === undefined ? [] : [changes.extraObject])
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += object;
  }
  body += changes.beforeXref ?? "";
  const xrefOffset = Buffer.byteLength(body, "latin1");
  const lines = ["0000000000 65535 f ", ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `)];
  let xref = `xref\n0 ${lines.length}\n${lines.join("\n")}\n`;
  xref = changes.mutateXref?.(xref, offsets) ?? xref;
  const trailer = changes.trailer ?? `<< /Size ${lines.length} /Root 1 0 R >>`;
  return Uint8Array.from(Buffer.from(`${body}${xref}trailer\n${trailer}\n${changes.betweenTrailerAndStartxref ?? ""}startxref\n${xrefOffset}\n%%EOF\n${changes.trailing ?? ""}`, "latin1"));
};

describe("attachment policy", () => {
  it.each([
    ["image/png", "inline"],
    ["image/jpeg", "inline"],
    ["image/webp", "inline"],
    ["image/gif", "inline"],
    ["application/pdf", "inline"],
    ["image/svg+xml", "download"],
    ["text/html", "download"],
    ["application/zip", "download"],
    ["application/x-msdownload", "download"]
  ])("maps %s to %s", (mime, disposition) => {
    expect(classifyAttachment(mime)).toBe(disposition);
  });

  it("uses only coherent detected PNG content for inline delivery", async () => {
    const truncatedPng = validPng.slice(0, 16);
    const polyglotPng = new Uint8Array([...validPng, ...new TextEncoder().encode("<script>alert(1)</script>")]);

    await expect(detectAttachment({ name: "diagram.png", declaredMime: "image/png", bytes: validPng }))
      .resolves.toMatchObject({ mimeType: "image/png", disposition: "inline" });
    await expect(detectAttachment({ name: "diagram.jpg", declaredMime: "image/png", bytes: validPng }))
      .resolves.toMatchObject({ mimeType: "image/png", disposition: "download" });
    await expect(detectAttachment({ name: "diagram.png", declaredMime: "text/plain", bytes: validPng }))
      .resolves.toMatchObject({ mimeType: "image/png", disposition: "download" });
    await expect(detectAttachment({ name: "truncated.png", declaredMime: "image/png", bytes: truncatedPng }))
      .resolves.toMatchObject({ mimeType: "image/png", disposition: "download" });
    await expect(detectAttachment({ name: "polyglot.png", declaredMime: "image/png", bytes: polyglotPng }))
      .resolves.toMatchObject({ mimeType: "image/png", disposition: "download" });
  });

  it("downgrades every WebP because no complete decoder proves an inline-safe image", async () => {
    const webp = (payload: readonly number[], declaredLength = payload.length, trailing: readonly number[] = []): Uint8Array => {
      const riffLength = 4 + 8 + declaredLength + (declaredLength % 2);
      return Uint8Array.from([
        ...new TextEncoder().encode("RIFF"), riffLength & 0xff, (riffLength >>> 8) & 0xff, 0, 0,
        ...new TextEncoder().encode("WEBPVP8 "), declaredLength & 0xff, (declaredLength >>> 8) & 0xff, 0, 0,
        ...payload, ...(payload.length % 2 === 0 ? [] : [0]), ...trailing
      ]);
    };
    const shell = [0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0];
    // This synthetic frame satisfies the former header/partition checks while
    // carrying no decoder-proven VP8 image. It must never reach inline.
    const positivePartitionSynthetic = webp([0x30, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0xaa, 0xbb]);
    const zeroPartitionWithNoise = webp([...shell, 0, 0, 0, 0, 0xaa, 0x55]);
    const truncatedPartition = webp([0x50, 0x0d, 0, ...shell.slice(3), 1, 2, 3]);
    const invalidSync = Uint8Array.from(validWebp);
    invalidSync[23] = 0;
    const invalidDimensions = Uint8Array.from(validWebp);
    invalidDimensions[26] = 0;
    invalidDimensions[27] = 0;
    const invalidVersion = Uint8Array.from(validWebp);
    invalidVersion[20] = invalidVersion[20]! | 0x0e;
    const hiddenFrame = Uint8Array.from(validWebp);
    hiddenFrame[20] = hiddenFrame[20]! & ~0x10;
    const badChunkLength = Uint8Array.from(validWebp);
    badChunkLength[16] = badChunkLength[16]! + 1;
    const trailingPolyglot = new Uint8Array([...validWebp, ...new TextEncoder().encode("<script>alert(1)</script>")]);

    for (const bytes of [
      validWebp, positivePartitionSynthetic, webp(shell), zeroPartitionWithNoise, truncatedPartition,
      invalidSync, invalidDimensions, invalidVersion, hiddenFrame, badChunkLength, trailingPolyglot
    ]) {
      await expect(detectAttachment({ name: "image.webp", declaredMime: "image/webp", bytes }))
        .resolves.toMatchObject({ mimeType: "image/webp", disposition: "download" });
    }
  });

  it("downgrades every PDF because no complete parser proves an inline-safe document", async () => {
    const tokenPdf = new TextEncoder().encode("%PDF-1.4\nxref\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n");
    const injectedBeforeXref = classicPdf({ beforeXref: "<script>before-xref</script>\n" });
    const badCount = classicPdf({ mutateXref: (xref) => xref.replace("0 4", "0 5") });
    const badOffset = classicPdf({ mutateXref: (xref, offsets) => xref.replace(offsets[0]!.toString().padStart(10, "0"), (offsets[0]! + 1).toString().padStart(10, "0")) });
    const badGeneration = classicPdf({ mutateXref: (xref) => xref.replace(" 00000 n \n", " 00001 n \n") });
    const badRoot = classicPdf({ trailer: "<< /Size 4 /Root 9 0 R >>" });
    const badSize = classicPdf({ trailer: "<< /Size 3 /Root 1 0 R >>" });
    const wrongRootType = classicPdf({
      extraObject: "4 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
      trailer: "<< /Size 5 /Root 4 0 R >>"
    });
    const duplicateSubsection = classicPdf({ mutateXref: (xref, offsets) => `${xref}1 1\n${offsets[0]!.toString().padStart(10, "0")} 00000 n \n` });
    const impossibleActive = classicPdf({ mutateXref: (xref) => `${xref}4 1\n9999999999 00000 n \n`, trailer: "<< /Size 5 /Root 1 0 R >>" });
    const activeObjectZero = classicPdf({ mutateXref: (xref) => xref.replace("0000000000 65535 f ", "0000000000 00000 n ") });
    const invalidFreeList = classicPdf({
      mutateXref: (xref) => `${xref}4 1\n0000000004 00000 f \n`,
      trailer: "<< /Size 5 /Root 1 0 R >>"
    });
    const missingPagesGraph = classicPdf({
      extraObject: "4 0 obj\n<< /Type /Catalog >>\nendobj\n",
      trailer: "<< /Size 5 /Root 4 0 R >>"
    });
    const scriptBeforeStartxref = classicPdf({ betweenTrailerAndStartxref: "<script>polyglot</script>\n" });
    const streamPdf = classicPdf({
      extraObject: "4 0 obj\n<< /Length 1 >>\nstream\nx\nendstream\nendobj\n",
      trailer: "<< /Size 5 /Root 1 0 R >>"
    });
    const truncated = classicPdf().slice(0, -8);
    const trailingPolyglot = classicPdf({ trailing: "<script>after-eof</script>" });

    for (const bytes of [
      classicPdf(), tokenPdf, injectedBeforeXref, badCount, badOffset, badGeneration, badRoot, badSize,
      wrongRootType, duplicateSubsection, impossibleActive, activeObjectZero, invalidFreeList,
      missingPagesGraph, scriptBeforeStartxref, streamPdf, truncated, trailingPolyglot
    ]) {
      await expect(detectAttachment({ name: "file.pdf", declaredMime: "application/pdf", bytes }))
        .resolves.toMatchObject({ mimeType: "application/pdf", disposition: "download" });
    }
  });

  it("still requires real GIF/JPEG payload boundaries", async () => {
    const gifWithoutImage = Uint8Array.from([...validGif.slice(0, 13), 0x3b]);
    const invalidLzw = Uint8Array.from(validGif);
    invalidLzw[invalidLzw.length - 5] = 255;
    await expect(detectAttachment({ name: "image.gif", declaredMime: "image/gif", bytes: validGif })).resolves.toMatchObject({ disposition: "inline" });
    await expect(detectAttachment({ name: "image.gif", declaredMime: "image/gif", bytes: gifWithoutImage })).resolves.toMatchObject({ disposition: "download" });
    await expect(detectAttachment({ name: "image.gif", declaredMime: "image/gif", bytes: invalidLzw })).resolves.toMatchObject({ disposition: "download" });
    await expect(detectAttachment({ name: "image.jpg", declaredMime: "image/jpeg", bytes: minimalJpeg })).resolves.toMatchObject({ disposition: "inline" });
    await expect(detectAttachment({ name: "image.jpg", declaredMime: "image/jpeg", bytes: minimalJpeg.slice(0, -1) })).resolves.toMatchObject({ disposition: "download" });
  });

  it("only labels valid UTF-8 as text when the final extension is safe", async () => {
    const text = new TextEncoder().encode("# A harmless note\n");

    await expect(detectAttachment({ name: "note.md", declaredMime: "text/markdown", bytes: text }))
      .resolves.toMatchObject({ mimeType: "text/markdown", disposition: "download" });
    await expect(detectAttachment({ name: "note.txt", declaredMime: "text/plain", bytes: text }))
      .resolves.toMatchObject({ mimeType: "text/plain", disposition: "download" });
    await expect(detectAttachment({ name: "note.html", declaredMime: "text/html", bytes: text }))
      .resolves.toMatchObject({ mimeType: "application/octet-stream", disposition: "download" });
  });

  it.each([
    ["active.svg", "image/svg+xml", new TextEncoder().encode("<svg onload=alert(1) />")],
    ["active.html", "text/html", new TextEncoder().encode("<script>alert(1)</script>")],
    ["archive.zip", "application/zip", Uint8Array.from([80, 75, 3, 4, 20, 0, 0, 0])],
    ["program.exe", "application/x-msdownload", Uint8Array.from([77, 90, 144, 0, 3, 0, 0, 0])]
  ])("never inlines malicious %s fixtures", async (name, declaredMime, bytes) => {
    await expect(detectAttachment({ name, declaredMime, bytes })).resolves.toMatchObject({ disposition: "download" });
  });

  it("normalizes hostile Unicode filenames, removes path controls, and preserves a safe final extension", () => {
    expect(normalizeAttachmentName("e\u0301/../report\u0000.PnG")).toBe("é..report.png");
    expect(normalizeAttachmentName(`${"a".repeat(400)}.PDF`).endsWith(".pdf")).toBe(true);
    expect(attachmentNameLength(normalizeAttachmentName(`${"a".repeat(400)}.PDF`))).toBe(180);
    expect(() => normalizeAttachmentName("..")).toThrowError(ApiResponseError);
    expect(() => normalizeAttachmentName("CON.txt")).toThrowError(ApiResponseError);
  });

  it("resolves normalized filename collisions deterministically", () => {
    expect(resolveAttachmentName("e\u0301.png", ["é.png", "é-2.png"])).toBe("é-3.png");
  });

  it("uses one Unicode code-point metric at the emoji and NFD boundary", () => {
    const emoji = "🙂".repeat(179);
    expect(attachmentNameLength(`${emoji}.txt`)).toBe(183);
    const normalized = normalizeAttachmentName(`${emoji}.txt`);
    expect(attachmentNameLength(normalized)).toBe(180);
    expect(normalized.endsWith(".txt")).toBe(true);
    expect(attachmentNameLength(resolveAttachmentName(normalized, [normalized]))).toBeLessThanOrEqual(180);
    expect(normalizeAttachmentName(`e\u0301`.repeat(200) + ".txt")).toBe(normalizeAttachmentName("é".repeat(200) + ".txt"));
  });

  it("exports the exact 20 MiB byte ceiling", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});
