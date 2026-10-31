import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation, UserConnection, UserProfile } from "../../types";
import { ConversationSidebar } from "./ConversationSidebar";

afterEach(cleanup);

const user = {
  id: "me", username: "maya", profile: { display_name: "Maya Chen", profile_picture_url: null },
} as unknown as UserProfile;

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: "!r:localhost", name: "Room", initials: "R", accent: 0, lastMessage: "hello",
  updatedAt: new Date(), unreadCount: 0, messages: [], ...over,
});

function setup(conversations: Conversation[], incomingRequests: UserConnection[] = []) {
  const handlers = {
    onSelect: vi.fn(), onAcceptRequest: vi.fn(), onDeclineRequest: vi.fn(),
    onNewChat: vi.fn(), onNewGroup: vi.fn(), onSignOut: vi.fn(),
  };
  render(
    <ConversationSidebar
      conversations={conversations} currentUser={user} matrixSession={null}
      incomingRequests={incomingRequests} requestsLoading={false} requestError={null}
      respondingRequestId={null} {...handlers}
    />,
  );
  return handlers;
}

it("shows the profile, separate direct and group lists, and no encryption controls", () => {
  setup([
    conversation({ id: "!d:localhost", name: "Alice", unreadCount: 3 }),
    conversation({ id: "!g:localhost", name: "Design team", isGroup: true }),
  ]);
  expect(screen.getByText("Maya Chen")).toBeTruthy();
  expect(screen.getByText("@maya")).toBeTruthy();
  const direct = screen.getByRole("region", { name: "Direct messages" });
  const groups = screen.getByRole("region", { name: "Groups" });
  expect(within(direct).getByText("Alice")).toBeTruthy();
  expect(within(direct).getByLabelText("3 unread messages")).toBeTruthy();
  expect(within(groups).getByText("Design team")).toBeTruthy();
  expect(screen.queryByLabelText(/encrypt|device/i)).toBeNull();
});

it("filters conversations by search and reports empty states", () => {
  setup([conversation({ id: "!d:localhost", name: "Alice" }), conversation({ id: "!g:localhost", name: "Team", isGroup: true })]);
  fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "ali" } });
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.queryByText("Team")).toBeNull();
  expect(screen.getByText("No matches.")).toBeTruthy();
});

it("exposes new chat, create group, select and logout actions", () => {
  const handlers = setup([conversation({ id: "!d:localhost", name: "Alice" })]);
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Create group" }));
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  fireEvent.click(screen.getByText("Alice"));
  expect(handlers.onNewChat).toHaveBeenCalled();
  expect(handlers.onNewGroup).toHaveBeenCalled();
  expect(handlers.onSignOut).toHaveBeenCalled();
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
