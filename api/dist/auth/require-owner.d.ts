export interface OwnerIdentity {
    readonly provider: "github";
    readonly userId: string;
    readonly userDetails: string;
}
export interface RequireOwnerInput {
    readonly header: string | null;
    readonly host: string;
    readonly environment: string;
    readonly allowedUser: string;
    readonly localBypass: boolean;
}
export declare const requireOwner: (input: RequireOwnerInput) => OwnerIdentity;
//# sourceMappingURL=require-owner.d.ts.map