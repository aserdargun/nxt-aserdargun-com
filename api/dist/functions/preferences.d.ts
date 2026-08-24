import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type PrivateHandlerDependencies } from "./private-api.js";
export declare const createPreferencesHandlers: (dependencies?: PrivateHandlerDependencies) => {
    updatePreferences: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const updatePreferencesHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=preferences.d.ts.map