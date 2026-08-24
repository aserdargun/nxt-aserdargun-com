import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type PrivateHandlerDependencies } from "./private-api.js";
export declare const createVaultHandlers: (dependencies?: PrivateHandlerDependencies) => {
    getVault: (request: HttpRequest) => Promise<HttpResponseInit>;
    rescan: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const getVaultHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const rescanVaultHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=vault.d.ts.map