import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { PreferencesResponseSchema, UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { typedJson } from "../http/api-response.js";
import {
  assertNoQuery,
  defaultPrivateHandlerDependencies,
  handlePrivate,
  parseBody,
  type PrivateHandlerDependencies
} from "./private-api.js";

export const createPreferencesHandlers = (dependencies: PrivateHandlerDependencies = defaultPrivateHandlerDependencies()) => ({
  updatePreferences: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const body = await parseBody(request, UpdatePreferencesRequestSchema);
    const value = (await services.preferences.update(body)).value;
    return typedJson({ ...value, favorites: value.favorites.slice(0, 100), recent: value.recent.slice(0, 100) }, PreferencesResponseSchema);
  })
});

export const updatePreferencesHandler = createPreferencesHandlers().updatePreferences;
