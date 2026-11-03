import { EventStatus, MatrixEvent, type Room } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_CONTENT_KEY,
  CHANNEL_ROOM_TYPE,
  channelRoomSummary,
  channelRoomsFromClient,
  isChannelRoom,
  publishAnnouncement,
  toggleReaction,
} from "./channels";
import { conversationsFromMatrixClient } from "./rooms";

const SELF = "@self:localhost";
const ADMIN = "@admin:localhost";

function message(id: string, sender: string, content: Record<string, unknown>, ts = 1_750_000_000_000) {
  return new MatrixEvent({ event_id: id, room_id: "!chan:localhost", sender, type: "m.room.message", origin_server_ts: ts, content });
}
function reaction(id: string, sender: string, key: string) {
  return new MatrixEvent({
    event_id: id, room_id: "!chan:localhost", sender, type: "m.reaction", origin_server_ts: 1,
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$a1", key } },
  });
}

function fakeRoom(options: {
  type?: string;
  membership?: "join" | "invite";
  events?: MatrixEvent[];
  reactions?: Record<string, MatrixEvent[]>;
  maySend?: (type: string, user: string) => boolean;
  unread?: number;
}): Room {
  const events = options.events ?? [];
  return {
    roomId: "!chan:localhost",
    name: "Engineering",
    getType: () => options.type,
    currentState: {
      getStateEvents: (type: string) => (type === "m.room.create" && options.type ? { getContent: () => ({ type: options.type }) } : null),
      maySendEvent: (type: string, user: string) => (options.maySend ? options.maySend(type, user) : true),
    },
    getMyMembership: () => options.membership ?? "join",
    getLiveTimeline: () => ({ getEvents: () => events, getPaginationToken: () => "token" }),
    getMembers: () => [],
    getMember: (userId: string) => (userId === ADMIN ? { name: "Alice Admin", userId } : null),
    getJoinedMembers: () => [
      { userId: "@u_1:localhost" }, { userId: "@u_2:localhost" }, { userId: "@u_3:localhost" }, { userId: "@channels_service:localhost" },
    ],
    getUnreadNotificationCount: () => options.unread ?? 0,
    getLastActiveTimestamp: () => 0,
    getMxcAvatarUrl: () => null,
    hasEncryptionStateEvent: () => false,
    relations: {
      getChildEventsForEvent: (eventId: string) => {
        const byKey = options.reactions && eventId === "$a1" ? options.reactions : null;
        return byKey ? { getSortedAnnotationsByKey: () => Object.entries(byKey).map(([key, list]) => [key, new Set(list)]) } : undefined;
      },
    },
  } as unknown as Room;
}

describe("channel rooms", () => {
  it("recognises channel rooms by their create-event type only", () => {
    expect(isChannelRoom(fakeRoom({ type: CHANNEL_ROOM_TYPE }))).toBe(true);
    expect(isChannelRoom(fakeRoom({}))).toBe(false);
    expect(isChannelRoom(fakeRoom({ type: "m.space" }))).toBe(false);
  });

  it("keeps channel rooms out of chats and groups, and non-channel rooms out of channels", () => {
    const channel = fakeRoom({ type: CHANNEL_ROOM_TYPE });
    const group = { ...fakeRoom({}), roomId: "!group:localhost" } as Room;
    expect(conversationsFromMatrixClient([channel, group], SELF).map((c) => c.id)).toEqual(["!group:localhost"]);
    expect(Object.keys(channelRoomsFromClient([channel, group], SELF, new Map()))).toEqual(["!chan:localhost"]);
  });

  it("parses announcement titles, captions and real reaction counts", () => {
    const text = message("$a1", ADMIN, {
      msgtype: "m.text", body: "Sprint v2.4 is live\n\nWe shipped it.",
      [ANNOUNCEMENT_CONTENT_KEY]: { version: 1, title: "Sprint v2.4 is live", text: "We shipped it." },
    });
    const image = message("$a2", ADMIN, {
      msgtype: "m.image", body: "release.png", filename: "release.png", url: "mxc://localhost/img",
      info: { mimetype: "image/png", size: 10 },
      [ANNOUNCEMENT_CONTENT_KEY]: { version: 1, title: "Release art", text: "Enjoy" },
    }, 1_750_000_001_000);
    const room = fakeRoom({
      type: CHANNEL_ROOM_TYPE,
      events: [text, image, reaction("$r1", "@bob:localhost", "👍"), reaction("$r2", SELF, "👍"), reaction("$r3", "@carol:localhost", "🎉")],
      reactions: { "👍": [reaction("$r1", "@bob:localhost", "👍"), reaction("$r2", SELF, "👍")], "🎉": [reaction("$r3", "@carol:localhost", "🎉")] },
      maySend: (type) => type === "m.reaction",
      unread: 2,
    });
    const summary = channelRoomSummary(room, SELF, 40);
    expect(summary.announcements.map((a) => a.id)).toEqual(["$a1", "$a2"]);
    expect(summary.announcements[0]).toMatchObject({ title: "Sprint v2.4 is live", text: "We shipped it.", senderName: "Alice Admin" });
    expect(summary.announcements[0].reactions).toEqual([
      { key: "👍", count: 2, mine: true, myEventId: "$r2" },
      { key: "🎉", count: 1, mine: false, myEventId: undefined },
    ]);
    expect(summary.announcements[1]).toMatchObject({ title: "Release art", text: "Enjoy" });
    expect(summary.announcements[1].attachment).toMatchObject({ kind: "image", name: "release.png", mediaUri: "mxc://localhost/img" });
    expect(summary.latestPreview).toBe("Release art");
    expect(summary.unreadCount).toBe(2);
    expect(summary.canPublish).toBe(false);
    expect(summary.canReact).toBe(true);
    expect(summary.joinedCount).toBe(3);
    expect(summary.hasOlder).toBe(true);
    // Identity is stable while nothing visible changed, so memoised cards skip re-rendering.
    expect(channelRoomSummary(room, SELF, 40).announcements[0]).toBe(summary.announcements[0]);
  });

  it("limits the rendered window and reports invites without unread counts", () => {
    const events = Array.from({ length: 5 }, (_, i) => message(`$m${i}`, ADMIN, { msgtype: "m.text", body: `n${i}` }, 1_750_000_000_000 + i));
    const room = fakeRoom({ type: CHANNEL_ROOM_TYPE, events, membership: "invite", unread: 9 });
    const summary = channelRoomSummary(room, SELF, 2);
    expect(summary.announcements.map((a) => a.text)).toEqual(["n3", "n4"]);
    expect(summary.membership).toBe("invite");
    expect(summary.unreadCount).toBe(0);
    expect(summary.canPublish).toBe(false);
  });

  it("refuses to publish without power and sends one event with the announcement metadata", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: "$new" });
    const client = {
      getUserId: () => SELF,
      getRoom: () => fakeRoom({ type: CHANNEL_ROOM_TYPE, maySend: () => false }),
      sendMessage,
    } as unknown as Parameters<typeof publishAnnouncement>[0];
    await expect(publishAnnouncement(client, "!chan:localhost", { title: "Hi", body: "There" })).rejects.toThrow(/Only channel admins/);
    expect(sendMessage).not.toHaveBeenCalled();

    const allowed = { ...client, getRoom: () => fakeRoom({ type: CHANNEL_ROOM_TYPE }) } as unknown as typeof client;
    await publishAnnouncement(allowed, "!chan:localhost", { title: "Hi", body: "There" });
    expect(sendMessage).toHaveBeenCalledWith("!chan:localhost", {
      msgtype: "m.text", body: "Hi\n\nThere", [ANNOUNCEMENT_CONTENT_KEY]: { version: 1, title: "Hi", text: "There" },
    });
  });

  it("toggles a reaction by sending it or redacting the user's own", async () => {
    const sendEvent = vi.fn().mockResolvedValue({});
    const redactEvent = vi.fn().mockResolvedValue({});
    const client = { getUserId: () => SELF, getRoom: () => fakeRoom({ type: CHANNEL_ROOM_TYPE }), sendEvent, redactEvent } as unknown as Parameters<typeof toggleReaction>[0];
    const base = { id: "$a1", sender: "them" as const, text: "x", delivery: "sent" as const, matrix: { eventId: "$a1", roomId: "!chan:localhost", eventType: "m.room.message", senderId: ADMIN } };
    await toggleReaction(client, "!chan:localhost", { ...base, reactions: [] }, "👍");
    expect(sendEvent).toHaveBeenCalledWith("!chan:localhost", "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$a1", key: "👍" } });
    await toggleReaction(client, "!chan:localhost", { ...base, reactions: [{ key: "👍", count: 1, mine: true, myEventId: "$r2" }] }, "👍");
    expect(redactEvent).toHaveBeenCalledWith("!chan:localhost", "$r2");
    const pending = new MatrixEvent({ event_id: "~local", room_id: "!chan:localhost", sender: SELF, type: "m.room.message", origin_server_ts: 1, content: { msgtype: "m.text", body: "x" } });
    pending.setStatus(EventStatus.SENDING);
    await expect(toggleReaction(client, "!chan:localhost", { ...base, matrix: { ...base.matrix, eventId: "~local" }, reactions: [] }, "👍")).rejects.toThrow(/confirmed/);
  });
});
