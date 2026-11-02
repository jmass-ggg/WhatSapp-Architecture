import { describe, expect, it } from "vitest";

import { ConversationCache, conversationFromMatrixRoom, conversationsFromMatrixClient } from "../src/services/matrix/rooms";
import type { Conversation } from "../src/types";
import { buildRoom, offlineClient, OWN_USER_ID, PEER_USER_ID, summarize, textEvent, timeSync, writeReport } from "./support/harness";

const SIZES = [100, 1_000, 10_000];
const BURST = 50;

function sameIdentityCount(before: Conversation, after: Conversation): number {
  const previous = new Set(before.messages);
  return after.messages.filter((message) => previous.has(message)).length;
}

describe("timeline conversion cost (what one room refresh costs the session)", () => {
  const report: Record<string, unknown> = {};

  for (const size of SIZES) {
    it(`converts a ${size}-event room`, async () => {
      const client = offlineClient();
      const room = await buildRoom(client, `!perf${size}:localhost`, size);
      expect(room.getLiveTimeline().getEvents().filter((e) => e.getType() === "m.room.message").length).toBe(size);

      const refresh = timeSync(() => conversationFromMatrixRoom(room, OWN_USER_ID), 10, 2);

      // Incoming burst: the session refreshes the room once per event.
      const perEvent: number[] = [];
      let previous = conversationFromMatrixRoom(room, OWN_USER_ID);
      let reused = 0;
      for (let i = 0; i < BURST; i++) {
        await room.addLiveEvents([textEvent(room.roomId, PEER_USER_ID, size + i)], { addToState: false });
        const start = performance.now();
        const next = conversationFromMatrixRoom(room, OWN_USER_ID);
        perEvent.push(performance.now() - start);
        reused += sameIdentityCount(previous, next);
        previous = next;
      }
      const visible = previous.messages.length;

      report[`room_${size}`] = {
        events: size,
        refresh_ms: summarize(refresh),
        burst_per_event_ms: summarize(perEvent),
        burst_total_ms: Math.round(perEvent.reduce((a, b) => a + b, 0)),
        visible_messages: visible,
        // Message objects kept identical across consecutive refreshes (max = BURST * (visible-1)).
        message_identity_reuse: `${reused}/${BURST * (visible - 1)}`,
      };
    });
  }

  it("refreshes 20 rooms x 200 events when one room changes", async () => {
    const client = offlineClient();
    const rooms = [];
    for (let i = 0; i < 20; i++) rooms.push(await buildRoom(client, `!multi${i}:localhost`, 200, { group: i % 2 === 0, name: `Room ${i}` }));
    const cache = new ConversationCache();
    conversationsFromMatrixClient(rooms, OWN_USER_ID, cache);
    const cached = timeSync(() => {
      cache.markRoom(rooms[3].roomId);
      conversationsFromMatrixClient(rooms, OWN_USER_ID, cache);
    }, 20, 3);
    const uncached = timeSync(() => conversationsFromMatrixClient(rooms, OWN_USER_ID), 20, 3);
    report.multi_room = {
      rooms: 20,
      events_per_room: 200,
      one_room_dirty_with_cache_ms: summarize(cached),
      all_rooms_rebuilt_ms: summarize(uncached),
    };
    const file = writeReport("timeline", report);
    console.log(`\n[perf] timeline report -> ${file}\n${JSON.stringify(report, null, 2)}`);
  });
});
