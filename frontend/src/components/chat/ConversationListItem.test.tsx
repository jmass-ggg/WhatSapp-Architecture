import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation } from "../../types";
import { ConversationListItem } from "./ConversationListItem";

afterEach(cleanup);

it("marks a group invitation in the conversation list", () => {
  const conversation = {
    id: "!group:localhost",
    name: "Development Team",
    initials: "DT",
    accent: 0,
    lastMessage: "No messages yet",
    updatedAt: new Date(0),
    unreadCount: 0,
    messages: [],
    isGroup: true,
    isInvited: true,
  } as Conversation;

  render(
    <ConversationListItem
      conversation={conversation}
      selected={false}
      onSelect={vi.fn()}
    />,
  );

  expect(screen.getByText("Development Team")).toBeTruthy();
  expect(screen.getByLabelText("Group conversation")).toBeTruthy();
  expect(screen.getByText("Invited")).toBeTruthy();
  expect(screen.getByText("No messages yet")).toBeTruthy();
});

it("shows a single sent check for the current user's group preview", () => {
  const conversation = {
    id: "!group:localhost",
    name: "Development Team",
    initials: "DT",
    accent: 0,
    lastMessage: "You: Hello",
    updatedAt: new Date(1_750_000_000_000),
    unreadCount: 0,
    messages: [],
    isGroup: true,
    lastMessageDelivery: "sent",
  } as Conversation;
  const view = render(
    <ConversationListItem
      conversation={conversation}
      selected={false}
      onSelect={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Sent")).toBeTruthy();
  expect(view.container.querySelectorAll(".preview-check")).toHaveLength(1);
  expect(view.container.querySelector(".lucide-check-check")).toBeNull();
});

it("does not mark an unacknowledged group preview as sent", () => {
  const conversation = {
    id: "!group:localhost",
    name: "Development Team",
    initials: "DT",
    accent: 0,
    lastMessage: "You: Sending",
    lastMessageDelivery: "sending",
    updatedAt: new Date(1_750_000_000_000),
    unreadCount: 0,
    messages: [],
    isGroup: true,
  } as Conversation;
  const view = render(
    <ConversationListItem
      conversation={conversation}
      selected={false}
      onSelect={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Sending")).toBeTruthy();
  expect(screen.queryByLabelText("Sent")).toBeNull();
  expect(view.container.querySelector(".lucide-check")).toBeNull();
});
