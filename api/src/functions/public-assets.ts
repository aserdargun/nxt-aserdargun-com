import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { PublicIdSchema } from "@nxt/contracts";
import { rfc5987AttachmentFilename } from "../services/attachment-policy.js";
import type { PublicPublicationReader } from "../services/publication-service.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import { hasNoQuery, newPublicRequestId, publicHeaders, publicNotFound } from "./public-http.js";

export interface PublicAssetDependencies {
  resolveReader(): Pick<PublicPublicationReader, "getAsset">;
}

const defaults = (): PublicAssetDependencies => ({ resolveReader: () => resolveTask9Services().reader });

export const createPublicAssetHandler = (dependencies: PublicAssetDependencies = defaults()) => async (request: HttpRequest): Promise<HttpResponseInit> => {
  const requestId = newPublicRequestId();
  try {
    if (!hasNoQuery(request.url)) return publicNotFound(requestId);
    const publicId = PublicIdSchema.parse(request.params.publicId);
    const assetId = PublicIdSchema.parse(request.params.assetId);
    const delivery = await dependencies.resolveReader().getAsset(publicId, assetId);
    const headers = publicHeaders(requestId, delivery.mimeType);
    if (delivery.disposition === "download") headers["content-disposition"] = `attachment; filename*=UTF-8''${rfc5987AttachmentFilename(delivery.name)}`;
    return { status: 200, headers, body: delivery.bytes };
  } catch {
    return publicNotFound(requestId);
  }
};

export const publicAssetHandler = createPublicAssetHandler();
