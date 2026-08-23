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
    async assertInside(fileId) {
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
                file = await this.storage.get(currentId);
            }
            catch {
                throw new Error("missing parent in file ancestry");
            }
            if (file.trashed) {
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
    async get(fileId) {
        await this.assertInside(fileId);
        return this.storage.get(fileId);
    }
    async listChildren(input) {
        await this.assertInside(input.parentId);
        const page = await this.storage.listChildren(input);
        for (const file of page.files) {
            await this.assertInside(file.id);
        }
        return page;
    }
    async readText(fileId) {
        await this.assertInside(fileId);
        return this.storage.readText(fileId);
    }
    async readBytes(fileId) {
        await this.assertInside(fileId);
        return this.storage.readBytes(fileId);
    }
    async createFolder(input) {
        await this.assertInside(input.parentId);
        const file = await this.storage.createFolder(input);
        await this.assertInside(file.id);
        return file;
    }
    async createText(input) {
        await this.assertInside(input.parentId);
        const file = await this.storage.createText(input);
        await this.assertInside(file.id);
        return file;
    }
    async createBytes(input) {
        await this.assertInside(input.parentId);
        const file = await this.storage.createBytes(input);
        await this.assertInside(file.id);
        return file;
    }
    async updateText(input) {
        await this.assertInside(input.fileId);
        return this.storage.updateText(input);
    }
    async move(input) {
        await this.assertInside(input.fileId);
        await this.assertInside(input.fromParentId);
        await this.assertInside(input.toParentId);
        const file = await this.storage.move(input);
        await this.assertInside(file.id);
        return file;
    }
    async trash(fileId) {
        await this.assertInside(fileId);
        return this.storage.trash(fileId);
    }
    async listRevisions(fileId) {
        await this.assertInside(fileId);
        return this.storage.listRevisions(fileId);
    }
}
const assertFileId = (fileId) => {
    if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH) {
        throw new Error("invalid file ID");
    }
};
//# sourceMappingURL=root-boundary.js.map