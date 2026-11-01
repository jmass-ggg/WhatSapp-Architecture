import { Direction } from "matrix-js-sdk";
import { expect, it, vi } from "vitest";

import { hasOlderHistory, loadOlderMessages } from "./history";

const roomWith = (token: string | null) => {
  const timeline = { getPaginationToken: vi.fn((direction: Direction) => (direction === Direction.Backward ? token : null)) };
  return { getLiveTimeline: () => timeline } as never;
};

it("reports older history only when a backward token exists", () => {
  expect(hasOlderHistory(roomWith("t1"))).toBe(true);
  expect(hasOlderHistory(roomWith(null))).toBe(false);
});

it("paginates backwards and skips the request when history is exhausted", async () => {
  const client = { paginateEventTimeline: vi.fn().mockResolvedValue(true) };
  expect(await loadOlderMessages(client, roomWith("t1"))).toBe(true);
  expect(client.paginateEventTimeline).toHaveBeenCalledWith(expect.anything(), { backwards: true, limit: 50 });
  client.paginateEventTimeline.mockClear();
  expect(await loadOlderMessages(client, roomWith(null))).toBe(false);
  expect(client.paginateEventTimeline).not.toHaveBeenCalled();
});
