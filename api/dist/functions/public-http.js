import { randomUUID } from "node:crypto";
export const publicHeaders = (requestId, contentType) => ({
    ...(contentType === undefined ? {} : { "content-type": contentType }),
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId
});
export const newPublicRequestId = () => randomUUID();
export const publicNotFound = (requestId) => ({
    status: 404,
    headers: publicHeaders(requestId, "application/json; charset=utf-8"),
    jsonBody: {
        error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
            requestId
        }
    }
});
export const hasNoQuery = (requestUrl) => {
    try {
        return [...new URL(requestUrl).searchParams].length === 0;
    }
    catch {
        return false;
    }
};
//# sourceMappingURL=public-http.js.map