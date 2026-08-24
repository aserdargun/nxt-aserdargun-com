import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type PrivateHandlerDependencies } from "./private-api.js";
export declare const createAttachmentHandlers: (dependencies?: PrivateHandlerDependencies) => {
    create: (request: HttpRequest) => Promise<HttpResponseInit>;
    get: (request: HttpRequest) => Promise<HttpResponseInit>;
    trash: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const createAttachmentHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const getAttachmentHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const trashAttachmentHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=attachments.d.ts.map