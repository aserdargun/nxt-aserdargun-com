import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type PrivateHandlerDependencies } from "./private-api.js";
export declare const createNoteHandlers: (dependencies?: PrivateHandlerDependencies) => {
    createNote: (request: HttpRequest) => Promise<HttpResponseInit>;
    getNote: (request: HttpRequest) => Promise<HttpResponseInit>;
    updateNote: (request: HttpRequest) => Promise<HttpResponseInit>;
    trashNote: (request: HttpRequest) => Promise<HttpResponseInit>;
    moveNote: (request: HttpRequest) => Promise<HttpResponseInit>;
    archiveNote: (request: HttpRequest) => Promise<HttpResponseInit>;
};
export declare const createNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const getNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const updateNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const trashNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const moveNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
export declare const archiveNoteHandler: (request: HttpRequest) => Promise<HttpResponseInit>;
//# sourceMappingURL=notes.d.ts.map