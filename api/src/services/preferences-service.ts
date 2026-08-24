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

  public read(): Promise<SystemFileSnapshot<Preferences>> {
    return this.options.preferencesStore.read();
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
    const prune = (values: readonly string[]): string[] =>
      [...new Set(values)].filter((noteId) => present.has(noteId));
    const value: Preferences = {
      schemaVersion: 1,
      favorites: prune(request.favorites),
      recent: prune(request.recent),
      theme: request.theme,
      ...(request.panelState === undefined ? {} : { panelState: request.panelState })
    };
    return this.options.preferencesStore.update(value, current.file.version);
  }
}
