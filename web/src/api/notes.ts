import {
  CreateNoteRequestSchema,
  NoteIdSchema,
  NoteResponseSchema,
  UpdateNoteRequestSchema,
  type CreateNoteRequest,
  type NoteResponse,
  type UpdateNoteRequest
} from "@nxt/contracts";
import { requestJson } from "./client";

export interface NotesClient {
  getNote(noteId: string): Promise<NoteResponse>;
  updateNote(noteId: string, input: UpdateNoteRequest): Promise<NoteResponse>;
  createNote(input: CreateNoteRequest): Promise<NoteResponse>;
}

const notePath = (noteId: string): `/api/private/notes/${string}` =>
  `/api/private/notes/${NoteIdSchema.parse(noteId)}`;

export const notesClient: NotesClient = {
  getNote: (noteId) =>
    requestJson(notePath(noteId), NoteResponseSchema, undefined, { method: "GET" }),
  updateNote: (noteId, input) =>
    requestJson(notePath(noteId), NoteResponseSchema, undefined, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(UpdateNoteRequestSchema.parse(input))
    }),
  createNote: (input) =>
    requestJson("/api/private/notes", NoteResponseSchema, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CreateNoteRequestSchema.parse(input))
    })
};
