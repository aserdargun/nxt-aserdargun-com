import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { PublicPublicationReader } from "../services/publication-service.js";
export interface PublicAssetDependencies {
    resolveReader(): Pick<PublicPublicationReader, "getAsset">;
}
export declare const createPublicAssetHandler: (dependencies?: PublicAssetDependencies) => (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const publicAssetHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=public-assets.d.ts.map