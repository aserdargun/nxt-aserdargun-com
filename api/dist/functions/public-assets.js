import { PublicIdSchema } from "@nxt/contracts";
import { rfc5987AttachmentFilename } from "../services/attachment-policy.js";
import { resolveTask9Services } from "../services/runtime-services.js";
import { hasNoQuery, newPublicRequestId, publicHeaders, publicNotFound } from "./public-http.js";
const defaults = () => ({ resolveReader: () => resolveTask9Services().reader });
export const createPublicAssetHandler = (dependencies = defaults()) => async (request) => {
    const requestId = newPublicRequestId();
    try {
        if (!hasNoQuery(request.url))
            return publicNotFound(requestId);
        const publicId = PublicIdSchema.parse(request.params.publicId);
        const assetId = PublicIdSchema.parse(request.params.assetId);
        const delivery = await dependencies.resolveReader().getAsset(publicId, assetId);
        const headers = publicHeaders(requestId, delivery.mimeType);
        if (delivery.disposition === "download")
            headers["content-disposition"] = `attachment; filename*=UTF-8''${rfc5987AttachmentFilename(delivery.name)}`;
        return { status: 200, headers, body: delivery.bytes };
    }
    catch {
        return publicNotFound(requestId);
    }
};
export const publicAssetHandler = createPublicAssetHandler();
//# sourceMappingURL=public-assets.js.map