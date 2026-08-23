import { createRequire } from "node:module";
import { URL } from "node:url";

const requireFromApiPackage = createRequire(
  new URL("../api/package.json", import.meta.url)
);

export const loadGoogleApisFromApiPackage = async () =>
  requireFromApiPackage("googleapis");
