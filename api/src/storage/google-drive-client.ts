import { google } from "googleapis";

export const GOOGLE_DRIVE_INTEGRATION_FOLDER_FIELDS =
  "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress)";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_FILE_ID_LENGTH = 512;

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
    get(
      input: GoogleDriveGetInput,
      options?: { responseType: "arraybuffer" }
    ): Promise<{ data: unknown; headers?: unknown }>;
    list(input: GoogleDriveListInput): Promise<{ data: unknown }>;
    create(input: GoogleDriveCreateInput): Promise<{ data: unknown }>;
    update(
      input: GoogleDriveUpdateInput,
      options?: { headers: { "If-Match": string } }
    ): Promise<{ data: unknown }>;
  };
  revisions: {
    list(input: GoogleDriveRevisionListInput): Promise<{ data: unknown }>;
  };
}

interface GoogleRequestOptions {
  responseType?: "arraybuffer";
  retry: false;
  headers?: { "If-Match": string };
}

interface RawGoogleDriveClient {
  files: {
    get(
      input: GoogleDriveGetInput,
      options: GoogleRequestOptions
    ): Promise<{ data: unknown }>;
    list(
      input: GoogleDriveListInput,
      options: GoogleRequestOptions
    ): Promise<{ data: unknown }>;
    create(
      input: GoogleDriveCreateInput,
      options: GoogleRequestOptions
    ): Promise<{ data: unknown }>;
    update(
      input: GoogleDriveUpdateInput,
      options: GoogleRequestOptions
    ): Promise<{ data: unknown }>;
  };
  revisions: {
    list(
      input: GoogleDriveRevisionListInput,
      options: GoogleRequestOptions
    ): Promise<{ data: unknown }>;
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

export const assertPrivateIntegrationFolderMetadata = (
  value: unknown,
  settings: GoogleDriveIntegrationSettings
): void => {
  const { privateFolderId, integrationFolderId, notesFolderId } = settings;
  const ids = [privateFolderId, integrationFolderId, notesFolderId];
  if (
    !ids.every(isSafeDriveId) ||
    new Set(ids).size !== ids.length ||
    !isRecord(value)
  ) {
    throw integrationFolderError();
  }
  const permissions = value.permissions;
  if (
    value.id !== integrationFolderId ||
    value.name !== "integration-tests" ||
    value.mimeType !== FOLDER_MIME_TYPE ||
    value.trashed !== false ||
    value.ownedByMe !== true ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 1 ||
    value.parents[0] !== privateFolderId ||
    !Array.isArray(permissions) ||
    !permissions.some(
      (permission) =>
        isRecord(permission) &&
        permission.type === "user" &&
        permission.role === "owner"
    )
  ) {
    throw integrationFolderError();
  }
};

export const createGoogleDriveClient = (
  credentials: GoogleDriveCredentials
): GoogleDriveClient => {
  assertCredential(credentials.clientId);
  assertCredential(credentials.clientSecret);
  assertCredential(credentials.refreshToken);
  const auth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret
  );
  auth.setCredentials({ refresh_token: credentials.refreshToken });
  return wrapGoogleDriveClient(google.drive({ version: "v3", auth }));
};

export const wrapGoogleDriveClient = (
  raw: RawGoogleDriveClient
): GoogleDriveClient => ({
  files: {
    get: (input, options) =>
      raw.files.get(input, { ...options, retry: false }),
    list: (input) => raw.files.list(input, { retry: false }),
    create: (input) => raw.files.create(input, { retry: false }),
    update: (input, options) => raw.files.update(input, { ...options, retry: false })
  },
  revisions: {
    list: (input) => raw.revisions.list(input, { retry: false })
  }
});

const assertCredential = (value: string): void => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Google Drive credentials are incomplete.");
  }
};

const isSafeDriveId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_FILE_ID_LENGTH &&
  !/[\r\n\0]/u.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const integrationFolderError = (): Error =>
  new Error("Google Drive integration folder verification failed.");
