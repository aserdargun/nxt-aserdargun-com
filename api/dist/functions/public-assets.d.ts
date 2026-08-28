import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { PublicPublicationReader } from "../services/publication-service.js";
import { type PublicRequestRelease } from "./public-http.js";
export interface PublicAssetDependencies {
    resolveReader(): Pick<PublicPublicationReader, "getAsset"> | Promise<Pick<PublicPublicationReader, "getAsset">>;
    admit?(): PublicRequestRelease | null;
}
export declare const createPublicAssetHandler: (dependencies?: PublicAssetDependencies) => (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const publicAssetHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=public-assets.d.ts.map