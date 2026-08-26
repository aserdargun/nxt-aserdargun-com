export interface RuntimeProcessObservation {
    readonly pid: number;
    readonly parentPid: number;
    readonly pgid: number;
    readonly startTime: string;
    readonly cwd: string;
    readonly executable: string;
    readonly command: string;
}
interface RecordedIdentity {
    readonly pid: number;
    readonly pgid: number;
    readonly startTime: string;
    readonly cwd: string;
    readonly executable: string;
    readonly command: string;
}
export declare const inspectRuntimeProcess: (pid: number) => Promise<RuntimeProcessObservation | null>;
export declare const verifyLocalRuntimeOwnership: ({ checkoutPath, fixtureRoot, nonce, currentParentPid, inspectProcess, assertProcessAlive }: {
    readonly checkoutPath: string;
    readonly fixtureRoot: string;
    readonly nonce: string;
    readonly currentParentPid?: number;
    readonly inspectProcess?: (pid: number) => Promise<RuntimeProcessObservation | null>;
    readonly assertProcessAlive?: (pid: number) => void;
}) => Promise<{
    readonly nonce: string;
    readonly functions: RecordedIdentity;
}>;
export {};
//# sourceMappingURL=local-runtime-ownership.d.ts.map