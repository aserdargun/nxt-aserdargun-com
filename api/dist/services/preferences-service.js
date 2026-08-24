import { UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
export class PreferencesService {
    options;
    constructor(options) {
        this.options = options;
    }
    async read() {
        const [preferences, index] = await Promise.all([this.options.preferencesStore.read(), this.options.indexStore.read()]);
        const present = new Set(index.value.entries.map((entry) => entry.id));
        const favorites = dedupePresent(preferences.value.favorites, present);
        const recent = dedupePresent(preferences.value.recent, present);
        if (sameList(favorites, preferences.value.favorites) && sameList(recent, preferences.value.recent))
            return preferences;
        return this.options.preferencesStore.update({ ...preferences.value, favorites, recent }, preferences.file.version);
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
        const value = {
            schemaVersion: 1,
            favorites: dedupePresent(request.favorites, present),
            recent: dedupePresent(request.recent, present),
            theme: request.theme,
            ...(request.panelState === undefined ? {} : { panelState: request.panelState })
        };
        return this.options.preferencesStore.update(value, current.file.version);
    }
}
const dedupePresent = (values, present) => [...new Set(values)].filter((noteId) => present.has(noteId));
const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
//# sourceMappingURL=preferences-service.js.map