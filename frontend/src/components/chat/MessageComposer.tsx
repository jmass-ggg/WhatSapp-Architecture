import {
  FilePlus2,
  Paperclip,
  SendHorizontal,
  Smile,
  X,
} from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

interface MessageComposerProps {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  onSend: (text: string, file?: File) => Promise<void>;
}

const emojis = ["😊", "✨", "❤️", "🙌", "😂", "👍", "🎉", "☀️"];

export function MessageComposer({
  disabled = false,
  busy = false,
  placeholder = "Write a message…",
  hint = "Enter to send · Shift + Enter for a new line",
  onSend,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isBusy = busy || sending;

  async function submit() {
    const text = value.trim();
    if ((!text && !file) || disabled || isBusy) return;
    setError("");
    setSending(true);
    try {
      await onSend(text, file);
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
    setValue((current) => `${current}${emoji}`);
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
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
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
