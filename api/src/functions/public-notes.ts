import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { PublicIdSchema, PublicNoteResponseSchema } from "@nxt/contracts";
import type { PublicPublicationReader } from "../services/publication-service.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import {
  hasNoQuery,
  newPublicRequestId,
  publicHeaders,
  publicNotFound,
  publicRequestGate,
  type PublicRequestRelease
} from "./public-http.js";

export interface PublicReaderDependencies {
  resolveReader(): Pick<PublicPublicationReader, "getNote"> | Promise<Pick<PublicPublicationReader, "getNote">>;
  admit?(): PublicRequestRelease | null;
}

const defaults = (): PublicReaderDependencies => ({
  resolveReader: async () => (await resolveTask9Services()).reader,
  admit: () => publicRequestGate.tryAcquire()
});

export const createPublicNoteHandler = (dependencies: PublicReaderDependencies = defaults()) => async (request: HttpRequest): Promise<HttpResponseInit> => {
  const requestId = newPublicRequestId();
  let release: PublicRequestRelease | null | undefined;
  try {
    if (!hasNoQuery(request.url)) return publicNotFound(requestId);
    const publicId = PublicIdSchema.parse(request.params.publicId);
    release = dependencies.admit?.();
    if (release === null) return publicNotFound(requestId);
    const reader = await Promise.resolve(dependencies.resolveReader());
    const note = await reader.getNote(publicId);
    if (note === null) return publicNotFound(requestId);
    const parsed = PublicNoteResponseSchema.parse(note);
    return {
      status: 200,
      headers: publicHeaders(requestId, "application/json; charset=utf-8"),
      jsonBody: parsed
    };
  } catch {
    return publicNotFound(requestId);
  } finally {
    release?.();
  }
};

export const publicNoteHandler = createPublicNoteHandler();
