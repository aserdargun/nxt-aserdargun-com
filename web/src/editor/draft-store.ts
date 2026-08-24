import { MAX_NOTE_SOURCE_BYTES, TimestampSchema } from "@nxt/contracts";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface LocalDraft {
  readonly noteId: string;
  readonly source: string;
  readonly baseVersion: string;
  readonly localUpdatedAt: string;
  readonly confirmedAt: string | null;
}

export interface RecoveryInput {
  readonly noteId: string;
  readonly name: string;
  readonly source: string;
  readonly baseVersion: string;
  readonly recoveredAt: string;
  readonly removeMatchingDraft: boolean;
}

export interface RecoveryCopy extends RecoveryInput {
  readonly id: string;
}

export interface DraftStore {
  get(noteId: string): Promise<LocalDraft | null>;
  put(draft: LocalDraft): Promise<void>;
  markConfirmed(input: { readonly noteId: string; readonly source: string }): Promise<void>;
  remove(noteId: string): Promise<void>;
  preserveRecovery(input: RecoveryInput): Promise<void>;
  listRecoveries(noteId: string): Promise<RecoveryCopy[]>;
}

interface DraftDatabase extends DBSchema {
  drafts: {
    key: string;
    value: LocalDraft;
  };
  recoveries: {
    key: string;
    value: RecoveryCopy;
    indexes: { "by-note": string };
  };
}

const DATABASE_VERSION = 1;
const DEFAULT_DATABASE_NAME = "nxt-markdown-drafts";
const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

export class DraftStoreError extends Error {
  public constructor(message = "The browser draft record is invalid.") {
    super(message);
    this.name = "DraftStoreError";
  }
}

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const validateDraft = (value: unknown): LocalDraft => {
  if (typeof value !== "object" || value === null) throw new DraftStoreError();
  const record = value as Partial<LocalDraft>;
  if (
    !isBoundedString(record.noteId, 512) ||
    typeof record.source !== "string" ||
    utf8Size(record.source) > MAX_NOTE_SOURCE_BYTES ||
    !isBoundedString(record.baseVersion, 512) ||
    TimestampSchema.safeParse(record.localUpdatedAt).success === false ||
    (record.confirmedAt !== null && TimestampSchema.safeParse(record.confirmedAt).success === false)
  ) {
    throw new DraftStoreError();
  }
  return {
    noteId: record.noteId,
    source: record.source,
    baseVersion: record.baseVersion,
    localUpdatedAt: record.localUpdatedAt as string,
    confirmedAt: record.confirmedAt as string | null
  };
};

const validateRecoveryInput = (value: RecoveryInput): RecoveryInput => {
  if (
    !isBoundedString(value.noteId, 512) ||
    !isBoundedString(value.name, 512) ||
    typeof value.source !== "string" ||
    utf8Size(value.source) > MAX_NOTE_SOURCE_BYTES ||
    !isBoundedString(value.baseVersion, 512) ||
    TimestampSchema.safeParse(value.recoveredAt).success === false ||
    typeof value.removeMatchingDraft !== "boolean"
  ) {
    throw new DraftStoreError("The browser recovery record is invalid.");
  }
  return value;
};

const validateRecovery = (value: unknown): RecoveryCopy => {
  if (typeof value !== "object" || value === null) {
    throw new DraftStoreError("The browser recovery record is invalid.");
  }
  const record = value as Partial<RecoveryCopy>;
  if (!isBoundedString(record.id, 1536)) {
    throw new DraftStoreError("The browser recovery record is invalid.");
  }
  return { id: record.id, ...validateRecoveryInput(record as RecoveryInput) };
};

export const createIndexedDbDraftStore = (
  options: { readonly databaseName?: string } = {}
): DraftStore => {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let databasePromise: Promise<IDBPDatabase<DraftDatabase>> | null = null;
  const database = (): Promise<IDBPDatabase<DraftDatabase>> => {
    databasePromise ??= openDB<DraftDatabase>(databaseName, DATABASE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("drafts")) {
          db.createObjectStore("drafts", { keyPath: "noteId" });
        }
        if (!db.objectStoreNames.contains("recoveries")) {
          const recoveries = db.createObjectStore("recoveries", { keyPath: "id" });
          recoveries.createIndex("by-note", "noteId");
        }
      }
    });
    return databasePromise;
  };

  return {
    async get(noteId) {
      if (!isBoundedString(noteId, 512)) throw new DraftStoreError();
      const value = await (await database()).get("drafts", noteId);
      return value === undefined ? null : validateDraft(value);
    },
    async put(draft) {
      await (await database()).put("drafts", validateDraft(draft));
    },
    async markConfirmed(input) {
      if (!isBoundedString(input.noteId, 512) || typeof input.source !== "string") {
        throw new DraftStoreError();
      }
      const transaction = (await database()).transaction("drafts", "readwrite");
      const current = await transaction.store.get(input.noteId);
      if (current !== undefined && validateDraft(current).source === input.source) {
        await transaction.store.delete(input.noteId);
      }
      await transaction.done;
    },
    async remove(noteId) {
      if (!isBoundedString(noteId, 512)) throw new DraftStoreError();
      await (await database()).delete("drafts", noteId);
    },
    async preserveRecovery(rawInput) {
      const input = validateRecoveryInput(rawInput);
      const transaction = (await database()).transaction(["drafts", "recoveries"], "readwrite");
      const recoveries = transaction.objectStore("recoveries");
      const baseId = `${input.noteId}:${input.recoveredAt}`;
      let id = baseId;
      let collision = 0;
      while (await recoveries.get(id) !== undefined) {
        collision += 1;
        id = `${baseId}:${collision}`;
      }
      await recoveries.put({ id, ...input });
      if (input.removeMatchingDraft) {
        const current = await transaction.objectStore("drafts").get(input.noteId);
        if (current !== undefined && validateDraft(current).source === input.source) {
          await transaction.objectStore("drafts").delete(input.noteId);
        }
      }
      await transaction.done;
    },
    async listRecoveries(noteId) {
      if (!isBoundedString(noteId, 512)) throw new DraftStoreError();
      const values = await (await database()).getAllFromIndex("recoveries", "by-note", noteId);
      return values.map(validateRecovery).sort((left, right) => left.recoveredAt.localeCompare(right.recoveredAt));
    }
  };
};

export const browserDraftStore = createIndexedDbDraftStore();
