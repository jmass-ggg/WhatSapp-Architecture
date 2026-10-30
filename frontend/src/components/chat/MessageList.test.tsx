import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { Conversation } from "../../types";
import { MessageList } from "./MessageList";

afterEach(cleanup);

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
