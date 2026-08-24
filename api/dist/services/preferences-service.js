import { UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
export class PreferencesService {
    options;
    constructor(options) {
        this.options = options;
    }
    read() {
        return this.options.preferencesStore.read();
    }
    async update(input) {
        let request;
        try {
            request = UpdatePreferencesRequestSchema.parse(input);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        const [current, index] = await Promise.all([
            this.options.preferencesStore.read(),
            this.options.indexStore.read()
        ]);
        const present = new Set(index.value.entries.map((entry) => entry.id));
        const prune = (values) => [...new Set(values)].filter((noteId) => present.has(noteId));
        const value = {
            schemaVersion: 1,
            favorites: prune(request.favorites),
            recent: prune(request.recent),
            theme: request.theme,
            ...(request.panelState === undefined ? {} : { panelState: request.panelState })
        };
        return this.options.preferencesStore.update(value, current.file.version);
    }
}
//# sourceMappingURL=preferences-service.js.map