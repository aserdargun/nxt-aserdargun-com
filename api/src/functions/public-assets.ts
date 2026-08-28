import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { PublicIdSchema } from "@nxt/contracts";
import { rfc5987AttachmentFilename } from "../services/attachment-policy.js";
import type { PublicPublicationReader } from "../services/publication-service.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import {
  hasNoQuery,
  newPublicRequestId,
  publicHeaders,
  publicNotFound,
  publicRequestGate,
  type PublicRequestRelease
} from "./public-http.js";

export interface PublicAssetDependencies {
  resolveReader(): Pick<PublicPublicationReader, "getAsset"> | Promise<Pick<PublicPublicationReader, "getAsset">>;
  admit?(): PublicRequestRelease | null;
}

const defaults = (): PublicAssetDependencies => ({
  resolveReader: async () => (await resolveTask9Services()).reader,
  admit: () => publicRequestGate.tryAcquire()
});

export const createPublicAssetHandler = (dependencies: PublicAssetDependencies = defaults()) => async (request: HttpRequest): Promise<HttpResponseInit> => {
  const requestId = newPublicRequestId();
  let release: PublicRequestRelease | null | undefined;
  try {
    if (!hasNoQuery(request.url)) return publicNotFound(requestId);
    const publicId = PublicIdSchema.parse(request.params.publicId);
    const assetId = PublicIdSchema.parse(request.params.assetId);
    release = dependencies.admit?.();
    if (release === null) return publicNotFound(requestId);
    const reader = await Promise.resolve(dependencies.resolveReader());
    const delivery = await reader.getAsset(publicId, assetId);
    const headers = publicHeaders(requestId, delivery.mimeType);
    if (delivery.disposition === "download") headers["content-disposition"] = `attachment; filename*=UTF-8''${rfc5987AttachmentFilename(delivery.name)}`;
    return { status: 200, headers, body: delivery.bytes };
  } catch {
    return publicNotFound(requestId);
  } finally {
    release?.();
  }
};

export const publicAssetHandler = createPublicAssetHandler();
