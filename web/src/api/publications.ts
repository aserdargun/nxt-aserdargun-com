import {
  NoteIdSchema,
  PublicationResponseSchema,
  PublicationStatusResponseSchema,
  PublicIdSchema,
  PublishNoteRequestSchema,
  RevokePublicationResponseSchema,
  type PublicationStatus
} from "@nxt/contracts";
import { ApiContractError, requestJson } from "./client";
import { publicClient, type PublicClient } from "./public";

export interface PublicationClient {
  getStatus(noteId: string): Promise<PublicationStatus | null>;
  publish(noteId: string, expectedVersion: string): Promise<PublicationStatus>;
  revoke(publicId: string): Promise<void>;
}

const privateNotePath = (noteId: string): `/api/private/notes/${string}` =>
  `/api/private/notes/${NoteIdSchema.parse(noteId)}`;

export const createPublicationClient = (anonymous: PublicClient = publicClient): PublicationClient => {
  const getStatus = (noteId: string): Promise<PublicationStatus | null> => requestJson(
    `${privateNotePath(noteId)}/share-status` as `/api/${string}`,
    PublicationStatusResponseSchema,
    undefined,
    { method: "GET", cache: "no-store" }
  );

  return {
    getStatus,
    publish: async (noteId, expectedVersion) => {
      const published = await requestJson(
        `${privateNotePath(noteId)}/publish` as `/api/${string}`,
        PublicationResponseSchema,
        undefined,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(PublishNoteRequestSchema.parse({ expectedVersion }))
        }
      );
      const status = await getStatus(noteId);
      if (
        status === null || status.publicId !== published.publicId ||
        status.publishedAt !== published.publishedAt || status.sourceVersion !== expectedVersion
      ) throw new ApiContractError();
      const publicNote = await anonymous.getNote(status.publicId);
      if (
        publicNote === null || publicNote.sourceVersion !== expectedVersion ||
        publicNote.publishedAt !== status.publishedAt
      ) throw new ApiContractError();
      return status;
    },
    revoke: async (publicId) => {
      const id = PublicIdSchema.parse(publicId);
      await requestJson(
        `/api/private/publications/${id}`,
        RevokePublicationResponseSchema,
        undefined,
        { method: "DELETE" }
      );
      if (await anonymous.getNote(id) !== null) throw new ApiContractError();
    }
  };
};

export const publicationClient = createPublicationClient();
