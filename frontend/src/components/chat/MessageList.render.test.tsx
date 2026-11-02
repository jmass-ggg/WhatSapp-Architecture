import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "../../types";
import { MessageList, type MessageListHandle } from "./MessageList";

// Each MessageBubble renders exactly one UserAvatar (ownAvatar is supplied), so avatar renders
// count bubble renders without instrumenting production code.
let avatarRenders = 0;
vi.mock("../UserAvatar", () => ({
  UserAvatar: () => {
    avatarRenders += 1;
    return <span data-avatar />;
  },
}));

afterEach(() => {
  avatarRenders = 0;
});

function message(eventId: string, sender: "me" | "them", text: string): Message {
  return {
    id: eventId, sender, text, delivery: "sent", sentAt: new Date(1_750_000_000_000),
    matrix: { eventId, roomId: "!room:localhost", eventType: "m.room.message", senderId: sender === "me" ? "@self:localhost" : "@peer:localhost" },
  };
}

function conversation(messages: Message[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id: "!room:localhost", roomId: "!room:localhost", name: "Peer", initials: "P", accent: 0,
    isTyping: false, lastMessage: "", updatedAt: new Date(0), unreadCount: 0, messages, bio: "", isGroup: false,
    ...extra,
  } as Conversation;
}

const ref = createRef<MessageListHandle>();
const noop = () => undefined;
const session = { access_token: "t", user_id: "@self:localhost", device_id: "d", home_server: null, expires_in_ms: null };
const loadNone = async (): Promise<Message> => { throw new Error("none"); };
const ownAvatar = { name: "Self" };

function list(current: Conversation) {
  return (
    <MessageList
      ref={ref}
      conversation={current}
      matrixSession={session}
      searchTerm=""
      searchOpen={false}
      ownAvatar={ownAvatar}
      onReply={noop}
      onRetry={noop}
      onMentionClick={noop}
      onToggleStar={noop}
      onLoadMessage={loadNone}
      onJumpError={noop}
    />
  );
}

describe("MessageList render work", () => {
  it("mounts each bubble once and re-renders none on a typing-only update", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`$m${i}`, i % 2 ? "me" : "them", `m${i}`));
    const view = render(list(conversation(messages)));
    expect(avatarRenders).toBe(20);
    avatarRenders = 0;
    act(() => { view.rerender(list(conversation(messages, { isTyping: true, typingNames: ["Peer"] }))); });
    expect(avatarRenders).toBe(0);
    expect(view.container.querySelector(".typing-row")).not.toBeNull();
  });

  it("renders only the new bubble when a message is appended with stable identities", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`$m${i}`, "them", `m${i}`));
    const view = render(list(conversation(messages)));
    avatarRenders = 0;
    act(() => { view.rerender(list(conversation([...messages, message("$new", "them", "new")]))); });
    expect(avatarRenders).toBe(1);
    expect(view.container.querySelectorAll("article[data-event-id]")).toHaveLength(21);
  });

  it("re-renders a bubble whose message object changed and keeps timeline order", () => {
    const messages = [message("$a", "them", "a"), message("$b", "me", "b"), message("$c", "them", "c")];
    const view = render(list(conversation(messages)));
    avatarRenders = 0;
    const read = { ...messages[1], delivery: "read" as const };
    // Deliberately out of timestamp order: the list must keep the conversation's timeline order.
    const reordered = [messages[0], { ...read, sentAt: new Date(1_750_000_999_000) }, messages[2]];
    act(() => { view.rerender(list(conversation(reordered))); });
    expect(avatarRenders).toBe(1);
    expect([...view.container.querySelectorAll("article[data-event-id]")].map((a) => a.getAttribute("data-event-id")))
      .toEqual(["$a", "$b", "$c"]);
  });
});
