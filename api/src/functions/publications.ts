import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  NoteIdSchema,
  PublicationResponseSchema,
  PublicationStatusResponseSchema,
  PublicIdSchema,
  PublishNoteRequestSchema,
  RevokePublicationResponseSchema
} from "@nxt/contracts";
import type { OwnerIdentity } from "../auth/require-owner.js";
import { errorResponse, typedJson } from "../http/api-response.js";
import type { PublicationService } from "../services/publication-service.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import { ownerFromRequest } from "./session.js";
import { assertNoQuery, parseBody, pathValue } from "./private-api.js";

export interface PublicationHandlerDependencies {
  authorize(request: HttpRequest): OwnerIdentity;
  resolveServices(): { publications: Pick<PublicationService, "publish" | "getStatus" | "revoke"> } | Promise<{ publications: Pick<PublicationService, "publish" | "getStatus" | "revoke"> }>;
}

const defaults = (): PublicationHandlerDependencies => ({
  authorize: ownerFromRequest,
  resolveServices: async () => ({ publications: (await resolveTask9Services()).publications })
});

export const createPublicationHandlers = (dependencies: PublicationHandlerDependencies = defaults()) => ({
  publish: async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      dependencies.authorize(request);
      assertNoQuery(request);
      const noteId = pathValue(request, "noteId", NoteIdSchema);
      const body = await parseBody(request, PublishNoteRequestSchema);
      const services = await Promise.resolve(dependencies.resolveServices());
      const result = await services.publications.publish({ noteId, expectedVersion: body.expectedVersion });
      return typedJson({ publicId: result.publicId, publishedAt: result.publishedAt }, PublicationResponseSchema);
    } catch (error) { return errorResponse(error); }
  },
  status: async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      dependencies.authorize(request);
      assertNoQuery(request);
      const noteId = pathValue(request, "noteId", NoteIdSchema);
      const services = await Promise.resolve(dependencies.resolveServices());
      const status = await services.publications.getStatus(noteId);
      return typedJson(status === null ? null : {
        publicId: status.publicId,
        publishedAt: status.publishedAt,
        sourceVersion: status.sourceVersion,
        attachmentCount: status.attachmentCount
      }, PublicationStatusResponseSchema);
    } catch (error) { return errorResponse(error); }
  },
  revoke: async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      dependencies.authorize(request);
      assertNoQuery(request);
      const publicId = pathValue(request, "publicId", PublicIdSchema);
      const services = await Promise.resolve(dependencies.resolveServices());
      return typedJson(await services.publications.revoke({ publicId }), RevokePublicationResponseSchema);
    } catch (error) { return errorResponse(error); }
  }
});

const runtime = createPublicationHandlers();
export const publishNoteHandler = runtime.publish;
export const getPublicationStatusHandler = runtime.status;
export const revokePublicationHandler = runtime.revoke;
