import { PublicIdSchema, PublicNoteResponseSchema, type PublicNoteResponse } from "@nxt/contracts";
import { requestOptionalJson } from "./client";

export interface PublicClient {
  getNote(publicId: string): Promise<PublicNoteResponse | null>;
}

const publicNotePath = (publicId: string): `/api/public/notes/${string}` =>
  `/api/public/notes/${PublicIdSchema.parse(publicId)}`;

export const publicClient: PublicClient = {
  getNote: (publicId) => requestOptionalJson(
    publicNotePath(publicId),
    PublicNoteResponseSchema,
    undefined,
    { method: "GET", cache: "no-store" }
  )
};
