import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  CreateFolderRequestSchema,
  DeleteFolderRequestSchema,
  DriveIdSchema,
  UpdateFolderRequestSchema
} from "@nxt/contracts";
import { json } from "../http/api-response.js";
import type { StoredFile } from "../storage/storage-port.js";
import {
  assertNoQuery,
  defaultPrivateHandlerDependencies,
  handlePrivate,
  parseBody,
  pathValue,
  type PrivateHandlerDependencies
} from "./private-api.js";

const folderResponse = (file: StoredFile, dependencies: PrivateHandlerDependencies): object => ({
  id: dependencies.idCodec.encode(file.id),
  name: file.name,
  version: file.version
});

export const createFolderHandlers = (dependencies: PrivateHandlerDependencies = defaultPrivateHandlerDependencies()) => ({
  createFolder: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const body = await parseBody(request, CreateFolderRequestSchema);
    const result = await services.vault.createFolder({ ...body, parentId: dependencies.idCodec.decode(body.parentId) });
    return json(folderResponse(result, dependencies), 201);
  }),
  updateFolder: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const folderRef = pathValue(request, "folderId", DriveIdSchema);
    const body = await parseBody(request, UpdateFolderRequestSchema);
    const result = await services.vault.renameFolder({
      folderId: dependencies.idCodec.decode(folderRef),
      expectedVersion: body.expectedVersion,
      name: body.name
    });
    return json(folderResponse(result, dependencies));
  }),
  deleteFolder: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const folderRef = pathValue(request, "folderId", DriveIdSchema);
    const body = await parseBody(request, DeleteFolderRequestSchema);
    return json(await services.vault.trashFolder({
      folderId: dependencies.idCodec.decode(folderRef),
      expectedTreeVersion: body.expectedTreeVersion,
      ...(body.confirmationToken === undefined ? {} : { confirmationToken: body.confirmationToken })
    }));
  })
});

const defaults = createFolderHandlers();
export const createFolderHandler = defaults.createFolder;
export const updateFolderHandler = defaults.updateFolder;
export const deleteFolderHandler = defaults.deleteFolder;
