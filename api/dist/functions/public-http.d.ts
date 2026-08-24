import type { HttpResponseInit } from "@azure/functions";
export declare const publicHeaders: (requestId: string, contentType?: string) => Record<string, string>;
export declare const newPublicRequestId: () => string;
export declare const publicNotFound: (requestId: string) => HttpResponseInit;
export declare const hasNoQuery: (requestUrl: string) => boolean;
//# sourceMappingURL=public-http.d.ts.map