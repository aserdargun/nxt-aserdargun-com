import { ArchiveNoteRequestSchema, CreateNoteRequestSchema, MoveNoteRequestSchema, NoteIdSchema, UpdateNoteRequestSchema } from "@nxt/contracts";
import { json } from "../http/api-response.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, parseBody, pathValue } from "./private-api.js";
const responseNote = (result) => ({
    note: { frontmatter: result.note.frontmatter, body: result.note.body },
    source: result.source,
    version: result.version,
    path: result.path,
    checksum: result.checksum
});
export const createNoteHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    createNote: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseBody(request, CreateNoteRequestSchema);
        const result = await services.vault.createNote({ ...body, folderId: dependencies.idCodec.decode(body.folderId) });
        return json(responseNote(result), 201);
    }),
    getNote: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const noteId = pathValue(request, "noteId", NoteIdSchema);
        return json(responseNote(await services.vault.getNote(noteId)));
    }),
    updateNote: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const noteId = pathValue(request, "noteId", NoteIdSchema);
        const body = await parseBody(request, UpdateNoteRequestSchema);
        return json(responseNote(await services.vault.updateNote({ noteId, ...body })));
    }),
    trashNote: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const noteId = pathValue(request, "noteId", NoteIdSchema);
        const body = await parseBody(request, ArchiveNoteRequestSchema);
        return json(await services.vault.trashNote({ noteId, ...body }));
    }),
    moveNote: (request) => handlePrivate(request, dependencies, async (services) => {
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
    archiveNote: (request) => handlePrivate(request, dependencies, async (services) => {
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
//# sourceMappingURL=notes.js.map