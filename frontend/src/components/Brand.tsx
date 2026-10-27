import { MessageCircle } from "lucide-react";

interface BrandProps {
  compact?: boolean;
  light?: boolean;
}

export function Brand({ compact = false, light = false }: BrandProps) {
  return (
    <div className={`brand${compact ? " brand-compact" : ""}${light ? " brand-light" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <MessageCircle size={22} strokeWidth={2.5} />
        <span className="brand-mark-dot" />
      </span>
      {!compact && <span className="brand-name">LumaChat</span>}
    </div>
  );
}
