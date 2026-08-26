import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { OwnerIdentity } from "../auth/require-owner.js";
import type { PublicationService } from "../services/publication-service.js";
export interface PublicationHandlerDependencies {
    authorize(request: HttpRequest): OwnerIdentity;
    resolveServices(): {
        publications: Pick<PublicationService, "publish" | "getStatus" | "revoke">;
    };
}
export declare const createPublicationHandlers: (dependencies?: PublicationHandlerDependencies) => {
    publish: (request: HttpRequest) => Promise<HttpResponseInit>;
    status: (request: HttpRequest) => Promise<HttpResponseInit>;
    revoke: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const publishNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const getPublicationStatusHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const revokePublicationHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=publications.d.ts.map