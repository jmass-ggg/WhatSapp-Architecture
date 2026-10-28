import {
  FilePlus2,
  Paperclip,
  SendHorizontal,
  Smile,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { MatrixClient } from "matrix-js-sdk";

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
}

const emojis = ["😊", "✨", "❤️", "🙌", "😂", "👍", "🎉", "☀️"];

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
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isBusy = busy || sending;
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingActive = useRef(false);
  const typingTarget = useRef<{ client: MatrixClient; roomId: string } | null>(null);

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
    setFile(event.target.files?.[0]);
    setError("");
  }

  function appendEmoji(emoji: string) {
    const next = `${value}${emoji}`;
    setValue(next);
    updateTyping(next);
    setEmojiOpen(false);
    textareaRef.current?.focus();
  }

  return (
    <div className="composer-wrap">
      {error && <p className="composer-error" role="alert">{error}</p>}
      {file && (
        <div className="pending-attachment">
          <FilePlus2 size={16} />
          <span>{file.name}</span>
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
          <div className="emoji-anchor">
            <button
              className={`composer-tool${emojiOpen ? " is-active" : ""}`}
              type="button"
              aria-label="Choose emoji"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((open) => !open)}
              disabled={disabled || isBusy}
            >
              <Smile size={20} />
            </button>
            {emojiOpen && (
              <div className="emoji-picker" role="group" aria-label="Choose an emoji">
                {emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`Insert ${emoji}`}
                    disabled={disabled || isBusy}
                    onClick={() => appendEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
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
