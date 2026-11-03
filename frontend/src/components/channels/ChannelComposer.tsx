import { Image as ImageIcon, Paperclip, Send, SmilePlus, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, type AnnouncementDraft } from "../../services/matrix/channels";
import { validateAttachment } from "../../services/matrix/attachments";

const EmojiPicker = lazy(() => import("../chat/EmojiPicker").then((module) => ({ default: module.EmojiPicker })));

interface ChannelComposerProps {
  channelName: string;
  disabled?: boolean;
  uploadStatus: string;
  onPublish: (draft: AnnouncementDraft) => Promise<void>;
}

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

export function ChannelComposer({ channelName, disabled = false, uploadStatus, onPublish }: ChannelComposerProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chooseFile = async (chosen: File | null) => {
    setError("");
    if (!chosen) return;
    try {
      await validateAttachment(chosen);
      setFile(chosen);
    } catch (cause) {
      setError(errorMessage(cause, "This file cannot be attached."));
    }
  };

  const insertEmoji = useCallback((emoji: string) => {
    const textarea = bodyRef.current;
    setBody((current) => {
      if (!textarea) return `${current}${emoji}`;
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? current.length;
      const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + emoji.length, start + emoji.length);
      });
      return next;
    });
  }, []);

  const canPublish = !disabled && !publishing && (title.trim() || body.trim() || file);

  const submit = async () => {
    if (!canPublish) return;
    setError("");
    setPublishing(true);
    try {
      await onPublish({ title: title.trim(), body: body.trim(), file: file ?? undefined });
      setTitle("");
      setBody("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (cause) {
      setError(errorMessage(cause, "The announcement could not be published."));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <form
      className="channel-composer"
      aria-label={`Publish an announcement to ${channelName}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className="channel-composer-title"
        aria-label="Announcement title"
        placeholder="Announcement title (optional)"
        value={title}
        maxLength={ANNOUNCEMENT_TITLE_MAX}
        disabled={disabled || publishing}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        ref={bodyRef}
        className="channel-composer-body"
        aria-label="Announcement text"
        placeholder="Write an announcement… Use **bold**, bullet lines starting with - and links."
        value={body}
        rows={3}
        maxLength={ANNOUNCEMENT_BODY_MAX}
        disabled={disabled || publishing}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {file && (
        <div className="channel-composer-attachment">
          {preview ? <img src={preview} alt="" /> : <Paperclip size={16} aria-hidden="true" />}
          <span>{file.name}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Remove attachment"
            disabled={publishing}
            onClick={() => {
              setFile(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="channel-composer-toolbar">
        <div className="channel-composer-tools">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            id="channel-composer-file"
            accept="image/png,image/jpeg,image/webp,.pdf,.doc,.docx,.txt,.xls,.xlsx,.csv,.ppt,.pptx"
            disabled={disabled || publishing}
            onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)}
          />
          <label className="composer-tool" htmlFor="channel-composer-file" title="Attach image or file" aria-label="Attach image or file">
            <ImageIcon size={20} aria-hidden="true" />
          </label>
          <button
            ref={emojiButtonRef}
            type="button"
            className={`composer-tool${emojiOpen ? " is-active" : ""}`}
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            disabled={disabled || publishing}
            onClick={() => setEmojiOpen((open) => !open)}
          >
            <SmilePlus size={20} aria-hidden="true" />
          </button>
          {emojiOpen && (
            <Suspense fallback={null}>
              <EmojiPicker open anchorRef={emojiButtonRef} onClose={() => setEmojiOpen(false)} onSelect={insertEmoji} />
            </Suspense>
          )}
          {uploadStatus && <span className="composer-hint" role="status">{uploadStatus}</span>}
          {error && <span className="composer-error" role="alert">{error}</span>}
        </div>
        <button type="submit" className="primary-button channel-publish" disabled={!canPublish}>
          <Send size={16} aria-hidden="true" />
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>
    </form>
  );
}
