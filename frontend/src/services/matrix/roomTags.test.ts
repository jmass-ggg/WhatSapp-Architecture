import { expect, it, vi } from "vitest";

import { FAVOURITE_TAG, PINNED_TAG, readRoomTags, setRoomTagEnabled } from "./roomTags";

it("reads favourite and pinned room IDs from synced tags", () => {
  const { favorites, pinned } = readRoomTags([
    { roomId: "!a", tags: { [FAVOURITE_TAG]: {} } },
    { roomId: "!b", tags: { [PINNED_TAG]: { order: 0.5 } } },
    { roomId: "!c", tags: {} },
    { roomId: "!d" },
  ]);
  expect([...favorites]).toEqual(["!a"]);
  expect([...pinned]).toEqual(["!b"]);
});

it("sets and removes the tag on the user's account", async () => {
  const client = { setRoomTag: vi.fn().mockResolvedValue({}), deleteRoomTag: vi.fn().mockResolvedValue({}) };
  await setRoomTagEnabled(client, "!a", FAVOURITE_TAG, true);
  await setRoomTagEnabled(client, "!a", PINNED_TAG, false);
  expect(client.setRoomTag).toHaveBeenCalledWith("!a", FAVOURITE_TAG, { order: 0.5 });
  expect(client.deleteRoomTag).toHaveBeenCalledWith("!a", PINNED_TAG);
});
