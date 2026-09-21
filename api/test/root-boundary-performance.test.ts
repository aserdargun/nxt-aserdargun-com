import { afterEach, describe, expect, it, vi } from "vitest";
import { RootBoundaryStorage } from "../src/storage/root-boundary.js";
import type { StoragePort, StoredFile } from "../src/storage/storage-port.js";

const fixture = (count: number) => {
  const files = new Map<string, StoredFile>();
  const root: StoredFile = {
    id: "vault", name: "vault", mimeType: "application/vnd.google-apps.folder", parentIds: [],
    version: "1", size: 0, trashed: false, modifiedTime: "2026-09-21T00:00:00.000Z"
  };
  files.set(root.id, root);
  const children = Array.from({ length: count }, (_, index) => ({
    ...root, id: `note-${index}`, name: `${index}.md`, mimeType: "text/markdown", parentIds: [root.id]
  }));
  for (const child of children) files.set(child.id, child);
  let active = 0;
  let peak = 0;
  const get = vi.fn(async (id: string) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const file = files.get(id);
      if (file === undefined) throw new Error("missing file");
      return file;
    } finally { active -= 1; }
  });
  const inner = { get, listChildren: async () => ({ files: children, nextPageToken: "next" }) } as unknown as StoragePort;
  return { storage: new RootBoundaryStorage(inner, root.id), files, children, get, active: () => active, peak: () => peak };
};

afterEach(() => vi.useRealTimers());

describe("bounded parallel ancestry checks", () => {
  it("checks every file with at most four reads in flight and preserves pagination order", async () => {
    vi.useFakeTimers();
    const baseline = fixture(32);
    const baselineStart = Date.now();
    const serial = (async () => {
      await baseline.storage.assertInside("vault");
      for (const child of baseline.children) await baseline.storage.assertInside(child.id);
    })();
    await vi.runAllTimersAsync();
    await serial;
    expect(Date.now() - baselineStart).toBe(650);
    expect(baseline.peak()).toBe(1);
    const f = fixture(32);
    const start = Date.now();
    const pending = f.storage.listChildren({ parentId: "vault", pageSize: 100 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ files: f.children, nextPageToken: "next" });
    // Serial: root + 32 * (child + root) = 650ms; parallel: 170ms.
    expect(Date.now() - start).toBe(170);
    expect(f.peak()).toBe(4);
    expect(f.active()).toBe(0);
    expect(f.get).toHaveBeenCalledTimes(65);
    for (const child of f.children) expect(f.get).toHaveBeenCalledWith(child.id, undefined);
  });

  it("rejects an invalid child, drains its batch, and does not start later batches", async () => {
    vi.useFakeTimers();
    const f = fixture(8);
    f.files.set("note-1", { ...f.children[1]!, parentIds: [] });
    const rejected = expect(f.storage.listChildren({ parentId: "vault", pageSize: 100 })).rejects.toThrow("outside configured root");
    await vi.runAllTimersAsync();
    await rejected;
    expect(f.active()).toBe(0);
    expect(f.get).not.toHaveBeenCalledWith("note-4", undefined);
  });

  it("rechecks ancestry on every request after a previously valid child moves outside", async () => {
    vi.useFakeTimers();
    const f = fixture(1);
    const first = f.storage.listChildren({ parentId: "vault", pageSize: 100 });
    await vi.runAllTimersAsync();
    await first;
    f.files.set("note-0", { ...f.children[0]!, parentIds: [] });
    const rejected = expect(f.storage.listChildren({ parentId: "vault", pageSize: 100 })).rejects.toThrow("outside configured root");
    await vi.runAllTimersAsync();
    await rejected;
  });
});
