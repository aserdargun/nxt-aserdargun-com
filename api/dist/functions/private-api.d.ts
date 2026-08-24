import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { OwnerIdentity } from "../auth/require-owner.js";
import type { PreferencesService } from "../services/preferences-service.js";
import type { RescanService } from "../services/rescan-service.js";
import type { VaultService } from "../services/vault-service.js";
export interface Task7Services {
    vault: VaultService;
    rescan: RescanService;
    preferences: PreferencesService;
}
export interface IdCodec {
    encode(value: string): string;
    decode(value: string): string;
}
export interface PrivateHandlerDependencies {
    authorize(request: HttpRequest): OwnerIdentity;
    resolveServices(): Task7Services;
    idCodec: IdCodec;
}
export declare const defaultPrivateHandlerDependencies: () => PrivateHandlerDependencies;
export declare class OpaqueIdCodec implements IdCodec {
    private readonly key;
    constructor(secret: string);
    encode(value: string): string;
    decode(token: string): string;
}
export declare const handlePrivate: (request: HttpRequest, dependencies: PrivateHandlerDependencies, action: (services: Task7Services) => Promise<HttpResponseInit>) => Promise<HttpResponseInit>;
export declare const assertNoQuery: (request: HttpRequest) => void;
export declare const parseBody: <T>(request: HttpRequest, schema: {
    parse(value: unknown): T;
}) => Promise<T>;
export declare const pathValue: (request: HttpRequest, key: string, schema: {
    parse(value: unknown): string;
}) => string;
//# sourceMappingURL=private-api.d.ts.map