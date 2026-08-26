import { PublicIdSchema, type PublicNoteResponse } from "@nxt/contracts";
import { Download } from "lucide-react";

type PublicAsset = PublicNoteResponse["assets"][number];

export interface PublicAttachmentProps {
  readonly publicId: string;
  readonly asset: PublicAsset;
}

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const PublicAttachment = ({ publicId, asset }: PublicAttachmentProps): React.JSX.Element => {
  const parsedPublicId = PublicIdSchema.safeParse(publicId);
  const parsedAssetId = PublicIdSchema.safeParse(asset.assetId);
  if (!parsedPublicId.success || !parsedAssetId.success) return <div role="status">Attachment unavailable</div>;
  const expected = `/api/public/assets/${parsedPublicId.data}/${parsedAssetId.data}`;
  if (asset.url !== expected) return <div role="status">Attachment unavailable</div>;
  const inlineImage = asset.disposition === "inline" && INLINE_IMAGES.has(asset.mimeType);
  const inlinePdf = asset.disposition === "inline" && asset.mimeType === "application/pdf";

  if (inlineImage) return <img className="public-asset-image" src={expected} alt={asset.name} loading="lazy" />;
  if (inlinePdf) return <object className="public-asset-pdf" data={expected} type="application/pdf" aria-label={asset.name} />;
  return (
    <a className="public-asset-download touch-target" href={expected} download aria-label={`Download ${asset.name}`}>
      <Download size={18} aria-hidden />
      <span>{asset.name}</span>
    </a>
  );
};
