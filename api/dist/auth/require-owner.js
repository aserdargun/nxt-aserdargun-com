import { decodeClientPrincipal } from "./client-principal.js";
import { ApiResponseError } from "../http/api-response.js";
export const requireOwner = (input) => {
    const canonicalOwner = input.allowedUser.trim();
    if (canonicalOwner.length === 0) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    if (input.localBypass === true &&
        input.environment.trim().toLowerCase() !== "production" &&
        isLoopbackHost(input.host)) {
        return { provider: "github", userId: "local-bypass", userDetails: canonicalOwner };
    }
    let principal;
    try {
        principal = decodeClientPrincipal(input.header);
    }
    catch {
        throw new ApiResponseError("UNAUTHORIZED");
    }
    if (principal === null) {
        throw new ApiResponseError("UNAUTHORIZED");
    }
    const providerMatches = normalize(principal.identityProvider) === "github";
    const userMatches = normalize(principal.userDetails) === normalize(canonicalOwner);
    const roleMatches = principal.userRoles.includes("authenticated");
    if (!providerMatches || !userMatches || !roleMatches) {
        throw new ApiResponseError("FORBIDDEN");
    }
    return {
        provider: "github",
        userId: principal.userId.trim(),
        userDetails: canonicalOwner
    };
};
const normalize = (value) => value.trim().toLowerCase();
const isLoopbackHost = (host) => {
    const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/iu.exec(host);
    if (match === null) {
        return false;
    }
    const port = match[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
};
//# sourceMappingURL=require-owner.js.map