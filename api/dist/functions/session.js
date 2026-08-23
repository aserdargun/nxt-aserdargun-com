import { requireOwner } from "../auth/require-owner.js";
import { errorResponse, json } from "../http/api-response.js";
export const ownerFromRequest = (request) => {
    return requireOwner({
        header: request.headers.get("x-ms-client-principal"),
        host: request.headers.get("host") ?? "",
        environment: process.env.NODE_ENV ?? "production",
        allowedUser: process.env.NXT_ALLOWED_GITHUB_USER ?? "",
        localBypass: process.env.NXT_LOCAL_AUTH_BYPASS === "1"
    });
};
export const sessionHandler = (request) => {
    try {
        const owner = ownerFromRequest(request);
        const response = { user: { userDetails: owner.userDetails } };
        return json(response);
    }
    catch (error) {
        return errorResponse(error);
    }
};
//# sourceMappingURL=session.js.map