const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_BLOCK_BYTES = 24 * 1024;

/** Encodes a binary buffer into a base64 string using the shared alphabet. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  const blocks: string[] = [];
  for (let blockStart = 0; blockStart < bytes.length; blockStart += MAX_BLOCK_BYTES) {
    const blockEnd = Math.min(bytes.length, blockStart + MAX_BLOCK_BYTES);
    let block = "";
    for (let index = blockStart; index < blockEnd; index += 3) {
      const first = bytes[index] as number;
      const hasSecond = index + 1 < blockEnd;
      const hasThird = index + 2 < blockEnd;
      const second = hasSecond ? bytes[index + 1] as number : 0;
      const third = hasThird ? bytes[index + 2] as number : 0;
      block += BASE64_ALPHABET[first >> 2];
      block += BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)];
      block += hasSecond ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)] : "=";
      block += hasThird ? BASE64_ALPHABET[third & 63] : "=";
    }
    blocks.push(block);
  }
  return blocks.join("");
};

/** Reads a browser File/Blob and returns its base64 payload. */
export const readFileAsBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return encodeBase64(bytes);
};

export const formatAttachmentError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "TOO_LARGE") return "Attachment exceeds the 20 MB limit.";
    if (code === "UNSAFE_FILE") return "This file cannot be uploaded safely.";
    if (code === "CONFLICT") return "Refresh the vault before adding this attachment.";
  }
  return "The attachment could not be uploaded.";
};
