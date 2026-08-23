import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type OwnerIdentity } from "../auth/require-owner.js";
export declare const ownerFromRequest: (request: HttpRequest) => OwnerIdentity;
export declare const sessionHandler: (request: HttpRequest) => HttpResponseInit;
//# sourceMappingURL=session.d.ts.map