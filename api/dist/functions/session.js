import { requireOwner } from "../auth/require-owner.js";
import { errorResponse, json } from "../http/api-response.js";
export const ownerFromRequest = (request) => {
    let url;
    try {
        url = new URL(request.url);
    }
    catch {
        return requireOwner({
            header: request.headers.get("x-ms-client-principal"),
            host: "",
            environment: process.env.NODE_ENV ?? "production",
            allowedUser: process.env.NXT_ALLOWED_GITHUB_USER ?? "",
            localBypass: false
        });
    }
    return requireOwner({
        header: request.headers.get("x-ms-client-principal"),
        host: url.username.length === 0 && url.password.length === 0 ? url.host : "",
        environment: process.env.NODE_ENV ?? "production",
        allowedUser: process.env.NXT_ALLOWED_GITHUB_USER ?? "",
        localBypass: process.env.NXT_LOCAL_AUTH_BYPASS === "1"
    });
};
export const sessionHandler = (request) => {
    try {
        const owner = ownerFromRequest(request);
        return json({ owner: { provider: owner.provider, username: owner.userDetails } });
    }
    catch (error) {
        return errorResponse(error);
    }
};
//# sourceMappingURL=session.js.map