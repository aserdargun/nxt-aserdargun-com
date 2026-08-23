import { google } from "googleapis";
export const createGoogleDriveClient = (credentials) => {
    assertCredential(credentials.clientId);
    assertCredential(credentials.clientSecret);
    assertCredential(credentials.refreshToken);
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });
    return google.drive({ version: "v3", auth });
};
const assertCredential = (value) => {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error("Google Drive credentials are incomplete.");
    }
};
//# sourceMappingURL=google-drive-client.js.map