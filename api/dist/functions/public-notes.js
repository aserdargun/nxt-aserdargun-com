import { PublicIdSchema, PublicNoteResponseSchema } from "@nxt/contracts";
import { resolveTask9Services } from "../services/runtime-services.js";
import { hasNoQuery, newPublicRequestId, publicHeaders, publicNotFound } from "./public-http.js";
const defaults = () => ({ resolveReader: async () => (await resolveTask9Services()).reader });
export const createPublicNoteHandler = (dependencies = defaults()) => async (request) => {
    const requestId = newPublicRequestId();
    try {
        if (!hasNoQuery(request.url))
            return publicNotFound(requestId);
        const publicId = PublicIdSchema.parse(request.params.publicId);
        const reader = await Promise.resolve(dependencies.resolveReader());
        const note = await reader.getNote(publicId);
        if (note === null)
            return publicNotFound(requestId);
        const parsed = PublicNoteResponseSchema.parse(note);
        return {
            status: 200,
            headers: publicHeaders(requestId, "application/json; charset=utf-8"),
            jsonBody: parsed
        };
    }
    catch {
        return publicNotFound(requestId);
    }
};
export const publicNoteHandler = createPublicNoteHandler();
//# sourceMappingURL=public-notes.js.map