export interface ClientPrincipal {
    readonly identityProvider: string;
    readonly userDetails: string;
    readonly userRoles: readonly string[];
    readonly userId: string;
}
export declare class ClientPrincipalDecodeError extends Error {
    constructor();
}
export declare const decodeClientPrincipal: (header: string | null) => ClientPrincipal | null;
//# sourceMappingURL=client-principal.d.ts.map