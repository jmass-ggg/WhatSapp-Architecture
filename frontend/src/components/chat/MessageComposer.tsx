import {
  FilePlus2,
  FileText,
  Image as ImageIcon,
  Mic,
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
import { validateAttachment, type VoiceRecording, type VoiceSendAttempt } from "../../services/matrix/attachments";
import { VoiceRecorder } from "./VoiceRecorder";
import { MENTION_LISTBOX_ID, MentionSuggestions, mentionOptionId } from "./MentionSuggestions";
import { adjustMentions, filterMentionCandidates, findMentionTrigger, type MentionCandidate, type MentionEntity } from "../../services/matrix/mentions";

const EmojiPicker = lazy(() =>
  import("./EmojiPicker").then((module) => ({ default: module.EmojiPicker })),
);

function ReplyPreview({ message, onCancel }: { message: Message; onCancel: () => void }) {
  const kind = message.attachment?.kind;
  const who = message.sender === "me" ? "yourself" : message.senderName || "Unknown";
  const excerpt = message.text || (kind === "image" ? "Photo" : kind === "audio" ? "Voice message" : message.attachment?.name) || "Original message unavailable";
  const Icon = kind === "image" ? ImageIcon : kind === "audio" ? Mic : kind ? FileText : null;
  return (
    <div className="composer-reply" role="group" aria-label={`Replying to ${who}`}>
      <span className="composer-reply-accent" aria-hidden="true" />
      <div className="composer-reply-body">
        <strong className="composer-reply-name">Replying to {who}</strong>
        <span className="composer-reply-text">{Icon && <Icon size={13} aria-hidden="true" />}<span>{excerpt}</span></span>
      </div>
      <button type="button" className="composer-reply-cancel" aria-label="Cancel reply" title="Cancel reply" onClick={onCancel}><X size={16} /></button>
    </div>
  );
}

interface MessageComposerProps {
  disabled?: boolean;
  attachmentsDisabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  onSend: (text: string, file?: File, mentions?: MentionEntity[]) => Promise<void>;
  /** Members of the active conversation that may be mentioned. */
  mentionMembers?: MentionCandidate[];
  ownUserId?: string;
  /** Enables the microphone button; must resolve only after the message was acknowledged. */
  onSendVoice?: (recording: VoiceRecording, attempt: VoiceSendAttempt) => Promise<void>;
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
  mentionMembers = [],
  ownUserId,
  onSendVoice,
  typingClient,
  typingRoomId,
  typingAllowed = false,
  replyTo,
  onCancelReply,
  uploadStatus,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<MentionEntity[]>([]);
  const [caret, setCaret] = useState(0);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [file, setFile] = useState<File | undefined>();
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiAnchorRef = useRef<HTMLDivElement>(null);
  const pendingEmojiSelection = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Set when a send started from the composer; consumed once the textarea is enabled again.
  const restoreFocus = useRef<"start" | "end" | null>(null);
  const isBusy = busy || sending || voiceOpen;
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingActive = useRef(false);
  const typingTarget = useRef<{ client: MatrixClient; roomId: string } | null>(null);
  const rawTrigger = findMentionTrigger(value, caret);
  const insideMention = rawTrigger ? mentions.some((m) => rawTrigger.start >= m.start && rawTrigger.start < m.end) : false;
  const trigger = rawTrigger && !insideMention && rawTrigger.start !== dismissedStart && !disabled && !isBusy && mentionMembers.length > 0 ? rawTrigger : null;
  const candidates = trigger ? filterMentionCandidates(mentionMembers, trigger.query, ownUserId) : [];
  // A multi-word query with no match is ordinary prose, not a search.
  const suggestionsOpen = Boolean(trigger) && (candidates.length > 0 || !/\s/.test(trigger!.query));
  const safeIndex = Math.min(activeIndex, Math.max(0, candidates.length - 1));
  const closeEmojiPicker = useCallback(() => setEmojiOpen(false), []);

  useLayoutEffect(() => {
    const input = textareaRef.current;
    const selection = pendingEmojiSelection.current;
    if (!input || selection === null) return;
    input.setSelectionRange(selection, selection);
    pendingEmojiSelection.current = null;
  }, [value]);

  // Restore focus only after the textarea is re-enabled (a disabled element cannot take focus),
  // and never when the user moved focus elsewhere while the send was pending.
  useLayoutEffect(() => {
    const mode = restoreFocus.current;
    if (!mode) return;
    if (disabled) { restoreFocus.current = null; return; }
    if (isBusy) return;
    restoreFocus.current = null;
    const input = textareaRef.current;
    if (!input || input.disabled || input.readOnly) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== input) return;
    input.focus({ preventScroll: true });
    const caretAt = mode === "start" ? 0 : input.value.length;
    input.setSelectionRange(caretAt, caretAt);
    setCaret(caretAt);
  }, [isBusy, disabled]);

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
    const lead = value.length - value.trimStart().length;
    const sendMentions = mentions.map((m) => ({ ...m, start: m.start - lead, end: m.end - lead })).filter((m) => m.start >= 0 && m.end <= text.length);
    if (
      (!text && !file) ||
      disabled ||
      isBusy ||
      (file !== undefined && attachmentsDisabled)
    ) return;
    setError("");
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || active === textareaRef.current || Boolean(active.closest(".message-composer"));
    const resetDraft = () => {
      stopTyping();
      setValue("");
      setMentions([]);
      setDismissedStart(null);
      setFile(undefined);
      if (fileRef.current) fileRef.current.value = "";
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (hadFocus) restoreFocus.current = "start";
    };
    const sendSnapshot = () => (sendMentions.length ? onSend(text, file, sendMentions) : onSend(text, file));
    if (!file) {
      // Text: snapshot taken above; reset now so the next message can be typed immediately.
      // onSend resolves at local acceptance (SDK local echo), not server acknowledgment.
      const draft = { value, mentions };
      resetDraft();
      try {
        await sendSnapshot();
      } catch (cause) {
        // Local submission failed: restore the draft unless the user already started a new one.
        setValue((current) => (current === "" ? draft.value : current));
        setMentions((current) => (current.length === 0 ? draft.mentions : current));
        setError(cause instanceof Error ? cause.message : "Your message could not be sent. Try again.");
        if (hadFocus) restoreFocus.current = "end";
      }
      return;
    }
    setSending(true);
    try {
      await sendSnapshot();
      resetDraft();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your message could not be sent. Try again.",
      );
      if (hadFocus) restoreFocus.current = "end";
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function selectMention(member: MentionCandidate) {
    if (!trigger) return;
    const label = `@${member.name}`;
    const next = `${value.slice(0, trigger.start)}${label} ${value.slice(caret)}`;
    const kept = adjustMentions(mentions, value, next).filter((m) => m.end <= trigger.start || m.start >= trigger.start + label.length + 1);
    const entity: MentionEntity = { userId: member.userId, label, start: trigger.start, end: trigger.start + label.length };
    const position = trigger.start + label.length + 1;
    pendingEmojiSelection.current = position;
    setMentions([...kept, entity].sort((a, b) => a.start - b.start));
    setValue(next);
    setCaret(position);
    setActiveIndex(0);
    updateTyping(next);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    if (!suggestionsOpen) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && (textareaRef.current?.contains(event.target) || (event.target as HTMLElement).closest?.(".mention-suggestions"))) return;
      setDismissedStart(trigger?.start ?? null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [suggestionsOpen, trigger?.start]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestionsOpen) {
      if (event.key === "Escape") { event.preventDefault(); setDismissedStart(trigger!.start); return; }
      if (candidates.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((safeIndex + step + candidates.length) % candidates.length);
          return;
        }
        if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
          event.preventDefault();
          selectMention(candidates[safeIndex]);
          return;
        }
      }
    }
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
      {replyTo && <ReplyPreview message={replyTo} onCancel={() => { onCancelReply?.(); textareaRef.current?.focus(); }} />}
      {error && <p className="composer-error" role="alert">{error}</p>}
      {uploadStatus && !voiceOpen && <p role="status">{uploadStatus}</p>}
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
      {voiceOpen && onSendVoice ? (
        <VoiceRecorder onSend={onSendVoice} onClose={() => setVoiceOpen(false)} status={uploadStatus} />
      ) : (<>
      <div className="composer-mention-anchor">
      {suggestionsOpen && trigger && (
        <MentionSuggestions members={candidates} query={trigger.query} activeIndex={safeIndex} onSelect={selectMention} onHover={setActiveIndex} />
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
          {onSendVoice && (
            <button
              className={`composer-tool${voiceOpen ? " is-active" : ""}`}
              type="button"
              aria-label="Record a voice message"
              title="Record a voice message"
              onClick={() => setVoiceOpen(true)}
              disabled={disabled || isBusy}
            >
              <Mic size={20} />
            </button>
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
            setMentions((current) => adjustMentions(current, value, event.target.value));
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActiveIndex(0);
            setValue(event.target.value);
            updateTyping(event.target.value);
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 132)}px`;
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          role={suggestionsOpen ? "combobox" : undefined}
          aria-autocomplete={suggestionsOpen ? "list" : undefined}
          aria-expanded={suggestionsOpen ? true : undefined}
          aria-controls={suggestionsOpen && candidates.length ? MENTION_LISTBOX_ID : undefined}
          aria-activedescendant={suggestionsOpen && candidates.length ? mentionOptionId(candidates[safeIndex].userId) : undefined}
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
      </div>
      <span className="composer-hint">{hint}</span>
      </>)}
    </div>
  );
}
