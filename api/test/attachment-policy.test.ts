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
