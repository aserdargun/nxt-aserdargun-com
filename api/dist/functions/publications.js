import { NoteIdSchema, PublicationResponseSchema, PublicIdSchema, PublishNoteRequestSchema } from "@nxt/contracts";
import { errorResponse, typedJson } from "../http/api-response.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import { ownerFromRequest } from "./session.js";
import { assertNoQuery, parseBody, pathValue } from "./private-api.js";
const defaults = () => ({
    authorize: ownerFromRequest,
    resolveServices: () => ({ publications: resolveTask9Services().publications })
});
const revokeResponseSchema = {
    parse(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1 || value.revoked !== true)
            throw new Error("invalid revoke response");
        return { revoked: true };
    }
};
export const createPublicationHandlers = (dependencies = defaults()) => ({
    publish: async (request) => {
        try {
            dependencies.authorize(request);
            assertNoQuery(request);
            const noteId = pathValue(request, "noteId", NoteIdSchema);
            const body = await parseBody(request, PublishNoteRequestSchema);
            const result = await dependencies.resolveServices().publications.publish({ noteId, expectedVersion: body.expectedVersion });
            return typedJson({ publicId: result.publicId, publishedAt: result.publishedAt }, PublicationResponseSchema);
        }
        catch (error) {
            return errorResponse(error);
        }
    },
    revoke: async (request) => {
        try {
            dependencies.authorize(request);
            assertNoQuery(request);
            const publicId = pathValue(request, "publicId", PublicIdSchema);
            return typedJson(await dependencies.resolveServices().publications.revoke({ publicId }), revokeResponseSchema);
        }
        catch (error) {
            return errorResponse(error);
        }
    }
});
const runtime = createPublicationHandlers();
export const publishNoteHandler = runtime.publish;
export const revokePublicationHandler = runtime.revoke;
//# sourceMappingURL=publications.js.map