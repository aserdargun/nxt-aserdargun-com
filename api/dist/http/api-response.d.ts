import type { HttpResponseInit } from "@azure/functions";
import type { ApiError } from "@nxt/contracts";
type ApiErrorCode = ApiError["error"]["code"];
export declare class ApiResponseError extends Error {
    readonly code: ApiErrorCode;
    readonly status: number;
    constructor(code: ApiErrorCode);
}
export declare const json: (value: unknown, status?: number) => HttpResponseInit;
export declare const errorResponse: (error: unknown, suppliedRequestId?: string) => HttpResponseInit;
export {};
//# sourceMappingURL=api-response.d.ts.map