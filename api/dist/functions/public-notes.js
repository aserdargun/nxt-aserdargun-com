import { PublicIdSchema, PublicNoteResponseSchema } from "@nxt/contracts";
import { resolveTask9Services } from "../services/runtime-services.js";
import { hasNoQuery, newPublicRequestId, publicHeaders, publicNotFound, publicRequestGate } from "./public-http.js";
const defaults = () => ({
    resolveReader: async () => (await resolveTask9Services()).reader,
    admit: () => publicRequestGate.tryAcquire()
});
export const createPublicNoteHandler = (dependencies = defaults()) => async (request) => {
    const requestId = newPublicRequestId();
    let release;
    try {
        if (!hasNoQuery(request.url))
            return publicNotFound(requestId);
        const publicId = PublicIdSchema.parse(request.params.publicId);
        release = dependencies.admit?.();
        if (release === null)
            return publicNotFound(requestId);
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
    finally {
        release?.();
    }
};
export const publicNoteHandler = createPublicNoteHandler();
//# sourceMappingURL=public-notes.js.map