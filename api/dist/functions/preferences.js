import { PreferencesResponseSchema, UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { typedJson } from "../http/api-response.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, parseBody } from "./private-api.js";
export const createPreferencesHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    updatePreferences: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseBody(request, UpdatePreferencesRequestSchema);
        const value = (await services.preferences.update(body)).value;
        return typedJson(value, PreferencesResponseSchema);
    })
});
export const updatePreferencesHandler = createPreferencesHandlers().updatePreferences;
//# sourceMappingURL=preferences.js.map