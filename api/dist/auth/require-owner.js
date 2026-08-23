import { decodeClientPrincipal } from "./client-principal.js";
import { ApiResponseError } from "../http/api-response.js";
export const requireOwner = (input) => {
    if (input.localBypass === true &&
        isLocalEnvironment(input.environment) &&
        isLoopbackHost(input.host)) {
        return { provider: "github", userId: "local-bypass", userDetails: requireConfiguredOwner(input.allowedUser) };
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
    if (normalize(principal.identityProvider) !== "github" || !principal.userRoles.includes("authenticated")) {
        throw new ApiResponseError("FORBIDDEN");
    }
    const canonicalOwner = requireConfiguredOwner(input.allowedUser);
    if (normalize(principal.userDetails) !== normalize(canonicalOwner)) {
        throw new ApiResponseError("FORBIDDEN");
    }
    return {
        provider: "github",
        userId: principal.userId.trim(),
        userDetails: canonicalOwner
    };
};
const normalize = (value) => value.trim().toLowerCase();
const requireConfiguredOwner = (allowedUser) => {
    const canonicalOwner = allowedUser.trim();
    if (canonicalOwner.length === 0) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    return canonicalOwner;
};
const isLocalEnvironment = (environment) => {
    if (!/^[A-Za-z\t\n\r ]+$/u.test(environment)) {
        return false;
    }
    const normalized = environment.trim().toLowerCase();
    return normalized === "development" || normalized === "test";
};
const isLoopbackHost = (host) => {
    const match = /^([Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/u.exec(host);
    if (match === null) {
        return false;
    }
    const hostname = match[1];
    if (hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname?.toLowerCase() !== "localhost") {
        return false;
    }
    const port = match[2];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
};
//# sourceMappingURL=require-owner.js.map