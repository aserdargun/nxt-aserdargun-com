import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type PrivateHandlerDependencies } from "./private-api.js";
export declare const createFolderHandlers: (dependencies?: PrivateHandlerDependencies) => {
    createFolder: (request: HttpRequest) => Promise<HttpResponseInit>;
    updateFolder: (request: HttpRequest) => Promise<HttpResponseInit>;
    deleteFolder: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const createFolderHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const updateFolderHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const deleteFolderHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=folders.d.ts.map