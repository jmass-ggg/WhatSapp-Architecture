import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";

import { CHANNEL_CATEGORIES } from "./channelMeta";
import type { Channel, ChannelCategory, ChannelCreateInput, ChannelUpdateInput } from "../../types";

interface CreateChannelDialogProps {
  open: boolean;
  /** When set, the dialog edits this channel instead of creating one. */
  channel?: Channel | null;
  client: MatrixClient | null;
  onClose: () => void;
  onCreate: (input: ChannelCreateInput) => Promise<void>;
  onUpdate?: (channelId: string, input: ChannelUpdateInput) => Promise<void>;
}

const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

export function CreateChannelDialog({ open, channel, client, onClose, onCreate, onUpdate }: CreateChannelDialogProps) {
  const editing = Boolean(channel);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ChannelCategory>("general");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  // One idempotency key per dialog session: a double-click or retry reuses it, so the backend
  // returns the same community instead of creating a second one.
  const requestKey = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setDescription(channel?.description ?? "");
    setCategory(channel?.category ?? "general");
    setAvatarFile(null);
    setError("");
    setStatus("");
    setBusy(false);
    requestKey.current = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [channel, open]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose, open]);

  if (!open) return null;

  const chooseAvatar = (file: File | null) => {
    setError("");
    if (!file) return;
    if (!AVATAR_TYPES.has(file.type)) {
      setError("Community avatars must be PNG, JPEG or WebP images.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError("Community avatars must be 2 MB or smaller.");
      return;
    }
    setAvatarFile(file);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Enter a community name of at least two characters.");
      return;
    }
    if (trimmed.length > 80) {
      setError("Community names must be 80 characters or fewer.");
      return;
    }
    if (description.length > 500) {
      setError("Descriptions must be 500 characters or fewer.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let avatar_url: string | undefined;
      if (avatarFile) {
        if (!client) throw new Error("Wait for the messaging connection before uploading an avatar.");
        setStatus("Uploading avatar…");
        const uploaded = await client.uploadContent(avatarFile, { type: avatarFile.type });
        avatar_url = uploaded.content_uri;
      }
      setStatus(editing ? "Saving community…" : "Creating community…");
      if (editing && channel && onUpdate) {
        const patch: ChannelUpdateInput = {};
        if (trimmed !== channel.name) patch.name = trimmed;
        if (description.trim() !== channel.description) patch.description = description.trim();
        if (category !== channel.category) patch.category = category;
        if (avatar_url) patch.avatar_url = avatar_url;
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        await onUpdate(channel.id, patch);
      } else {
        await onCreate({
          name: trimmed,
          description: description.trim(),
          category,
          request_id: requestKey.current,
          ...(avatar_url ? { avatar_url } : {}),
        });
      }
    } catch (cause) {
      setError(errorMessage(cause, editing ? "The community could not be updated." : "The community could not be created."));
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <div
      className="modal-backdrop new-chat-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="new-chat-dialog channel-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title">
        <header className="new-chat-dialog-header">
          <div>
            <span className="eyebrow">{editing ? "EDIT COMMUNITY" : "NEW COMMUNITY"}</span>
            <h2 id="channel-dialog-title">{editing ? "Edit community" : "Create a community"}</h2>
            <p>
              {editing
                ? "Update how the community appears to its members."
                : "Anyone can join a community. You become its owner and can post announcements."}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={19} />
          </button>
        </header>
        <form
          className="channel-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="channel-form-avatar">
            <label className="channel-avatar-picker" htmlFor="channel-avatar-input" aria-label="Community avatar">
              {avatarPreview ? <img src={avatarPreview} alt="" /> : <ImagePlus size={22} aria-hidden="true" />}
            </label>
            <input
              id="channel-avatar-input"
              type="file"
              className="sr-only"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => chooseAvatar(event.target.files?.[0] ?? null)}
            />
            <div>
              <strong>Avatar (optional)</strong>
              <span>PNG, JPEG or WebP up to 2 MB.</span>
            </div>
          </div>
          <label className="group-name-field">
            <span>Community name</span>
            <input
              ref={nameRef}
              aria-label="Community name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder="e.g. Engineering Team or Weekend Gamers"
              disabled={busy}
            />
          </label>
          <label className="group-name-field">
            <span>Description</span>
            <textarea
              aria-label="Community description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="What is this community about?"
              disabled={busy}
            />
          </label>
          <label className="group-name-field">
            <span>Category</span>
            <select aria-label="Community category" value={category} onChange={(event) => setCategory(event.target.value as ChannelCategory)} disabled={busy}>
              {CHANNEL_CATEGORIES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          {error && <p className="dialog-error" role="alert">{error}</p>}
          {status && <p className="form-notice" role="status">{status}</p>}
          <div className="channel-form-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || name.trim().length < 2}>
              {busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create community"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
