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

interface LegacyRecovery {
  readonly id: string;
  readonly noteId: string;
  readonly name: string;
  readonly source: string;
  readonly baseVersion: string;
  readonly recoveredAt: string;
  readonly removeMatchingDraft: boolean;
}

const seedVersionOneRecoveries = async (
  name: string,
  recoveries: readonly object[]
): Promise<void> => {
  const raw = await openDB(name, 1, {
    upgrade(database) {
      database.createObjectStore("drafts", { keyPath: "noteId" });
      const recoveryStore = database.createObjectStore("recoveries", { keyPath: "id" });
      recoveryStore.createIndex("by-note", "noteId");
    }
  });
  for (const recovery of recoveries) await raw.put("recoveries", recovery);
  raw.close();
};

const legacyRecovery = (input: {
  readonly noteId: string;
  readonly localUpdatedAt: string;
  readonly recoveredAt: string;
  readonly source: string;
  readonly collision?: number;
  readonly name?: string;
}): LegacyRecovery => ({
  id: `${input.noteId}:${input.recoveredAt}${
    input.collision === undefined ? "" : `:${input.collision}`
  }`,
  noteId: input.noteId,
  name: input.name ?? `Local draft ${input.localUpdatedAt}`,
  source: input.source,
  baseVersion: "7",
  recoveredAt: input.recoveredAt,
  removeMatchingDraft: false
});

const draft = (overrides: Partial<LocalDraft> = {}): LocalDraft => ({
  noteId: "note-1",
  source: "local",
  baseVersion: "7",
  path: "Notes/Plan.md",
  localUpdatedAt: "2026-08-23T12:00:00.000Z",
  confirmedAt: null,
  ...overrides
});

describe("IndexedDB draft recovery", () => {
  it("migrates exact version-one recoveries and conservatively falls back to recoveredAt", async () => {
    const name = databaseName("legacy-recovery-list");
    const namedLocalTime = "2026-08-23T12:01:00.000Z";
    const namedRecoveredTime = "2026-08-23T12:05:00.000Z";
    const fallbackTime = "2026-08-23T12:06:00.000Z";
    await seedVersionOneRecoveries(name, [
      legacyRecovery({
        noteId: "note-1",
        localUpdatedAt: namedLocalTime,
        recoveredAt: namedRecoveredTime,
        source: "named-local"
      }),
      legacyRecovery({
        noteId: "note-2",
        localUpdatedAt: "2026-08-23T12:02:00.000Z",
        recoveredAt: fallbackTime,
        source: "fallback",
        name: "Manual local recovery"
      })
    ]);

    const drafts = createIndexedDbDraftStore({ databaseName: name });
    expect((await drafts.listRecoveries("note-1", { limit: 10 })).items).toEqual([
      expect.objectContaining({
        id: `note-1:${namedLocalTime}`,
        source: "named-local",
        localUpdatedAt: namedLocalTime,
        recoveredAt: namedRecoveredTime
      })
    ]);
    expect((await drafts.listRecoveries("note-2", { limit: 10 })).items).toEqual([
      expect.objectContaining({
        id: `note-2:${fallbackTime}`,
        source: "fallback",
        localUpdatedAt: fallbackTime
      })
    ]);
    const upgraded = await openDB(name);
    expect(upgraded.version).toBe(2);
    upgraded.close();
  });

  it("deduplicates exact legacy copies and keeps preserveRecovery retry idempotent", async () => {
    const name = databaseName("legacy-recovery-dedupe");
    const localUpdatedAt = "2026-08-23T12:01:00.000Z";
    const recoveredAt = "2026-08-23T12:05:00.000Z";
    const duplicate = legacyRecovery({
      noteId: "note-1",
      localUpdatedAt,
      recoveredAt,
      source: "same"
    });
    await seedVersionOneRecoveries(name, [duplicate, { ...duplicate, id: `${duplicate.id}:1` }]);

    const drafts = createIndexedDbDraftStore({ databaseName: name });
    await drafts.preserveRecovery({
      noteId: "note-1",
      name: `Local draft ${localUpdatedAt}`,
      source: "same",
      baseVersion: "7",
      localUpdatedAt,
      recoveredAt: "2026-08-23T12:07:00.000Z",
      removeMatchingDraft: false
    });

    const page = await drafts.listRecoveries("note-1", { limit: 10 });
    expect(page.totalCount).toBe(1);
    expect(page.items).toEqual([
      expect.objectContaining({ id: `note-1:${localUpdatedAt}`, source: "same" })
    ]);
  });

  it("rolls back a source collision and retries the migration on the next operation", async () => {
    const name = databaseName("legacy-recovery-collision");
    const safeLocalTime = "2026-08-23T10:01:00.000Z";
    const safeRecoveredTime = "2026-08-23T10:05:00.000Z";
    const collisionLocalTime = "2026-08-23T12:01:00.000Z";
    const collisionRecoveredTime = "2026-08-23T12:05:00.000Z";
    const safeLegacy = legacyRecovery({
      noteId: "note-0",
      localUpdatedAt: safeLocalTime,
      recoveredAt: safeRecoveredTime,
      source: "safe"
    });
    const collidingLegacy = legacyRecovery({
      noteId: "note-1",
      localUpdatedAt: collisionLocalTime,
      recoveredAt: collisionRecoveredTime,
      source: "legacy-source"
    });
    const occupiedTarget = {
      id: `note-1:${collisionLocalTime}`,
      noteId: "note-1",
      name: `Local draft ${collisionLocalTime}`,
      source: "different-source",
      baseVersion: "8",
      localUpdatedAt: collisionLocalTime,
      recoveredAt: "2026-08-23T12:06:00.000Z",
      removeMatchingDraft: false
    } as const;
    await seedVersionOneRecoveries(name, [safeLegacy, collidingLegacy, occupiedTarget]);
    const drafts = createIndexedDbDraftStore({ databaseName: name });

    await expect(
      drafts.listRecoveries("note-1", { limit: 10 })
    ).rejects.toBeInstanceOf(DraftStoreError);
    const afterFailure = await openDB(name);
    const rawAfterFailure = await afterFailure.getAll("recoveries");
    expect(rawAfterFailure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: safeLegacy.id, source: "safe" }),
        expect.objectContaining({ id: collidingLegacy.id, source: "legacy-source" }),
        expect.objectContaining({ id: occupiedTarget.id, source: "different-source" })
      ])
    );
    expect(rawAfterFailure).toHaveLength(3);
    expect(rawAfterFailure).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `note-0:${safeLocalTime}` })])
    );
    await afterFailure.delete("recoveries", occupiedTarget.id);
    afterFailure.close();

    expect((await drafts.listRecoveries("note-1", { limit: 10 })).items).toEqual([
      expect.objectContaining({
        id: `note-1:${collisionLocalTime}`,
        source: "legacy-source"
      })
    ]);
    expect((await drafts.listRecoveries("note-0", { limit: 10 })).items).toEqual([
      expect.objectContaining({ id: `note-0:${safeLocalTime}`, source: "safe" })
    ]);
  });

  it("keeps a local draft until the same source is confirmed by Drive", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("confirm") });
    await drafts.put(draft());

    await drafts.markConfirmed({
      noteId: "note-1",
      source: "different",
      localUpdatedAt: "2026-08-23T12:00:00.000Z"
    });
    expect(await drafts.get("note-1")).not.toBeNull();
    await drafts.markConfirmed({
      noteId: "note-1",
      source: "local",
      localUpdatedAt: "2026-08-23T12:00:00.000Z"
    });
    expect(await drafts.get("note-1")).toBeNull();
  });

  it("atomically keeps a newer draft when an older confirmation races it", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("race") });
    await drafts.put(draft());

    await Promise.all([
      drafts.markConfirmed({
        noteId: "note-1",
        source: "local",
        localUpdatedAt: "2026-08-23T12:00:00.000Z"
      }),
      drafts.put(draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" }))
    ]);

    expect(await drafts.get("note-1")).toEqual(
      draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" })
    );
  });

  it("does not let a stale confirmation delete a newer already-committed draft", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("stale") });
    await drafts.put(draft({ source: "newer", localUpdatedAt: "2026-08-23T12:00:01.000Z" }));

    await drafts.markConfirmed({
      noteId: "note-1",
      source: "local",
      localUpdatedAt: "2026-08-23T12:00:00.000Z"
    });

    expect((await drafts.get("note-1"))?.source).toBe("newer");
  });

  it("does not delete newer identical content with a different local generation timestamp", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("same-source-stale") });
    await drafts.put(draft({ localUpdatedAt: "2026-08-23T12:00:01.000Z" }));

    await drafts.markConfirmed({
      noteId: "note-1",
      source: "local",
      localUpdatedAt: "2026-08-23T12:00:00.000Z"
    });

    expect(await drafts.get("note-1")).toEqual(
      draft({ localUpdatedAt: "2026-08-23T12:00:01.000Z" })
    );
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

  it("preserves an exact verified path and compatibly marks a legacy pathless draft", async () => {
    const name = databaseName("legacy-path");
    const raw = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore("drafts", { keyPath: "noteId" });
        const recoveries = database.createObjectStore("recoveries", { keyPath: "id" });
        recoveries.createIndex("by-note", "noteId");
      }
    });
    await raw.put("drafts", {
      noteId: "legacy-note",
      source: "legacy",
      baseVersion: "6",
      localUpdatedAt: "2026-08-23T11:00:00.000Z",
      confirmedAt: null
    });
    raw.close();
    const drafts = createIndexedDbDraftStore({ databaseName: name });

    expect(await drafts.get("legacy-note")).toEqual({
      noteId: "legacy-note",
      source: "legacy",
      baseVersion: "6",
      path: null,
      localUpdatedAt: "2026-08-23T11:00:00.000Z",
      confirmedAt: null
    });
    await drafts.put(draft({ path: "Vault/Nested/Plan.md" }));
    expect((await drafts.get("note-1"))?.path).toBe("Vault/Nested/Plan.md");
  });

  it("fails closed for a malformed persisted draft path", async () => {
    const name = databaseName("malformed-path");
    const raw = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore("drafts", { keyPath: "noteId" });
        const recoveries = database.createObjectStore("recoveries", { keyPath: "id" });
        recoveries.createIndex("by-note", "noteId");
      }
    });
    await raw.put("drafts", {
      ...draft({ noteId: "note-bad-path" }),
      path: 17
    });
    raw.close();

    await expect(
      createIndexedDbDraftStore({ databaseName: name }).get("note-bad-path")
    ).rejects.toBeInstanceOf(DraftStoreError);
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
      localUpdatedAt: "2026-08-23T12:01:00.000Z",
      recoveredAt: "2026-08-23T12:01:00.000Z",
      removeMatchingDraft: true
    });

    expect(await drafts.get("note-1")).toBeNull();
    expect((await drafts.listRecoveries("note-1", { limit: 10 })).items).toEqual([
      expect.objectContaining({
        name: "Local draft 2026-08-23T12:01:00.000Z",
        source: "local",
        recoveredAt: "2026-08-23T12:01:00.000Z"
      })
    ]);
  });

  it("deduplicates the same local recovery across retry timestamps", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("recovery-dedupe") });
    const recovery = {
      noteId: "note-1",
      name: "Local draft 2026-08-23T12:01:00.000Z",
      baseVersion: "7",
      localUpdatedAt: "2026-08-23T12:01:00.000Z",
      recoveredAt: "2026-08-23T12:01:00.000Z",
      removeMatchingDraft: false
    } as const;

    await drafts.preserveRecovery({ ...recovery, source: "same" });
    await drafts.preserveRecovery({
      ...recovery,
      source: "same",
      recoveredAt: "2026-08-23T12:02:00.000Z"
    });

    const page = await drafts.listRecoveries("note-1", { limit: 10 });
    expect(page.totalCount).toBe(1);
    expect(page.items.map((copy) => copy.source)).toEqual(["same"]);
  });

  it("rejects a non-matching source that collides on note and local timestamp", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("recovery-collision") });
    const recovery = {
      noteId: "note-1",
      name: "Local draft 2026-08-23T12:01:00.000Z",
      baseVersion: "7",
      localUpdatedAt: "2026-08-23T12:01:00.000Z",
      recoveredAt: "2026-08-23T12:01:00.000Z",
      removeMatchingDraft: false
    } as const;

    await drafts.preserveRecovery({ ...recovery, source: "first" });
    await expect(
      drafts.preserveRecovery({ ...recovery, source: "second" })
    ).rejects.toBeInstanceOf(DraftStoreError);
    expect((await drafts.listRecoveries("note-1", { limit: 10 })).items).toEqual([
      expect.objectContaining({ source: "first" })
    ]);
  });

  it("fails closed at explicit per-note and global recovery limits without deleting drafts", async () => {
    const drafts = createIndexedDbDraftStore({
      databaseName: databaseName("recovery-limits"),
      recoveryLimits: { perNote: 1, global: 2 }
    });
    await drafts.put(draft());
    const recovery = {
      name: "Local recovery",
      source: "local",
      baseVersion: "7",
      recoveredAt: "2026-08-23T12:05:00.000Z",
      removeMatchingDraft: false
    } as const;
    await drafts.preserveRecovery({
      ...recovery,
      noteId: "note-1",
      localUpdatedAt: "2026-08-23T12:01:00.000Z"
    });
    await expect(
      drafts.preserveRecovery({
        ...recovery,
        noteId: "note-1",
        source: "newer",
        localUpdatedAt: "2026-08-23T12:02:00.000Z"
      })
    ).rejects.toBeInstanceOf(DraftStoreError);
    expect(await drafts.get("note-1")).toEqual(draft());

    await drafts.preserveRecovery({
      ...recovery,
      noteId: "note-2",
      localUpdatedAt: "2026-08-23T12:03:00.000Z"
    });
    await expect(
      drafts.preserveRecovery({
        ...recovery,
        noteId: "note-3",
        localUpdatedAt: "2026-08-23T12:04:00.000Z"
      })
    ).rejects.toBeInstanceOf(DraftStoreError);
    expect(await drafts.get("note-1")).toEqual(draft());
  });

  it("pages recovery records with a bounded cursor and exact count", async () => {
    const drafts = createIndexedDbDraftStore({ databaseName: databaseName("recovery-page") });
    for (const minute of [1, 2, 3]) {
      const timestamp = `2026-08-23T12:0${minute}:00.000Z`;
      await drafts.preserveRecovery({
        noteId: "note-1",
        name: `Local draft ${timestamp}`,
        source: `local-${minute}`,
        baseVersion: "7",
        localUpdatedAt: timestamp,
        recoveredAt: timestamp,
        removeMatchingDraft: false
      });
    }

    const first = await drafts.listRecoveries("note-1", { limit: 2 });
    expect(first.totalCount).toBe(3);
    expect(first.items.map((copy) => copy.source)).toEqual(["local-1", "local-2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await drafts.listRecoveries("note-1", {
      limit: 2,
      cursor: first.nextCursor ?? undefined
    });
    expect(second.totalCount).toBe(3);
    expect(second.items.map((copy) => copy.source)).toEqual(["local-3"]);
    expect(second.nextCursor).toBeNull();
    await expect(drafts.listRecoveries("note-1", { limit: 10_000 })).rejects.toBeInstanceOf(
      DraftStoreError
    );
  });
});
