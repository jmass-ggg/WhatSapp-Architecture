import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation, UserConnection } from "../../types";
import { ConversationSidebar } from "./ConversationSidebar";

afterEach(cleanup);

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: "!r:localhost", name: "Room", initials: "R", accent: 0, lastMessage: "hello",
  updatedAt: new Date(), unreadCount: 0, messages: [], ...over,
});

function setup(
  conversations: Conversation[],
  incomingRequests: UserConnection[] = [],
  tags: { favoriteIds?: Set<string>; pinnedIds?: Set<string> } = {},
) {
  const handlers = {
    onSelect: vi.fn(), onAcceptRequest: vi.fn(), onDeclineRequest: vi.fn(),
    onNewChat: vi.fn(), onNewGroup: vi.fn(),
  };
  render(
    <ConversationSidebar
      conversations={conversations} matrixSession={null} {...tags}
      incomingRequests={incomingRequests} requestsLoading={false} requestError={null}
      respondingRequestId={null} {...handlers}
    />,
  );
  return handlers;
}

it("lists conversations under Recent with real unread badges and no encryption controls", () => {
  setup([
    conversation({ id: "!d:localhost", name: "Alice", unreadCount: 3 }),
    conversation({ id: "!g:localhost", name: "Design team", isGroup: true }),
  ]);
  const recent = screen.getByRole("region", { name: "Recent" });
  expect(within(recent).getByText("Alice")).toBeTruthy();
  expect(within(recent).getByLabelText("3 unread messages")).toBeTruthy();
  expect(within(recent).getByText("Design team")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  expect(screen.queryByLabelText(/encrypt|device/i)).toBeNull();
});

it("separates pinned conversations and marks favorites", () => {
  setup(
    [
      conversation({ id: "!a:localhost", name: "Alice" }),
      conversation({ id: "!b:localhost", name: "Bob" }),
    ],
    [],
    { pinnedIds: new Set(["!a:localhost"]), favoriteIds: new Set(["!b:localhost"]) },
  );
  expect(within(screen.getByRole("region", { name: "Pinned" })).getByText("Alice")).toBeTruthy();
  const recent = screen.getByRole("region", { name: "Recent" });
  expect(within(recent).getByText("Bob")).toBeTruthy();
  expect(within(recent).getByLabelText("Favorite")).toBeTruthy();
});

it("filters by Unread, Favorites and Groups and shows the real unread conversation count", () => {
  setup(
    [
      conversation({ id: "!a:localhost", name: "Alice", unreadCount: 4 }),
      conversation({ id: "!b:localhost", name: "Bob" }),
      conversation({ id: "!g:localhost", name: "Team", isGroup: true, unreadCount: 1 }),
    ],
    [],
    { favoriteIds: new Set(["!b:localhost"]) },
  );
  expect(screen.getByLabelText("2 unread conversations").textContent).toBe("2");

  fireEvent.click(screen.getByRole("button", { name: /Unread/ }));
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.queryByText("Bob")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Favorites/ }));
  expect(screen.getByText("Bob")).toBeTruthy();
  expect(screen.queryByText("Alice")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Groups/ }));
  expect(screen.getByText("Team")).toBeTruthy();
  expect(screen.queryByText("Bob")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("Bob")).toBeTruthy();
});

it("shows no unread badge on the filter when nothing is unread and an honest empty state", () => {
  setup([conversation({ id: "!a:localhost", name: "Alice" })]);
  expect(screen.queryByLabelText(/unread conversations/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Unread/ }));
  expect(screen.getByText("No unread conversations.")).toBeTruthy();
});

it("filters conversations by search and reports empty states", () => {
  setup([conversation({ id: "!d:localhost", name: "Alice" }), conversation({ id: "!g:localhost", name: "Team", isGroup: true })]);
  fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "ali" } });
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.queryByText("Team")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "zzz" } });
  expect(screen.getByText("No matches.")).toBeTruthy();
});

it("exposes new chat, create group and select actions", () => {
  const handlers = setup([conversation({ id: "!d:localhost", name: "Alice" })]);
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Create group" }));
  fireEvent.click(screen.getByText("Alice"));
  expect(handlers.onNewChat).toHaveBeenCalled();
  expect(handlers.onNewGroup).toHaveBeenCalled();
  expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "Alice" }));
});

it("lets the user accept or decline an incoming connection request", () => {
  const request = {
    id: "req1", status: "pending",
    other_user: { id: "u2", username: "bob", profile: { display_name: "Bob" } },
  } as unknown as UserConnection;
  const handlers = setup([], [request]);
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(handlers.onAcceptRequest).toHaveBeenCalledWith(request);
  expect(handlers.onDeclineRequest).toHaveBeenCalledWith(request);
});

it("shows a green dot on an online direct contact only, never on groups", () => {
  setup([
    conversation({ id: "!on:localhost", name: "Alice", presence: "online" }),
    conversation({ id: "!off:localhost", name: "Bob", presence: "offline" }),
    conversation({ id: "!unk:localhost", name: "Cara", presence: "unknown" }),
    conversation({ id: "!g:localhost", name: "Team", isGroup: true }),
  ]);
  expect(screen.getAllByRole("img", { name: "Online" })).toHaveLength(1);
  const alice = screen.getByText("Alice").closest("button")!;
  expect(within(alice).getByRole("img", { name: "Online" })).toBeTruthy();
});
