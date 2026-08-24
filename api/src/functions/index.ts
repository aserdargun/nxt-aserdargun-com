import { app } from "@azure/functions";
import type { HttpHandler } from "@azure/functions";
import { createFolderHandler, deleteFolderHandler, updateFolderHandler } from "./folders.js";
import {
  archiveNoteHandler,
  createNoteHandler,
  getNoteHandler,
  moveNoteHandler,
  trashNoteHandler,
  updateNoteHandler
} from "./notes.js";
import { updatePreferencesHandler } from "./preferences.js";
import { sessionHandler } from "./session.js";
import { getVaultHandler, rescanVaultHandler } from "./vault.js";

app.http("private-session", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "private/session",
  handler: sessionHandler
});

export const task7Routes: Array<{
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  route: string;
  authLevel: "anonymous";
  handler: HttpHandler;
}> = [
  { name: "private-vault", method: "GET", route: "private/vault", authLevel: "anonymous", handler: getVaultHandler },
  { name: "private-vault-rescan", method: "POST", route: "private/vault/rescan", authLevel: "anonymous", handler: rescanVaultHandler },
  { name: "private-notes-create", method: "POST", route: "private/notes", authLevel: "anonymous", handler: createNoteHandler },
  { name: "private-notes-get", method: "GET", route: "private/notes/{noteId}", authLevel: "anonymous", handler: getNoteHandler },
  { name: "private-notes-update", method: "PUT", route: "private/notes/{noteId}", authLevel: "anonymous", handler: updateNoteHandler },
  { name: "private-notes-trash", method: "DELETE", route: "private/notes/{noteId}", authLevel: "anonymous", handler: trashNoteHandler },
  { name: "private-notes-move", method: "POST", route: "private/notes/{noteId}/move", authLevel: "anonymous", handler: moveNoteHandler },
  { name: "private-notes-archive", method: "POST", route: "private/notes/{noteId}/archive", authLevel: "anonymous", handler: archiveNoteHandler },
  { name: "private-folders-create", method: "POST", route: "private/folders", authLevel: "anonymous", handler: createFolderHandler },
  { name: "private-folders-update", method: "PUT", route: "private/folders/{folderId}", authLevel: "anonymous", handler: updateFolderHandler },
  { name: "private-folders-delete", method: "DELETE", route: "private/folders/{folderId}", authLevel: "anonymous", handler: deleteFolderHandler },
  { name: "private-preferences-update", method: "PUT", route: "private/preferences", authLevel: "anonymous", handler: updatePreferencesHandler }
];

for (const route of task7Routes) {
  app.http(route.name, {
    methods: [route.method],
    authLevel: route.authLevel,
    route: route.route,
    handler: route.handler
  });
}
