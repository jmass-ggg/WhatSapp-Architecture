import { expect, it } from "vitest";

import { parseStarred, toggleStarred } from "./starred";

it("drops malformed and duplicate entries from account data", () => {
  expect(parseStarred(undefined)).toEqual([]);
  expect(parseStarred({ messages: "nope" })).toEqual([]);
  expect(
    parseStarred({ messages: [{ roomId: "!a", eventId: "$1" }, { roomId: "!a", eventId: "$1" }, { roomId: 4 }, null, { roomId: "!b", eventId: "$2" }] }),
  ).toEqual([{ roomId: "!a", eventId: "$1" }, { roomId: "!b", eventId: "$2" }]);
});

it("toggles a message and keeps stars from different rooms apart", () => {
  const first = toggleStarred([], { roomId: "!a", eventId: "$1" });
  const second = toggleStarred(first, { roomId: "!b", eventId: "$1" });
  expect(second).toHaveLength(2);
  expect(toggleStarred(second, { roomId: "!a", eventId: "$1" })).toEqual([{ roomId: "!b", eventId: "$1" }]);
});
