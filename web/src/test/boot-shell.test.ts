import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(__dirname, "..", "..", "index.html"), "utf8");

describe("index.html boot shell", () => {
  it("renders a visible loading shell before JavaScript executes", () => {
    expect(indexHtml).toMatch(/<div id="nxt-boot-shell"/u);
    expect(indexHtml).toMatch(/Loading NXT/u);
  });

  it("includes the warmup ping so the Functions container is warm by the time auth completes", () => {
    expect(indexHtml).toMatch(/\/api\/private\/session/u);
    expect(indexHtml).toMatch(/_warmup=1/u);
  });

  it("honors prefers-reduced-motion", () => {
    expect(indexHtml).toMatch(/prefers-reduced-motion/u);
  });
});
