import { MatrixEvent, type Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";

import { conversationFromMatrixRoom, conversationsFromMatrixClient } from "./rooms";

describe("Matrix room mapping", () => {
  it("deduplicates event IDs and derives room state from the SDK room model", () => {
    const message = new MatrixEvent({
      event_id: "$message:localhost",
      room_id: "!room:localhost",
      sender: "@other:localhost",
      type: "m.room.message",
      origin_server_ts: 1_750_000_000_000,
      content: { msgtype: "m.text", body: "hello from Synapse" },
    });
    const member = {
      userId: "@other:localhost",
      membership: "join",
      name: "Other User",
      typing: true,
      user: { avatarUrl: "mxc://localhost/avatar" },
      events: { member: { getContent: () => ({}) } },
    };
    const room = {
      roomId: "!room:localhost",
      name: "Shared room",
      getMembers: () => [member],
      getLiveTimeline: () => ({ getEvents: () => [message, message] }),
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => false,
      getUnreadNotificationCount: () => 2,
      getLastActiveTimestamp: () => 1_750_000_000_000,
      guessDMUserId: () => "@other:localhost",
    } as unknown as Room;

    const conversation = conversationFromMatrixRoom(
      room,
      "@self:localhost",
    );

    expect(conversation.id).toBe("!room:localhost");
    expect(conversation.name).toBe("Shared room");
    expect(conversation.isTyping).toBe(true);
    expect(conversation.unreadCount).toBe(2);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      id: "$message:localhost",
      text: "hello from Synapse",
      sender: "them",
    });
  });

  it("shows encrypted invitations and keeps unique messages in timestamp order", () => {
    const later = new MatrixEvent({
      event_id: "$later:localhost", room_id: "!invite:localhost",
      sender: "@other:localhost", type: "m.room.message",
      origin_server_ts: 2000, content: { msgtype: "m.text", body: "later" },
    });
    const earlier = new MatrixEvent({
      event_id: "$earlier:localhost", room_id: "!invite:localhost",
      sender: "@other:localhost", type: "m.room.message",
      origin_server_ts: 1000, content: { msgtype: "m.text", body: "earlier" },
    });
    const room = {
      roomId: "!invite:localhost", name: "", getMembers: () => [],
      getLiveTimeline: () => ({ getEvents: () => [later, earlier, later] }),
      getMyMembership: () => "invite", hasEncryptionStateEvent: () => true,
      getUnreadNotificationCount: () => 2, getLastActiveTimestamp: () => Number.MIN_SAFE_INTEGER,
      guessDMUserId: () => "@other:localhost",
    } as unknown as Room;

    const [conversation] = conversationsFromMatrixClient([room], "@self:localhost");
    expect(conversation.isEncrypted).toBe(true);
    expect(conversation.messages.map((message) => message.id)).toEqual([
      "$earlier:localhost", "$later:localhost",
    ]);
    expect(conversation.lastMessage).toBe("later");
  });

  it("does not expose an invalid date for an empty invited room", () => {
    const room = {
      roomId: "!empty:localhost", name: "", getMembers: () => [],
      getLiveTimeline: () => ({ getEvents: () => [] }),
      getMyMembership: () => "invite", hasEncryptionStateEvent: () => true,
      getUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => Number.MIN_SAFE_INTEGER,
      guessDMUserId: () => "@other:localhost",
    } as unknown as Room;
    const [conversation] = conversationsFromMatrixClient([room], "@self:localhost");
    expect(conversation.updatedAt.getTime()).toBe(0);
  });
});
