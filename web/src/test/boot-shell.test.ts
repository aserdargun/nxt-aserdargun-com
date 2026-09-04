import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(__dirname, "..", "..", "index.html"), "utf8");

describe("index.html boot shell", () => {
  it("renders a visible loading shell before JavaScript executes", () => {
    expect(indexHtml).toMatch(/<div id="nxt-boot-shell"/u);
    expect(indexHtml).toMatch(/Loading NXT/u);
  });

  it("warms private routes without leaking private requests into public pages", () => {
    expect(indexHtml).toMatch(/\/api\/private\/session/u);
    expect(indexHtml).toMatch(/_warmup=1/u);
    expect(indexHtml).toMatch(/pathname\.startsWith\("\/app\/"\)/u);
    expect(indexHtml).toMatch(/if \(!privateRoute\) return/u);
  });

  it("honors prefers-reduced-motion", () => {
    expect(indexHtml).toMatch(/prefers-reduced-motion/u);
  });
});
