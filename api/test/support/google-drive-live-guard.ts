export interface LiveDriveChild {
  id: string;
  mimeType: string;
  parentIds: string[];
  trashed: boolean;
}

export const assertDirectActiveIntegrationChildren = (
  files: ReadonlyArray<LiveDriveChild>,
  integrationFolderId: string,
  seenFileIds: Set<string>
): void => {
  for (const file of files) {
    if (
      file.id.length === 0 ||
      file.id.length > 512 ||
      hasC0OrC1Control(file.id) ||
      seenFileIds.has(file.id) ||
      file.trashed ||
      file.mimeType === "application/vnd.google-apps.shortcut" ||
      file.parentIds.length !== 1 ||
      file.parentIds[0] !== integrationFolderId
    ) {
      throw new Error("Live Drive integration child verification failed.");
    }
    seenFileIds.add(file.id);
  }
};

const hasC0OrC1Control = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 31 || (code >= 127 && code <= 159))
    ) {
      return true;
    }
  }
  return false;
};
