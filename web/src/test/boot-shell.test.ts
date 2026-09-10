import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(__dirname, "..", "..", "index.html"), "utf8");

describe("index.html boot shell", () => {
  it("renders a visible loading shell before JavaScript executes", () => {
    expect(indexHtml).toMatch(/<div id="nxt-boot-shell"/u);
    expect(indexHtml).toMatch(/Loading NXT/u);
  });

  it("loads executable scripts from same-origin files under the strict CSP", () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, inline] of scripts) {
      expect(attributes).toMatch(/src="\/(?!\/)[^"]+"/u);
      expect(inline?.trim()).toBe("");
    }
    expect(indexHtml).toContain('src="/boot-warmup.js"');
  });

  it("warms private routes without leaking private requests into public pages", () => {
    const script = readFileSync(resolve(__dirname, "..", "..", "public", "boot-warmup.js"), "utf8");
    for (const pathname of ["/", "/login", "/app", "/app/notes/id", "/p/snapshot", "/unavailable"]) {
      const requests: string[] = [];
      runInNewContext(script, {
        window: { location: { pathname } },
        Image: class { set src(value: string) { requests.push(value); } }
      });
      if (pathname.startsWith("/p/") || pathname === "/unavailable") {
        expect(requests).toEqual([]);
      } else {
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatch(/^\/api\/private\/session\?_warmup=1&_t=\d+$/u);
      }
    }
  });

  it("honors prefers-reduced-motion", () => {
    expect(indexHtml).toMatch(/prefers-reduced-motion/u);
  });
});
