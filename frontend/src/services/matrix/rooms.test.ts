import { MatrixEvent, type Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";

import { conversationFromMatrixRoom } from "./rooms";

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
});
