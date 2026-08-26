import {
  CreateNoteRequestSchema,
  ArchiveNoteRequestSchema,
  MoveNoteRequestSchema,
  NoteIdSchema,
  NoteResponseSchema,
  TrashResponseSchema,
  UpdateNoteRequestSchema,
  type CreateNoteRequest,
  type ArchiveNoteRequest,
  type MoveNoteRequest,
  type NoteResponse,
  type UpdateNoteRequest
} from "@nxt/contracts";
import { requestJson } from "./client";

export interface NotesClient {
  getNote(noteId: string): Promise<NoteResponse>;
  updateNote(noteId: string, input: UpdateNoteRequest): Promise<NoteResponse>;
  createNote(input: CreateNoteRequest): Promise<NoteResponse>;
  moveNote(noteId: string, input: MoveNoteRequest): Promise<NoteResponse>;
  archiveNote(noteId: string, input: ArchiveNoteRequest): Promise<NoteResponse>;
  trashNote(noteId: string, input: ArchiveNoteRequest): Promise<void>;
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
    }),
  moveNote: (noteId, input) =>
    requestJson(`${notePath(noteId)}/move` as `/api/${string}`, NoteResponseSchema, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MoveNoteRequestSchema.parse(input))
    }),
  archiveNote: (noteId, input) =>
    requestJson(`${notePath(noteId)}/archive` as `/api/${string}`, NoteResponseSchema, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ArchiveNoteRequestSchema.parse(input))
    }),
  trashNote: async (noteId, input) => {
    await requestJson(notePath(noteId), TrashResponseSchema, undefined, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ArchiveNoteRequestSchema.parse(input))
    });
  }
};
