export declare const GOOGLE_DRIVE_INTEGRATION_FOLDER_FIELDS = "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress)";
export interface GoogleDriveGetInput {
    fileId: string;
    fields?: string;
    alt?: "media";
}
export interface GoogleDriveListInput {
    q: string;
    spaces: "drive";
    pageSize: number;
    fields: string;
    pageToken?: string;
}
export interface GoogleDriveCreateInput {
    requestBody: {
        name: string;
        mimeType: string;
        parents: string[];
    };
    media?: {
        mimeType: string;
        body: string | Uint8Array;
    };
    fields: "id";
}
export interface GoogleDriveUpdateInput {
    fileId: string;
    requestBody?: {
        mimeType?: string;
        name?: string;
        trashed?: boolean;
    };
    media?: {
        mimeType: string;
        body: string | Uint8Array;
    };
    addParents?: string;
    removeParents?: string;
    fields: "id";
}
export interface GoogleDriveRevisionListInput {
    fileId: string;
    pageSize: number;
    fields: string;
    pageToken?: string;
}
export interface GoogleDriveClient {
    files: {
        get(input: GoogleDriveGetInput, options?: {
            responseType: "arraybuffer";
        }): Promise<{
            data: unknown;
        }>;
        list(input: GoogleDriveListInput): Promise<{
            data: unknown;
        }>;
        create(input: GoogleDriveCreateInput): Promise<{
            data: unknown;
        }>;
        update(input: GoogleDriveUpdateInput): Promise<{
            data: unknown;
        }>;
    };
    revisions: {
        list(input: GoogleDriveRevisionListInput): Promise<{
            data: unknown;
        }>;
    };
}
interface GoogleRequestOptions {
    responseType?: "arraybuffer";
    retry: false;
}
interface RawGoogleDriveClient {
    files: {
        get(input: GoogleDriveGetInput, options: GoogleRequestOptions): Promise<{
            data: unknown;
        }>;
        list(input: GoogleDriveListInput, options: GoogleRequestOptions): Promise<{
            data: unknown;
        }>;
        create(input: GoogleDriveCreateInput, options: GoogleRequestOptions): Promise<{
            data: unknown;
        }>;
        update(input: GoogleDriveUpdateInput, options: GoogleRequestOptions): Promise<{
            data: unknown;
        }>;
    };
    revisions: {
        list(input: GoogleDriveRevisionListInput, options: GoogleRequestOptions): Promise<{
            data: unknown;
        }>;
    };
}
export interface GoogleDriveCredentials {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}
export interface GoogleDriveIntegrationSettings {
    privateFolderId: string;
    integrationFolderId: string;
    notesFolderId: string;
}
export declare const assertPrivateIntegrationFolderMetadata: (value: unknown, settings: GoogleDriveIntegrationSettings) => void;
export declare const createGoogleDriveClient: (credentials: GoogleDriveCredentials) => GoogleDriveClient;
export declare const wrapGoogleDriveClient: (raw: RawGoogleDriveClient) => GoogleDriveClient;
export {};
//# sourceMappingURL=google-drive-client.d.ts.map