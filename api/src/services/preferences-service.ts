import {
  UpdatePreferencesRequestSchema,
  type Preferences,
  type UpdatePreferencesRequest,
  type VaultIndex
} from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
import type { SystemFileSnapshot, SystemFileStore } from "./system-file-store.js";

export class PreferencesService {
  public constructor(
    private readonly options: {
      preferencesStore: SystemFileStore<Preferences>;
      indexStore: SystemFileStore<VaultIndex>;
    }
  ) {}

  public async read(): Promise<SystemFileSnapshot<Preferences>> {
    const [preferences, index] = await Promise.all([this.options.preferencesStore.read(), this.options.indexStore.read()]);
    const present = new Set(index.value.entries.map((entry) => entry.id));
    const favorites = dedupePresent(preferences.value.favorites, present);
    const recent = dedupePresent(preferences.value.recent, present);
    if (sameList(favorites, preferences.value.favorites) && sameList(recent, preferences.value.recent)) return preferences;
    return this.options.preferencesStore.update({ ...preferences.value, favorites, recent }, preferences.file.version);
  }

  public async update(input: UpdatePreferencesRequest): Promise<SystemFileSnapshot<Preferences>> {
    let request: UpdatePreferencesRequest;
    try {
      request = UpdatePreferencesRequestSchema.parse(input);
    } catch {
      throw new ApiResponseError("INVALID_INPUT");
    }
    const [current, index] = await Promise.all([
      this.options.preferencesStore.read(),
      this.options.indexStore.read()
    ]);
    const present = new Set(index.value.entries.map((entry) => entry.id));
    const value: Preferences = {
      schemaVersion: 1,
      favorites: dedupePresent(request.favorites, present),
      recent: dedupePresent(request.recent, present),
      theme: request.theme,
      ...(request.panelState === undefined ? {} : { panelState: request.panelState })
    };
    return this.options.preferencesStore.update(value, current.file.version);
  }
}

const dedupePresent = (values: readonly string[], present: ReadonlySet<string>): string[] => [...new Set(values)].filter((noteId) => present.has(noteId));
const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
