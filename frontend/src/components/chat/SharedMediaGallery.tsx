import { ChevronLeft, ChevronRight, Download, ImageOff, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MAX_ATTACHMENT_BYTES } from "../../services/matrix/attachments";
import { fetchMatrixMedia, fetchMatrixThumbnail } from "../../services/matrix/media";
import type { SharedAttachment } from "../../services/matrix/sharedContent";

interface SharedMediaGalleryProps {
  items: SharedAttachment[];
  token?: string | null;
  /** Number of thumbnails shown before "Show all". */
  previewCount?: number;
}

function Thumbnail({ item, token }: { item: SharedAttachment; token?: string | null }) {
  const [src, setSrc] = useState<string | null>(item.attachment.url ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const { mediaUri } = item.attachment;
    if (!mediaUri || !token) {
      setSrc(item.attachment.url ?? null);
      return undefined;
    }
    let active = true;
    let objectUrl: string | null = null;
    fetchMatrixThumbnail(token, mediaUri)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.attachment, token]);

  if (failed || (!src && !item.attachment.mediaUri)) {
    return <span className="media-thumb-state" role="img" aria-label="Image unavailable"><ImageOff size={18} /></span>;
  }
  if (!src) {
    return <span className="media-thumb-state" role="status" aria-label="Loading image"><LoaderCircle size={18} className="spin" /></span>;
  }
  return <img src={src} alt={item.attachment.name} loading="lazy" onError={() => setFailed(true)} />;
}

function ImageViewer({
  items, index, token, onIndex, onClose,
}: { items: SharedAttachment[]; index: number; token?: string | null; onIndex: (index: number) => void; onClose: () => void }) {
  const item = items[index];
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    const { mediaUri, url } = item.attachment;
    if (!mediaUri || !token) {
      if (url) setSrc(url);
      else setFailed(true);
      return undefined;
    }
    let active = true;
    let objectUrl: string | null = null;
    // The full-size file is only fetched once the viewer is opened.
    fetchMatrixMedia(token, mediaUri, MAX_ATTACHMENT_BYTES)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: item.attachment.mimeType || "image/png" }));
        setSrc(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.attachment, token]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (event.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, items.length, onClose, onIndex]);

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={`Image ${item.attachment.name}`}>
      <div className="image-viewer-backdrop" onClick={onClose} />
      <div className="image-viewer-bar">
        <span className="image-viewer-title">{item.attachment.name} · {index + 1} of {items.length}</span>
        {src && (
          <a className="header-icon-button" href={src} download={item.attachment.name} aria-label={`Download ${item.attachment.name}`}>
            <Download size={20} />
          </a>
        )}
        <button ref={closeRef} type="button" className="header-icon-button" aria-label="Close image viewer" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="image-viewer-stage">
        {index > 0 && (
          <button type="button" className="image-viewer-nav is-prev" aria-label="Previous image" onClick={() => onIndex(index - 1)}>
            <ChevronLeft size={24} />
          </button>
        )}
        {src ? (
          <img src={src} alt={item.attachment.name} />
        ) : failed ? (
          <p className="image-viewer-state" role="alert"><ImageOff size={22} /> This image could not be loaded.</p>
        ) : (
          <p className="image-viewer-state" role="status"><LoaderCircle size={22} className="spin" /> Loading image…</p>
        )}
        {index < items.length - 1 && (
          <button type="button" className="image-viewer-nav is-next" aria-label="Next image" onClick={() => onIndex(index + 1)}>
            <ChevronRight size={24} />
          </button>
        )}
      </div>
    </div>
  );
}

export function SharedMediaGallery({ items, token, previewCount = 4 }: SharedMediaGalleryProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const visible = expanded ? items : items.slice(0, previewCount);

  if (items.length === 0) return <p className="info-empty">No shared media in loaded history.</p>;

  return (
    <>
      <div className="media-grid">
        {visible.map((item, index) => (
          <button
            key={item.eventId}
            type="button"
            className="media-thumb"
            aria-label={`Open image ${item.attachment.name}`}
            onClick={() => setViewerIndex(index)}
          >
            <Thumbnail item={item} token={token} />
          </button>
        ))}
      </div>
      {items.length > previewCount && (
        <button type="button" className="info-link-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
      {viewerIndex !== null && items[viewerIndex] && (
        <ImageViewer
          items={visible}
          index={viewerIndex}
          token={token}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  );
}
