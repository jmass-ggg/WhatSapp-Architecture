import { expect, it } from "vitest";

import type { Conversation } from "../types";
import { countUnreadConversations, groupConversations } from "./conversationFilters";

const make = (over: Partial<Conversation>): Conversation => ({
  id: "!r:localhost", name: "Room", initials: "R", accent: 0, lastMessage: "hello",
  updatedAt: new Date(), unreadCount: 0, messages: [], ...over,
});

const list = [
  make({ id: "!a", name: "Alice", unreadCount: 2 }),
  make({ id: "!b", name: "Bob", username: "bobby" }),
  make({ id: "!g", name: "Design Team", isGroup: true, unreadCount: 1, lastMessage: "Alex: new mocks" }),
];
const none = new Set<string>();

it("splits pinned from recent and keeps input order", () => {
  const result = groupConversations(list, { filter: "all", query: "", favoriteIds: none, pinnedIds: new Set(["!b"]) });
  expect(result.pinned.map((c) => c.id)).toEqual(["!b"]);
  expect(result.recent.map((c) => c.id)).toEqual(["!a", "!g"]);
});

it("filters by unread, favorites and groups using real data", () => {
  const base = { query: "", pinnedIds: none };
  expect(groupConversations(list, { ...base, filter: "unread", favoriteIds: none }).recent.map((c) => c.id)).toEqual(["!a", "!g"]);
  expect(groupConversations(list, { ...base, filter: "favorites", favoriteIds: new Set(["!b"]) }).recent.map((c) => c.id)).toEqual(["!b"]);
  expect(groupConversations(list, { ...base, filter: "groups", favoriteIds: none }).recent.map((c) => c.id)).toEqual(["!g"]);
});

it("searches names, usernames and previews case-insensitively", () => {
  const search = (query: string) =>
    groupConversations(list, { filter: "all", query, favoriteIds: none, pinnedIds: none }).recent.map((c) => c.id);
  expect(search("ALI")).toEqual(["!a"]);
  expect(search("bobby")).toEqual(["!b"]);
  expect(search("mocks")).toEqual(["!g"]);
});

it("counts conversations with unread messages, not total messages", () => {
  expect(countUnreadConversations(list)).toBe(2);
  expect(countUnreadConversations([make({})])).toBe(0);
});
