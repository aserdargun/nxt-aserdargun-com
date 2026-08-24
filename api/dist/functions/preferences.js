import { UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { json } from "../http/api-response.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, parseBody } from "./private-api.js";
export const createPreferencesHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    updatePreferences: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseBody(request, UpdatePreferencesRequestSchema);
        return json((await services.preferences.update(body)).value);
    })
});
export const updatePreferencesHandler = createPreferencesHandlers().updatePreferences;
//# sourceMappingURL=preferences.js.map