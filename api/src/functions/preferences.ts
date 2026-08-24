import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { UpdatePreferencesRequestSchema } from "@nxt/contracts";
import { json } from "../http/api-response.js";
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
    return json((await services.preferences.update(body)).value);
  })
});

export const updatePreferencesHandler = createPreferencesHandlers().updatePreferences;
