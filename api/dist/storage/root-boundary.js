import { assertStorageVersion, StorageOperationBudgetExceededError } from "./storage-port.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_FILE_ID_LENGTH = 512;
const MAX_ANCESTRY_NODES = 100;
const unsupported = () => Promise.reject(new Error("unsupported in root-boundary test storage"));
const createTestStorage = (input) => {
    const trashed = new Set(input.trashed);
    const shortcuts = new Set(input.shortcuts);
    return {
        get: (fileId) => {
            const parentIds = input.graph[fileId];
            if (parentIds === undefined) {
                return Promise.reject(new Error("missing file"));
            }
            return Promise.resolve({
                id: fileId,
                name: fileId,
                mimeType: shortcuts.has(fileId) ? SHORTCUT_MIME_TYPE : parentIds.length === 0 ? FOLDER_MIME_TYPE : "text/plain",
                parentIds: [...parentIds],
                version: "1",
                modifiedTime: "1970-01-01T00:00:00.000Z",
                size: 0,
                trashed: trashed.has(fileId)
            });
        },
        listChildren: unsupported,
        readText: unsupported,
        readBytes: unsupported,
        createFolder: unsupported,
        createText: unsupported,
        createBytes: unsupported,
        updateText: unsupported,
        move: unsupported,
        trash: unsupported,
        listRevisions: unsupported
    };
};
export class RootBoundaryStorage {
    storage;
    allowedRootId;
    constructor(storage, allowedRootId) {
        this.storage = storage;
        this.allowedRootId = allowedRootId;
        assertFileId(allowedRootId);
    }
    static forTest(input) {
        return new RootBoundaryStorage(createTestStorage(input), input.allowedRootId);
    }
    async assertInside(fileId, context) {
        let currentId = fileId;
        const visited = new Set();
        for (let nodes = 0; nodes < MAX_ANCESTRY_NODES; nodes += 1) {
            assertFileId(currentId);
            if (visited.has(currentId)) {
                throw new Error("cycle in file ancestry");
            }
            visited.add(currentId);
            let file;
            try {
                file = await this.storage.get(currentId, context);
            }
            catch (error) {
                if (error instanceof StorageOperationBudgetExceededError)
                    throw error;
                throw new Error("missing parent in file ancestry", { cause: error });
            }
            if (file.id !== currentId) {
                throw new Error("file identity does not match ancestry request");
            }
            if (file.trashed && context?.allowTrashed !== true) {
                throw new Error("trashed file is outside configured root");
            }
            if (file.mimeType === SHORTCUT_MIME_TYPE) {
                throw new Error("shortcut is not allowed in configured root");
            }
            if (currentId === this.allowedRootId) {
                if (file.parentIds.length !== 0) {
                    throw new Error("configured root has parent ancestry");
                }
                return;
            }
            if (file.parentIds.length === 0) {
                throw new Error("file is outside configured root");
            }
            if (file.parentIds.length !== 1) {
                throw new Error("ambiguous ancestry");
            }
            currentId = file.parentIds[0];
        }
        throw new Error("ancestry limit exceeded");
    }
    async get(fileId, context) {
        await this.assertInside(fileId, context);
        return this.storage.get(fileId, context);
    }
    async listChildren(input, context) {
        await this.assertInside(input.parentId, context);
        const page = await this.storage.listChildren(input, context);
        for (const file of page.files) {
            await this.assertInside(file.id, context);
        }
        return page;
    }
    async readText(fileId, context) {
        await this.assertInside(fileId, context);
        return this.storage.readText(fileId, context);
    }
    async readBytes(fileId, context) {
        await this.assertInside(fileId, context);
        return this.storage.readBytes(fileId, context);
    }
    async createFolder(input, context) {
        await this.assertInside(input.parentId, context);
        const file = await this.storage.createFolder(input, context);
        await this.assertInside(file.id, context);
        return file;
    }
    async createText(input, context) {
        await this.assertInside(input.parentId, context);
        const file = await this.storage.createText(input, context);
        await this.assertInside(file.id, context);
        return file;
    }
    async createBytes(input, context) {
        await this.assertInside(input.parentId, context);
        const file = await this.storage.createBytes(input, context);
        await this.assertInside(file.id, context);
        return file;
    }
    async updateText(input, context) {
        assertStorageVersion(input.expectedVersion);
        await this.assertInside(input.fileId, context);
        const file = await this.storage.updateText(input, context);
        if (file.id !== input.fileId) {
            throw new Error("updated file identity changed");
        }
        await this.assertReturnedInside(file, context);
        await this.assertInside(file.id, context);
        return file;
    }
    async move(input, context) {
        assertStorageVersion(input.expectedVersion);
        await this.assertInside(input.fileId, context);
        await this.assertInside(input.fromParentId, context);
        await this.assertInside(input.toParentId, context);
        const file = await this.storage.move(input, context);
        await this.assertInside(file.id, context);
        return file;
    }
    async trash(fileId, context) {
        await this.assertInside(fileId, context);
        return this.storage.trash(fileId, context);
    }
    async listRevisions(fileId, context) {
        await this.assertInside(fileId, context);
        return this.storage.listRevisions(fileId, context);
    }
    async assertReturnedInside(file, context) {
        assertFileId(file.id);
        if (file.trashed && context?.allowTrashed !== true) {
            throw new Error("trashed file is outside configured root");
        }
        if (file.mimeType === SHORTCUT_MIME_TYPE) {
            throw new Error("shortcut is not allowed in configured root");
        }
        if (file.id === this.allowedRootId) {
            if (file.parentIds.length !== 0) {
                throw new Error("configured root has parent ancestry");
            }
            return;
        }
        if (file.parentIds.length !== 1) {
            throw new Error("ambiguous ancestry");
        }
        await this.assertInside(file.parentIds[0], context);
    }
}
const assertFileId = (fileId) => {
    if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH) {
        throw new Error("invalid file ID");
    }
};
//# sourceMappingURL=root-boundary.js.map