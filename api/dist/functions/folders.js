import { CreateFolderRequestSchema, DeleteFolderRequestSchema, FolderResponseSchema, OpaqueIdSchema, TrashResponseSchema, UpdateFolderRequestSchema } from "@nxt/contracts";
import { typedJson } from "../http/api-response.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, parseBody, pathValue } from "./private-api.js";
const folderResponse = async (folderId, dependencies, services) => {
    const tree = await services.vault.vaultTree();
    const folder = tree.folders.find((item) => item.id === folderId);
    if (folder === undefined)
        throw new Error("folder readback missing");
    return {
        id: dependencies.idCodec.encode(folder.id), name: folder.name, path: folder.path,
        version: folder.version, protected: folder.protected,
        ...(folder.deleteConfirmation === undefined ? {} : { deleteConfirmation: folder.deleteConfirmation })
    };
};
export const createFolderHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    createFolder: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseBody(request, CreateFolderRequestSchema);
        const result = await services.vault.createFolder({ ...body, parentId: dependencies.idCodec.decode(body.parentId) });
        return typedJson(await folderResponse(result.id, dependencies, services), FolderResponseSchema, 201);
    }),
    updateFolder: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const folderRef = pathValue(request, "folderId", OpaqueIdSchema);
        const body = await parseBody(request, UpdateFolderRequestSchema);
        const folderId = dependencies.idCodec.decode(folderRef);
        let version = body.expectedVersion;
        if (body.name !== undefined)
            version = (await services.vault.renameFolder({ folderId, expectedVersion: version, name: body.name })).version;
        if (body.parentId !== undefined)
            await services.vault.moveFolder({
                folderId, expectedVersion: version, parentId: dependencies.idCodec.decode(body.parentId)
            });
        return typedJson(await folderResponse(folderId, dependencies, services), FolderResponseSchema);
    }),
    deleteFolder: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const folderRef = pathValue(request, "folderId", OpaqueIdSchema);
        const body = await parseBody(request, DeleteFolderRequestSchema);
        return typedJson(await services.vault.trashFolder({
            folderId: dependencies.idCodec.decode(folderRef),
            expectedTreeVersion: body.expectedTreeVersion,
            ...(body.confirmationToken === undefined ? {} : { confirmationToken: body.confirmationToken })
        }), TrashResponseSchema);
    })
});
const defaults = createFolderHandlers();
export const createFolderHandler = defaults.createFolder;
export const updateFolderHandler = defaults.updateFolder;
export const deleteFolderHandler = defaults.deleteFolder;
//# sourceMappingURL=folders.js.map