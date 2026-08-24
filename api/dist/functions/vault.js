import { RescanVaultRequestSchema } from "@nxt/contracts";
import { json } from "../http/api-response.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, parseBody } from "./private-api.js";
export const createVaultHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    getVault: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const [index, preferences, tree] = await Promise.all([
            services.vault.readIndex(),
            services.preferences.read(),
            services.vault.vaultTree()
        ]);
        const folders = await Promise.all(tree.folders.map(async (folder) => ({
            id: dependencies.idCodec.encode(folder.id),
            name: folder.name,
            path: folder.path,
            version: folder.version,
            protected: folder.protected,
            ...(folder.protected ? {} : {
                deleteConfirmation: await services.vault.issueFolderDeleteConfirmation(folder.id)
            })
        })));
        return json({
            index: {
                schemaVersion: 1,
                entries: index.value.entries.map((entry) => ({
                    id: entry.id,
                    title: entry.title,
                    aliases: entry.aliases,
                    path: entry.path,
                    created: entry.created,
                    updated: entry.updated,
                    driveVersion: entry.driveVersion,
                    tags: entry.tags,
                    searchText: entry.searchText,
                    excerpt: entry.excerpt,
                    outboundNoteIds: entry.outboundNoteIds,
                    unresolvedWikiTargets: entry.unresolvedWikiTargets,
                    attachments: entry.attachments.map((attachment) => ({
                        name: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.size
                    })),
                    backlinks: entry.backlinks
                }))
            },
            preferences: preferences.value,
            tree: { treeVersion: tree.treeVersion, folders }
        });
    }),
    rescan: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseBody(request, RescanVaultRequestSchema);
        return json(await services.rescan.scanPage(body));
    })
});
const defaults = createVaultHandlers();
export const getVaultHandler = defaults.getVault;
export const rescanVaultHandler = defaults.rescan;
//# sourceMappingURL=vault.js.map