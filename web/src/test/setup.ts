import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

class TestResizeObserver implements ResizeObserver {
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver
});

if (globalThis.crypto.subtle === undefined) {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
}

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
