import type { HttpResponseInit } from "@azure/functions";
export type PublicRequestRelease = () => void;
export declare class PublicRequestGate {
    private readonly options;
    private active;
    private readonly admittedAt;
    constructor(options: {
        maxConcurrent: number;
        maxRequests: number;
        windowMs: number;
        now?: () => number;
    });
    tryAcquire(): PublicRequestRelease | null;
}
export declare const publicRequestGate: PublicRequestGate;
export declare const publicHeaders: (requestId: string, contentType?: string) => Record<string, string>;
export declare const newPublicRequestId: () => string;
export declare const publicNotFound: (requestId: string) => HttpResponseInit;
export declare const hasNoQuery: (requestUrl: string) => boolean;
//# sourceMappingURL=public-http.d.ts.map