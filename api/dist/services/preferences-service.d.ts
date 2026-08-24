import { type Preferences, type UpdatePreferencesRequest, type VaultIndex } from "@nxt/contracts";
import type { SystemFileSnapshot, SystemFileStore } from "./system-file-store.js";
export declare class PreferencesService {
    private readonly options;
    constructor(options: {
        preferencesStore: SystemFileStore<Preferences>;
        indexStore: SystemFileStore<VaultIndex>;
    });
    read(): Promise<SystemFileSnapshot<Preferences>>;
    update(input: UpdatePreferencesRequest): Promise<SystemFileSnapshot<Preferences>>;
}
//# sourceMappingURL=preferences-service.d.ts.map