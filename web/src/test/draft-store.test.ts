import { MAX_NOTE_SOURCE_BYTES } from "@nxt/contracts";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import {
  DraftStoreError,
  createIndexedDbDraftStore,
  type LocalDraft
} from "../editor/draft-store";

let databaseSequence = 0;
const databaseName = (label: string): string => `nxt-task-11-${label}-${databaseSequence += 1}`;

const draft = (overrides: Partial<LocalDraft> = {}): LocalDraft => ({
  noteId: "note-1",
  source: "local",
  baseVersion: "7",
  localUpdatedAt: "2026-08-23T12:00:00.000Z",
  confirmedAt: null,
  ...overrides
});

describe("IndexedDB draft recovery", () => {
  it("keeps a local draft until the same source is confirmed by Drive", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("confirm") });
    await drafts.put(draft());

    await drafts.markConfirmed({ noteId: "note-1", source: "different" });
    expect(await drafts.get("note-1")).not.toBeNull();
    await drafts.markConfirmed({ noteId: "note-1", source: "local" });
    expect(await drafts.get("note-1")).toBeNull();
  });

  it("atomically keeps a newer draft when an older confirmation races it", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("race") });
    await drafts.put(draft());

    await Promise.all([
      drafts.markConfirmed({ noteId: "note-1", source: "local" }),
      drafts.put(draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" }))
    ]);

    expect(await drafts.get("note-1")).toEqual(
      draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" })
    );
  });

  it("does not let a stale confirmation delete a newer already-committed draft", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("stale") });
    await drafts.put(draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" }));

    await drafts.markConfirmed({ noteId: "note-1", source: "local" });

    expect((await drafts.get("note-1"))?.source).toBe("newer");
  });

  it("fails closed when a persisted draft record is malformed", async () => {
    const name = databaseName("malformed");
    const raw = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore("drafts", { keyPath: "noteId" });
        const recoveries = database.createObjectStore("recoveries", { keyPath: "id" });
        recoveries.createIndex("by-note", "noteId");
      }
    });
    await raw.put("drafts", { noteId: "note-bad", source: 17, baseVersion: "7" });
    raw.close();
    const drafts = createIndexedDbDraftStore({ databaseName: name });

    await expect(drafts.get("note-bad")).rejects.toBeInstanceOf(DraftStoreError);
  });

  it("bounds browser drafts with the shared source contract", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("limit") });

    await expect(
      drafts.put(draft({ source: "x".repeat(MAX_NOTE_SOURCE_BYTES + 1) }))
    ).rejects.toBeInstanceOf(DraftStoreError);
    expect(await drafts.get("note-1")).toBeNull();
  });

  it("atomically names a recovery copy before removing only its matching active draft", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("recovery") });
    await drafts.put(draft());

    await drafts.preserveRecovery({
      noteId: "note-1",
      name: "Local draft 2026-08-23T12:01:00.000Z",
      source: "local",
      baseVersion: "7",
      recoveredAt: "2026-08-23T12:01:00.000Z",
      removeMatchingDraft: true
    });

    expect(await drafts.get("note-1")).toBeNull();
    expect(await drafts.listRecoveries("note-1")).toEqual([
      expect.objectContaining({
        name: "Local draft 2026-08-23T12:01:00.000Z",
        source: "local",
        recoveredAt: "2026-08-23T12:01:00.000Z"
      })
    ]);
  });

  it("never overwrites a prior recovery created at the same canonical timestamp", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("recovery-collision") });
    const recovery = {
      noteId: "note-1",
      name: "Local draft 2026-08-23T12:01:00.000Z",
      baseVersion: "7",
      recoveredAt: "2026-08-23T12:01:00.000Z",
      removeMatchingDraft: false
    } as const;

    await drafts.preserveRecovery({ ...recovery, source: "first" });
    await drafts.preserveRecovery({ ...recovery, source: "second" });

    expect((await drafts.listRecoveries("note-1")).map((copy) => copy.source)).toEqual([
      "first",
      "second"
    ]);
  });
});
