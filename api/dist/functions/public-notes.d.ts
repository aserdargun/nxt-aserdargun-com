import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { PublicPublicationReader } from "../services/publication-service.js";
export interface PublicReaderDependencies {
    resolveReader(): Pick<PublicPublicationReader, "getNote">;
}
export declare const createPublicNoteHandler: (dependencies?: PublicReaderDependencies) => (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const publicNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=public-notes.d.ts.map