import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  ArchiveNoteRequestSchema,
  CreateNoteRequestSchema,
  MoveNoteRequestSchema,
  NoteIdSchema,
  UpdateNoteRequestSchema
} from "@nxt/contracts";
import { json } from "../http/api-response.js";
import type { VaultNoteResult } from "../services/vault-service.js";
import {
  assertNoQuery,
  defaultPrivateHandlerDependencies,
  handlePrivate,
  parseBody,
  pathValue,
  type PrivateHandlerDependencies
} from "./private-api.js";

const responseNote = (result: VaultNoteResult): object => ({
  note: { frontmatter: result.note.frontmatter, body: result.note.body },
  source: result.source,
  version: result.version,
  path: result.path,
  checksum: result.checksum
});

export const createNoteHandlers = (dependencies: PrivateHandlerDependencies = defaultPrivateHandlerDependencies()) => ({
  createNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const body = await parseBody(request, CreateNoteRequestSchema);
    const result = await services.vault.createNote({ ...body, folderId: dependencies.idCodec.decode(body.folderId) });
    return json(responseNote(result), 201);
  }),
  getNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const noteId = pathValue(request, "noteId", NoteIdSchema);
    return json(responseNote(await services.vault.getNote(noteId)));
  }),
  updateNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const noteId = pathValue(request, "noteId", NoteIdSchema);
    const body = await parseBody(request, UpdateNoteRequestSchema);
    return json(responseNote(await services.vault.updateNote({ noteId, ...body })));
  }),
  trashNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const noteId = pathValue(request, "noteId", NoteIdSchema);
    const body = await parseBody(request, ArchiveNoteRequestSchema);
    return json(await services.vault.trashNote({ noteId, ...body }));
  }),
  moveNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const noteId = pathValue(request, "noteId", NoteIdSchema);
    const body = await parseBody(request, MoveNoteRequestSchema);
    const result = await services.vault.moveNote({
      noteId,
      expectedVersion: body.expectedVersion,
      folderId: dependencies.idCodec.decode(body.folderId)
    });
    return json(responseNote(result));
  }),
  archiveNote: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const noteId = pathValue(request, "noteId", NoteIdSchema);
    const body = await parseBody(request, ArchiveNoteRequestSchema);
    return json(responseNote(await services.vault.archiveNote({ noteId, ...body })));
  })
});

const defaults = createNoteHandlers();
export const createNoteHandler = defaults.createNote;
export const getNoteHandler = defaults.getNote;
export const updateNoteHandler = defaults.updateNote;
export const trashNoteHandler = defaults.trashNote;
export const moveNoteHandler = defaults.moveNote;
export const archiveNoteHandler = defaults.archiveNote;
