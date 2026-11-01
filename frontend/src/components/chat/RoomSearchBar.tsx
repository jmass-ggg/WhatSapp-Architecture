import { History, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

interface RoomSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

/** Searches messages already loaded in the room; older history can be fetched on demand. */
export function RoomSearchBar({ value, onChange, onClose, canLoadOlder, loadingOlder, onLoadOlder }: RoomSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="room-search-bar" role="search">
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Search messages in this conversation"
        aria-label="Search messages in this conversation"
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      />
      <span id={hintId} className="room-search-hint">
        Searches loaded messages only.
      </span>
      {canLoadOlder && (
        <button type="button" className="room-search-load" onClick={onLoadOlder} disabled={loadingOlder}>
          {loadingOlder ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <History size={15} aria-hidden="true" />}
          {loadingOlder ? "Loading…" : "Load older messages"}
        </button>
      )}
      <button type="button" className="header-icon-button" aria-label="Close search" onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  );
}
