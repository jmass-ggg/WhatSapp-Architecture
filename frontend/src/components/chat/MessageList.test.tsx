import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "../../types";
import { MessageList, type MessageListHandle } from "./MessageList";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function mockScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

function message(eventId: string, text: string): Message {
  return {
    id: eventId,
    sender: "them",
    senderName: "Kelly Boyle",
    text,
    sentAt: new Date("2026-10-30T15:07:00.000Z"),
    delivery: "sent",
    matrix: {
      eventId,
      roomId: "!room:localhost",
      eventType: "m.room.encrypted",
      senderId: "@kelly:localhost",
    },
  };
}

function conversation(messages: Message[] = []): Conversation {
  return {
    id: "!room:localhost",
    name: "Kelly Boyle",
    initials: "KB",
    accent: 0,
    lastMessage: "",
    updatedAt: new Date(),
    unreadCount: 0,
    messages,
    isEncrypted: true,
  };
}

describe("message jump navigation", () => {
  it("centers a loaded message and briefly highlights the exact event", async () => {
    const scrollIntoView = mockScrollIntoView();
    const ref = { current: null } as React.RefObject<MessageListHandle | null>;
    render(
      <MessageList
        ref={ref}
        conversation={conversation([message("$loaded", "Loaded message")])}
        matrixSession={null}
        searchTerm=""
        searchOpen={false}
      />,
    );

    await act(async () => ref.current?.jumpTo("$loaded"));
    const target = document.querySelector('[data-event-id="$loaded"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(target?.classList.contains("message-jump-highlight")).toBe(true);
  });

  it("loads an older exact target, renders it, then highlights and centers it", async () => {
    const target = message("$older-event", "Loaded from old timeline");
    const onLoadMessage = vi.fn().mockResolvedValue(target);
    const scrollIntoView = mockScrollIntoView();
    const ref = { current: null } as React.RefObject<MessageListHandle | null>;
    render(
      <MessageList
        ref={ref}
        conversation={conversation([message("$recent", "Recent message")])}
        matrixSession={null}
        searchTerm=""
        searchOpen={false}
        onLoadMessage={onLoadMessage}
      />,
    );

    await act(async () => ref.current?.jumpTo("$older-event"));
    expect(onLoadMessage).toHaveBeenCalledWith("$older-event");
    expect(screen.getByText("Loaded from old timeline")).toBeTruthy();
    expect(document.querySelector('[data-event-id="$older-event"]')?.classList.contains("message-jump-highlight")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("surfaces an error when the original event is missing", async () => {
    const onJumpError = vi.fn();
    const onLoadMessage = vi.fn().mockRejectedValue(new Error("That message is unavailable."));
    const ref = { current: null } as React.RefObject<MessageListHandle | null>;
    render(
      <MessageList
        ref={ref}
        conversation={conversation()}
        matrixSession={null}
        searchTerm=""
        searchOpen={false}
        onLoadMessage={onLoadMessage}
        onJumpError={onJumpError}
      />,
    );

    await act(async () => ref.current?.jumpTo("$missing"));
    expect(onJumpError).toHaveBeenCalledWith("That message is unavailable.");
  });

  it("uses the same jump path from a quoted reply", async () => {
    const onLoadMessage = vi.fn().mockResolvedValue(message("$quoted-original", "Original text"));
    const reply = {
      ...message("$reply", "A reply"),
      replyTo: {
        eventId: "$quoted-original",
        sender: "Kelly Boyle",
        text: "Original text",
      },
    };
    render(
      <MessageList
        conversation={conversation([reply])}
        matrixSession={null}
        searchTerm=""
        searchOpen={false}
        onLoadMessage={onLoadMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Kelly BoyleOriginal text/i }));
    expect(onLoadMessage).toHaveBeenCalledWith("$quoted-original");
    await waitFor(() => {
      expect(document.querySelector('[data-event-id="$quoted-original"]')).toBeTruthy();
    });
  });
});

it("names group members in typing indicators and preserves direct typing text", () => {
  const group = {
    id: "!group:localhost",
    name: "Development Team",
    initials: "DT",
    accent: 0,
    lastMessage: "No messages yet",
    updatedAt: new Date(0),
    unreadCount: 0,
    messages: [],
    isGroup: true,
    isTyping: true,
    typingNames: ["Alice", "Bob"],
  } as Conversation;
  const props = {
    conversation: group,
    matrixSession: null,
    searchTerm: "",
    searchOpen: true,
  };
  const view = render(<MessageList {...props} />);

  expect(screen.getByText("Alice and Bob are typing…")).toBeTruthy();
  view.rerender(
    <MessageList
      {...props}
      conversation={{ ...group, isGroup: false, name: "Alice", typingNames: [] }}
    />,
  );
  expect(screen.getByText("Alice is typing…")).toBeTruthy();
});
