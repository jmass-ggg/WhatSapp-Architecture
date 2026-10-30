import {
  FilePlus2,
  Paperclip,
  SendHorizontal,
  Smile,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { Message } from "../../types";
import { validateAttachment } from "../../services/matrix/attachments";

const EmojiPicker = lazy(() =>
  import("./EmojiPicker").then((module) => ({ default: module.EmojiPicker })),
);

interface MessageComposerProps {
  disabled?: boolean;
  attachmentsDisabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  onSend: (text: string, file?: File) => Promise<void>;
  typingClient?: MatrixClient | null;
  typingRoomId?: string;
  typingAllowed?: boolean;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  uploadStatus?: string;
}

export function MessageComposer({
  disabled = false,
  attachmentsDisabled = false,
  busy = false,
  placeholder = "Write a message…",
  hint = "Enter to send · Shift + Enter for a new line",
  onSend,
  typingClient,
  typingRoomId,
  typingAllowed = false,
  replyTo,
  onCancelReply,
  uploadStatus,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiAnchorRef = useRef<HTMLDivElement>(null);
  const pendingEmojiSelection = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isBusy = busy || sending;
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingActive = useRef(false);
  const typingTarget = useRef<{ client: MatrixClient; roomId: string } | null>(null);
  const closeEmojiPicker = useCallback(() => setEmojiOpen(false), []);

  useLayoutEffect(() => {
    const input = textareaRef.current;
    const selection = pendingEmojiSelection.current;
    if (!input || selection === null) return;
    input.setSelectionRange(selection, selection);
    pendingEmojiSelection.current = null;
  }, [value]);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const stopTyping = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    inactivityTimer.current = null;
    refreshTimer.current = null;
    if (typingActive.current && typingTarget.current) {
      const { client, roomId } = typingTarget.current;
      void client.sendTyping(roomId, false, 0).catch(() => {});
    }
    typingActive.current = false;
    typingTarget.current = null;
  }, []);

  useEffect(() => stopTyping, [stopTyping, typingClient, typingRoomId, typingAllowed, disabled, isBusy]);

  function updateTyping(text: string) {
    if (!text.trim() || disabled || isBusy || !typingAllowed || !typingClient || !typingRoomId) {
      stopTyping();
      return;
    }
    const client = typingClient;
    const roomId = typingRoomId;
    if (!typingActive.current) {
      typingActive.current = true;
      typingTarget.current = { client, roomId };
      void client.sendTyping(roomId, true, 5000).catch(() => {});
    }
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(stopTyping, 2500);
    if (!refreshTimer.current) {
      refreshTimer.current = setInterval(() => {
        if (typingActive.current && typingTarget.current?.client === client && typingTarget.current.roomId === roomId) {
          void client.sendTyping(roomId, true, 5000).catch(() => {});
        }
      }, 4000);
    }
  }

  async function submit() {
    const text = value.trim();
    if (
      (!text && !file) ||
      disabled ||
      isBusy ||
      (file !== undefined && attachmentsDisabled)
    ) return;
    setError("");
    setSending(true);
    try {
      await onSend(text, file);
      stopTyping();
      setValue("");
      setFile(undefined);
      if (fileRef.current) fileRef.current.value = "";
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your message could not be sent. Try again.",
      );
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    void validateAttachment(selected).then(() => { setFile(selected); setError(""); }).catch((cause: Error) => {
      setError(cause.message);
      event.target.value = "";
    });
  }

  function insertEmoji(emoji: string) {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
    pendingEmojiSelection.current = start + emoji.length;
    setValue(next);
    updateTyping(next);
  }

  return (
    <div className="composer-wrap">
      {replyTo && <div className="reply-preview composer-reply-preview"><strong>Replying to {replyTo.sender === "me" ? "You" : replyTo.senderName || "Unknown"}</strong><span>{replyTo.text || replyTo.attachment?.name || "Message"}</span><button type="button" aria-label="Cancel reply" onClick={onCancelReply}><X size={15} /></button></div>}
      {error && <p className="composer-error" role="alert">{error}</p>}
      {uploadStatus && <p role="status">{uploadStatus}</p>}
      {file && (
        <div className="pending-attachment">
          {filePreview ? <img src={filePreview} alt="Selected attachment preview" className="pending-attachment-preview" /> : <FilePlus2 size={16} />}
          <span>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB</span>
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={() => {
              setFile(undefined);
              if (fileRef.current) fileRef.current.value = "";
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <form className="message-composer" onSubmit={handleSubmit}>
        <div className="composer-tools">
          <div className="emoji-anchor" ref={emojiAnchorRef}>
            <button
              className={`composer-tool${emojiOpen ? " is-active" : ""}`}
              type="button"
              aria-label="Choose emoji"
              aria-haspopup="dialog"
              aria-controls="emoji-picker-dialog"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((open) => !open)}
              disabled={disabled || isBusy}
            >
              <Smile size={20} />
            </button>
          </div>
          {emojiOpen && (
            <Suspense fallback={null}>
              <EmojiPicker
                open
                disabled={disabled || isBusy}
                anchorRef={emojiAnchorRef}
                onClose={closeEmojiPicker}
                onSelect={insertEmoji}
              />
            </Suspense>
          )}
          {!attachmentsDisabled && (
            <>
              <button
                className="composer-tool"
                type="button"
                aria-label="Attach a file"
                onClick={() => fileRef.current?.click()}
                disabled={disabled || isBusy}
              >
                <Paperclip size={20} />
              </button>
              <input
                ref={fileRef}
                className="sr-only"
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.txt,.xls,.xlsx,.csv,.ppt,.pptx"
                onChange={handleFile}
                aria-label="Choose a file to attach"
                disabled={disabled || isBusy}
              />
            </>
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            updateTyping(event.target.value);
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 132)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          aria-label="Write a message"
          disabled={disabled || isBusy}
        />
        <button
          type="submit"
          className="send-button"
          disabled={disabled || isBusy || (!value.trim() && !file)}
          aria-label="Send message"
          title="Send message"
        >
          <SendHorizontal size={19} />
        </button>
      </form>
      <span className="composer-hint">{hint}</span>
    </div>
  );
}
