import { MAX_NOTE_SOURCE_BYTES, TimestampSchema } from "@nxt/contracts";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface LocalDraft {
  readonly noteId: string;
  readonly source: string;
  readonly baseVersion: string;
  readonly path: string | null;
  readonly localUpdatedAt: string;
  readonly confirmedAt: string | null;
}

export interface RecoveryInput {
  readonly noteId: string;
  readonly name: string;
  readonly source: string;
  readonly baseVersion: string;
  readonly localUpdatedAt: string;
  readonly recoveredAt: string;
  readonly removeMatchingDraft: boolean;
}

export interface RecoveryCopy extends RecoveryInput {
  readonly id: string;
}

export interface RecoveryPageOptions {
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface RecoveryPage {
  readonly items: readonly RecoveryCopy[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface DraftStore {
  get(noteId: string): Promise<LocalDraft | null>;
  put(draft: LocalDraft): Promise<void>;
  markConfirmed(input: {
    readonly noteId: string;
    readonly source: string;
    readonly localUpdatedAt: string;
  }): Promise<void>;
  remove(noteId: string): Promise<void>;
  preserveRecovery(input: RecoveryInput): Promise<void>;
  listRecoveries(noteId: string, options: RecoveryPageOptions): Promise<RecoveryPage>;
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
const DEFAULT_RECOVERY_LIMITS = { perNote: 32, global: 256 } as const;
const MAX_RECOVERY_PAGE_SIZE = 50;
const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

export class DraftStoreError extends Error {
  public constructor(message = "The browser draft record is invalid.") {
    super(message);
    this.name = "DraftStoreError";
  }
}

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const isVerifiedPath = (value: unknown): value is string =>
  isBoundedString(value, 4096) &&
  value.trim().length > 0 &&
  value.endsWith(".md") &&
  !value.includes("\u0000");

const validateDraft = (value: unknown): LocalDraft => {
  if (typeof value !== "object" || value === null) throw new DraftStoreError();
  const record = value as Partial<LocalDraft>;
  if (
    !isBoundedString(record.noteId, 512) ||
    typeof record.source !== "string" ||
    utf8Size(record.source) > MAX_NOTE_SOURCE_BYTES ||
    !isBoundedString(record.baseVersion, 512) ||
    (record.path !== undefined && record.path !== null && !isVerifiedPath(record.path)) ||
    TimestampSchema.safeParse(record.localUpdatedAt).success === false ||
    (record.confirmedAt !== null && TimestampSchema.safeParse(record.confirmedAt).success === false)
  ) {
    throw new DraftStoreError();
  }
  return {
    noteId: record.noteId,
    source: record.source,
    baseVersion: record.baseVersion,
    path: record.path === undefined ? null : record.path,
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
    TimestampSchema.safeParse(value.localUpdatedAt).success === false ||
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
  const input = validateRecoveryInput(record as RecoveryInput);
  if (record.id !== recoveryId(input)) {
    throw new DraftStoreError("The browser recovery record is invalid.");
  }
  return { id: record.id, ...input };
};

const recoveryId = (input: Pick<RecoveryInput, "noteId" | "localUpdatedAt">): string =>
  `${input.noteId}:${input.localUpdatedAt}`;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const createIndexedDbDraftStore = (
  options: {
    readonly databaseName?: string;
    readonly recoveryLimits?: {
      readonly perNote: number;
      readonly global: number;
    };
  } = {}
): DraftStore => {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const recoveryLimits = options.recoveryLimits ?? DEFAULT_RECOVERY_LIMITS;
  if (!isPositiveInteger(recoveryLimits.perNote) || !isPositiveInteger(recoveryLimits.global)) {
    throw new DraftStoreError("The browser recovery limits are invalid.");
  }
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
      if (
        !isBoundedString(input.noteId, 512) ||
        typeof input.source !== "string" ||
        TimestampSchema.safeParse(input.localUpdatedAt).success === false
      ) {
        throw new DraftStoreError();
      }
      const transaction = (await database()).transaction("drafts", "readwrite");
      const current = await transaction.store.get(input.noteId);
      if (current !== undefined) {
        const validated = validateDraft(current);
        if (
          validated.source === input.source &&
          validated.localUpdatedAt === input.localUpdatedAt
        ) {
          await transaction.store.delete(input.noteId);
        }
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
      const id = recoveryId(input);
      const existingRaw = await recoveries.get(id);
      if (existingRaw !== undefined) {
        const existing = validateRecovery(existingRaw);
        if (
          existing.noteId !== input.noteId ||
          existing.localUpdatedAt !== input.localUpdatedAt ||
          existing.source !== input.source
        ) {
          throw new DraftStoreError("The browser recovery key is already used by different content.");
        }
      } else {
        const [noteCount, globalCount] = await Promise.all([
          recoveries.index("by-note").count(input.noteId),
          recoveries.count()
        ]);
        if (noteCount >= recoveryLimits.perNote || globalCount >= recoveryLimits.global) {
          throw new DraftStoreError("The browser recovery limit has been reached.");
        }
        await recoveries.put({ id, ...input });
      }
      if (input.removeMatchingDraft) {
        const current = await transaction.objectStore("drafts").get(input.noteId);
        if (current !== undefined && validateDraft(current).source === input.source) {
          await transaction.objectStore("drafts").delete(input.noteId);
        }
      }
      await transaction.done;
    },
    async listRecoveries(noteId, options) {
      if (
        !isBoundedString(noteId, 512) ||
        !isPositiveInteger(options.limit) ||
        options.limit > MAX_RECOVERY_PAGE_SIZE ||
        (options.cursor !== undefined && !isBoundedString(options.cursor, 1536))
      ) {
        throw new DraftStoreError("The browser recovery page is invalid.");
      }
      const transaction = (await database()).transaction("recoveries", "readonly");
      const index = transaction.store.index("by-note");
      const totalCount = await index.count(noteId);
      const items: RecoveryCopy[] = [];
      let cursor = await index.openCursor(IDBKeyRange.only(noteId));
      let afterCursor = options.cursor === undefined;
      let cursorFound = options.cursor === undefined;
      while (cursor !== null && items.length <= options.limit) {
        if (!afterCursor) {
          if (cursor.primaryKey === options.cursor) {
            cursorFound = true;
            afterCursor = true;
          }
        } else {
          items.push(validateRecovery(cursor.value));
        }
        cursor = await cursor.continue();
      }
      await transaction.done;
      if (!cursorFound) throw new DraftStoreError("The browser recovery cursor is invalid.");
      const hasNextPage = items.length > options.limit;
      if (hasNextPage) items.pop();
      return {
        items,
        nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null,
        totalCount
      };
    }
  };
};

export const browserDraftStore = createIndexedDbDraftStore();
