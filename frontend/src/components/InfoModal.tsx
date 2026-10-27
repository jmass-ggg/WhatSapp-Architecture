import { X } from "lucide-react";
import { useEffect } from "react";

interface InfoModalProps {
  title: string;
  children: string;
  onClose: () => void;
}

export function InfoModal({ title, children, onClose }: InfoModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="info-modal-title"
        aria-modal="true"
        className="info-modal"
        role="dialog"
      >
        <button
          type="button"
          className="modal-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">LUMACHAT</span>
        <h2 id="info-modal-title">{title}</h2>
        <p>{children}</p>
      </section>
    </div>
  );
}
