import { SessionResponseSchema, type SessionResponse } from "@nxt/contracts";
import { requestJson } from "./client";

export const getSession = (): Promise<SessionResponse> =>
  requestJson("/api/private/session", SessionResponseSchema, undefined, {
    method: "GET"
  });
