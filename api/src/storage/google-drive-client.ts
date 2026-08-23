import { google } from "googleapis";

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
    ): Promise<{ data: unknown }>;
    list(input: GoogleDriveListInput): Promise<{ data: unknown }>;
    create(input: GoogleDriveCreateInput): Promise<{ data: unknown }>;
    update(input: GoogleDriveUpdateInput): Promise<{ data: unknown }>;
  };
  revisions: {
    list(input: GoogleDriveRevisionListInput): Promise<{ data: unknown }>;
  };
}

export interface GoogleDriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

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
  return google.drive({ version: "v3", auth });
};

const assertCredential = (value: string): void => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Google Drive credentials are incomplete.");
  }
};
