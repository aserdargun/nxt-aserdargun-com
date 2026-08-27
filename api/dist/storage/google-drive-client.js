import { google } from "googleapis";
export const GOOGLE_DRIVE_INTEGRATION_FOLDER_FIELDS = "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress)";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_FILE_ID_LENGTH = 512;
export const assertPrivateIntegrationFolderMetadata = (value, settings) => {
    const { privateFolderId, integrationFolderId, notesFolderId } = settings;
    const ids = [privateFolderId, integrationFolderId, notesFolderId];
    if (!ids.every(isSafeDriveId) ||
        new Set(ids).size !== ids.length ||
        !isRecord(value)) {
        throw integrationFolderError();
    }
    const permissions = value.permissions;
    if (value.id !== integrationFolderId ||
        value.name !== "integration-tests" ||
        value.mimeType !== FOLDER_MIME_TYPE ||
        value.trashed !== false ||
        value.ownedByMe !== true ||
        !Array.isArray(value.parents) ||
        value.parents.length !== 1 ||
        value.parents[0] !== privateFolderId ||
        !Array.isArray(permissions) ||
        !permissions.some((permission) => isRecord(permission) &&
            permission.type === "user" &&
            permission.role === "owner")) {
        throw integrationFolderError();
    }
};
export const createGoogleDriveClient = (credentials) => {
    assertCredential(credentials.clientId);
    assertCredential(credentials.clientSecret);
    assertCredential(credentials.refreshToken);
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });
    return wrapGoogleDriveClient(google.drive({ version: "v3", auth }), google.drive({ version: "v2", auth }));
};
export const wrapGoogleDriveClient = (raw, rawV2) => ({
    files: {
        get: (input, options) => raw.files.get(input, { ...options, retry: false }),
        getVersion: (fileId) => rawV2.files.get({
            fileId,
            fields: "id,etag,version",
            updateViewedDate: false
        }, { retry: false }),
        list: (input) => raw.files.list(input, { retry: false }),
        create: (input) => raw.files.create(input, { retry: false }),
        update: (input, options) => {
            const operation = input.media === undefined
                ? rawV2.files.patch.bind(rawV2.files)
                : rawV2.files.update.bind(rawV2.files);
            return operation(toV2PatchInput(input), {
                ...options,
                retry: false
            });
        }
    },
    revisions: {
        list: (input) => raw.revisions.list(input, { retry: false })
    }
});
const toV2PatchInput = (input) => ({
    fileId: input.fileId,
    ...(input.requestBody === undefined
        ? {}
        : {
            requestBody: {
                ...(input.requestBody.mimeType === undefined
                    ? {}
                    : { mimeType: input.requestBody.mimeType }),
                ...(input.requestBody.name === undefined
                    ? {}
                    : { title: input.requestBody.name }),
                ...(input.requestBody.trashed === undefined
                    ? {}
                    : { labels: { trashed: input.requestBody.trashed } })
            }
        }),
    ...(input.media === undefined ? {} : { media: input.media }),
    ...(input.addParents === undefined ? {} : { addParents: input.addParents }),
    ...(input.removeParents === undefined
        ? {}
        : { removeParents: input.removeParents }),
    fields: input.fields
});
const assertCredential = (value) => {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error("Google Drive credentials are incomplete.");
    }
};
const isSafeDriveId = (value) => typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_ID_LENGTH &&
    !/[\r\n\0]/u.test(value);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const integrationFolderError = () => new Error("Google Drive integration folder verification failed.");
//# sourceMappingURL=google-drive-client.js.map