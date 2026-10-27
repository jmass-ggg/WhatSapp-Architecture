import { Download, FileText, Image as ImageIcon, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchMatrixMedia } from "../../services/matrix/media";
import type { Attachment } from "../../types";

interface AttachmentCardProps {
  attachment: Attachment;
  matrixToken?: string | null;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 1) return "Attachment";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function AttachmentCard({ attachment, matrixToken }: AttachmentCardProps) {
  const [mediaSource, setMediaSource] = useState<string | null>(attachment.url ?? null);
  const [loadError, setLoadError] = useState(false);
  const isImage = attachment.kind === "image";

  useEffect(() => {
    setLoadError(false);
    if (!attachment.mediaUri || !matrixToken) {
      setMediaSource(attachment.url ?? null);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    void fetchMatrixMedia(matrixToken, attachment.mediaUri)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setMediaSource(objectUrl);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.mediaUri, attachment.url, matrixToken]);

  if (isImage) {
    return (
      <div className="attachment-image">
        {mediaSource ? (
          <img
            src={mediaSource}
            alt={attachment.name}
            loading="lazy"
            onError={() => setLoadError(true)}
          />
        ) : (
          <div className="attachment-image-placeholder">
            {loadError ? <ImageIcon size={22} /> : <LoaderCircle size={22} className="spin" />}
            <span>{loadError ? "Image unavailable" : "Loading image…"}</span>
          </div>
        )}
        <span className="attachment-image-caption">
          <ImageIcon size={14} />
          {attachment.name}
          {attachment.demoOnly && <small>DEMO</small>}
        </span>
      </div>
    );
  }

  return (
    <div className="attachment-file">
      <span className="attachment-file-icon">
        <FileText size={20} />
      </span>
      <span className="attachment-file-copy">
        <strong>{attachment.name}</strong>
        <small>
          {attachment.mimeType?.split("/").at(-1)?.toUpperCase() ?? "FILE"}
          <span>·</span>
          {formatBytes(attachment.size)}
          {attachment.demoOnly && <em> · demo preview</em>}
        </small>
      </span>
      {mediaSource && attachment.mediaUri && (
        <a
          className="attachment-download"
          href={mediaSource}
          download={attachment.name}
          aria-label={`Download ${attachment.name}`}
        >
          <Download size={16} />
        </a>
      )}
    </div>
  );
}
