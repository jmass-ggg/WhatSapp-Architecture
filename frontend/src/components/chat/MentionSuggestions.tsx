import { useEffect, useRef } from "react";

import { usernameOf, type MentionCandidate } from "../../services/matrix/mentions";

export const MENTION_LISTBOX_ID = "mention-suggestions";
export const mentionOptionId = (userId: string) => `mention-option-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}` : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
};

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

interface MentionSuggestionsProps {
  members: MentionCandidate[];
  query: string;
  activeIndex: number;
  onSelect: (member: MentionCandidate) => void;
  onHover?: (index: number) => void;
}

export function MentionSuggestions({ members, query, activeIndex, onSelect, onHover }: MentionSuggestionsProps) {
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView?.({ block: "nearest" }); }, [activeIndex]);
  return (
    <div className="mention-suggestions">
      <p className="mention-heading" id="mention-heading">Mention someone</p>
      {members.length === 0 ? (
        <p className="mention-empty" role="status">No matching members</p>
      ) : (
        <ul id={MENTION_LISTBOX_ID} role="listbox" aria-labelledby="mention-heading">
          {members.map((member, index) => (
            <li
              key={member.userId}
              id={mentionOptionId(member.userId)}
              ref={index === activeIndex ? activeRef : undefined}
              role="option"
              aria-selected={index === activeIndex}
              aria-label={`${member.name}, @${usernameOf(member.userId)}`}
              className={`mention-option${index === activeIndex ? " is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover?.(index)}
              onClick={() => onSelect(member)}
            >
              <span className="mention-avatar" aria-hidden="true">{initialsOf(member.name)}</span>
              <span className="mention-names">
                <span className="mention-name"><Highlight text={member.name} query={query} /></span>
                <span className="mention-username"><Highlight text={`@${usernameOf(member.userId)}`} query={query} /></span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
