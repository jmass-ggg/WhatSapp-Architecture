import { EventStatus, MatrixEvent, ReceiptType, type Room } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import { MATRIX_DIRECT_MARKER_TYPE, MATRIX_GROUP_MARKER_TYPE } from "./encryption";
import { conversationFromMatrixRoom, conversationsFromMatrixClient } from "./rooms";

describe("Matrix room mapping", () => {
  it("uses only a real recipient public receipt at a known timeline position", () => {
    const makeEvent = (id: string, sender: string) => new MatrixEvent({
      event_id: id, room_id: "!room:localhost", sender,
      type: "m.room.message", origin_server_ts: 1_750_000_000_000,
      content: { msgtype: "m.text", body: id },
    });
    const earlier = makeEvent("$earlier", "@self:localhost");
    const later = makeEvent("$later", "@self:localhost");
    const incoming = makeEvent("$incoming", "@peer:localhost");
    const pending = makeEvent("~pending", "@self:localhost");
    pending.setStatus(EventStatus.SENDING);
    const failed = makeEvent("~failed", "@self:localhost");
    failed.setStatus(EventStatus.NOT_SENT);
    const events = [earlier, later, incoming, pending, failed];
    let receipt: { eventId: string; data: { ts: number } } | null = null;
    const getReadReceiptForUserId = vi.fn((userId: string, ignoreSynthesized: boolean, type: ReceiptType) =>
      userId === "@peer:localhost" && ignoreSynthesized && type === ReceiptType.Read ? receipt : null);
    const room = {
      roomId: "!room:localhost", name: "Chat", getMembers: () => [{
        userId: "@peer:localhost", membership: "join", name: "Peer",
        events: { member: { getContent: () => ({}) } },
      }],
      getLiveTimeline: () => ({ getEvents: () => events }),
      getReadReceiptForUserId,
      hasEncryptionStateEvent: () => true, getUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => 0,
    } as unknown as Room;
    const messages = () => conversationFromMatrixRoom(room, "@self:localhost").messages;
    expect(messages().map((message) => message.delivery)).toEqual(["sent", "sent", "sent", "sending", "failed"]);
    receipt = { eventId: "$earlier", data: { ts: 1_750_000_000_000 } };
    expect(messages().map((message) => message.delivery)).toEqual(["read", "sent", "sent", "sending", "failed"]);
    receipt = { eventId: "$incoming", data: { ts: 1_750_000_000_000 } };
    expect(messages().map((message) => message.delivery)).toEqual(["read", "read", "sent", "sending", "failed"]);
    expect(messages()[0].readAt?.getTime()).toBe(1_750_000_000_000);
    receipt = { eventId: "$incoming", data: { ts: Number.NaN } };
    expect(messages()[0].readAt).toBeUndefined();
    receipt = { eventId: "$unloaded", data: { ts: 1_750_000_000_000 } };
    expect(messages()[0].delivery).toBe("sent");
    expect(getReadReceiptForUserId).toHaveBeenCalledWith("@peer:localhost", true, ReceiptType.Read);
  });
  it("keeps rapid local echoes and reconciles temporary IDs without duplicate rows", () => {
    const makeEvent = (id: string, body: string) => new MatrixEvent({
      event_id: id, room_id: "!room:localhost", sender: "@self:localhost",
      type: "m.room.message", origin_server_ts: 1_750_000_000_000,
      content: { msgtype: "m.text", body },
    });
    const first = makeEvent("~first", "first");
    const second = makeEvent("~second", "second");
    first.setStatus(EventStatus.SENDING);
    second.setStatus(EventStatus.SENDING);
    const timeline = [first, second];
    const room = {
      roomId: "!room:localhost", name: "Chat", getMembers: () => [],
      getLiveTimeline: () => ({ getEvents: () => timeline }),
      hasEncryptionStateEvent: () => true, getUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => 0,
    } as unknown as Room;
    expect(conversationFromMatrixRoom(room, "@self:localhost").messages.map((message) => message.delivery)).toEqual(["sending", "sending"]);
    first.replaceLocalEventId("$first:localhost");
    first.setStatus(EventStatus.SENT);
    const remoteEcho = makeEvent("$first:localhost", "first");
    timeline.push(remoteEcho);
    expect(conversationFromMatrixRoom(room, "@self:localhost").messages.map((message) => message.id)).toEqual(["$first:localhost", "~second"]);
    second.setStatus(EventStatus.NOT_SENT);
    expect(conversationFromMatrixRoom(room, "@self:localhost").messages.map((message) => message.delivery)).toEqual(["sent", "failed"]);
  });
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
      senderName: "Other User",
    });
  });

  it("uses the group's sender display name rather than a Matrix ID", () => {
    const event = new MatrixEvent({
      event_id: "$group-message",
      room_id: "!group:localhost",
      sender: "@charlie:localhost",
      type: "m.room.message",
      origin_server_ts: 1_750_000_000_000,
      content: { msgtype: "m.text", body: "Hello group" },
    });
    const members = [
      { userId: "@self:localhost", membership: "join", name: "You", events: { member: { getContent: () => ({}) } } },
      { userId: "@bob:localhost", membership: "join", name: "Bob Boyle", events: { member: { getContent: () => ({}) } } },
      { userId: "@charlie:localhost", membership: "join", name: "Charlie Smith", events: { member: { getContent: () => ({}) } } },
    ];
    const room = {
      roomId: "!group:localhost",
      name: "Hiring group",
      getMembers: () => members,
      getLiveTimeline: () => ({ getEvents: () => [event] }),
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => true,
      getUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => event.getTs(),
      guessDMUserId: () => undefined,
    } as unknown as Room;

    const conversation = conversationFromMatrixRoom(room, "@self:localhost");
    expect(conversation.messages[0].senderName).toBe("Charlie Smith");
    expect(conversation.messages[0].senderName).not.toContain("@charlie");
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

  it("shows group rooms and preserves marker-based classification after membership changes", () => {
    const otherMember = {
      userId: "@other:localhost",
      membership: "join",
      name: "Other User",
      typing: false,
      events: { member: { getContent: () => ({}) } },
    };
    const anotherMember = {
      ...otherMember,
      userId: "@third:localhost",
      name: "Third User",
    };
    const marker = { getContent: () => ({ version: 1 }) };
    const makeRoom = (
      roomId: string,
      members: typeof otherMember[],
      markerType?: string,
      membership: "join" | "invite" = "join",
      name = "",
    ) =>
      ({
        roomId,
        name,
        currentState: {
          getStateEvents: (type: string) => type === markerType ? marker : null,
        },
        getMembers: () => members,
        getMember: (userId: string) =>
          members.find((member) => member.userId === userId) ?? null,
        getLiveTimeline: () => ({ getEvents: () => [] }),
        getMyMembership: () => membership,
        hasEncryptionStateEvent: () => true,
        getUnreadNotificationCount: () => 0,
        getLastActiveTimestamp: () => 0,
        guessDMUserId: () => members[0]?.userId,
        getMxcAvatarUrl: () => null,
      }) as unknown as Room;

    const conversations = conversationsFromMatrixClient(
      [
        makeRoom("!direct:localhost", [otherMember], MATRIX_DIRECT_MARKER_TYPE),
        makeRoom("!group:localhost", [otherMember], MATRIX_GROUP_MARKER_TYPE, "join", "Development Team"),
        makeRoom("!empty-group:localhost", [], MATRIX_GROUP_MARKER_TYPE, "invite", "New Team"),
        makeRoom("!legacy-group:localhost", [otherMember, anotherMember]),
      ],
      "@self:localhost",
    );

    expect(conversations.map((conversation) => conversation.id)).toContain("!direct:localhost");
    expect(conversations.map((conversation) => conversation.id)).toContain("!group:localhost");
    expect(conversations.map((conversation) => conversation.id)).toContain("!empty-group:localhost");
    expect(conversations.map((conversation) => conversation.id)).toContain("!legacy-group:localhost");
    expect(conversations.find((conversation) => conversation.id === "!direct:localhost")?.isGroup).toBe(false);
    expect(conversations.find((conversation) => conversation.id === "!group:localhost")).toMatchObject({
      name: "Development Team",
      isGroup: true,
      isInvited: false,
      matrixUserId: undefined,
    });
    expect(conversations.find((conversation) => conversation.id === "!empty-group:localhost")).toMatchObject({
      name: "New Team",
      isGroup: true,
      isInvited: true,
      lastMessage: "No messages yet",
    });
  });

  it("shows friendly group sender names and typing activity without group read or delivery claims", () => {
    const bob = {
      userId: "@bob:localhost",
      membership: "join",
      name: "Bob (@bob:localhost)",
      rawDisplayName: "Bob",
      typing: true,
      events: { member: { getContent: () => ({ displayname: "Bob" }) } },
    };
    const alice = {
      ...bob,
      userId: "@alice:localhost",
      name: "Alice",
      rawDisplayName: "Alice",
      events: { member: { getContent: () => ({ displayname: "Alice" }) } },
    };
    const ownMember = {
      ...bob,
      userId: "@self:localhost",
      name: "@self:localhost",
      rawDisplayName: "@self:localhost",
    };
    const unnamedMember = {
      userId: "@service:localhost",
      membership: "join",
      name: "@service:localhost",
      rawDisplayName: "@service:localhost",
      typing: false,
      events: { member: { getContent: () => ({}) } },
    };
    const sent = new MatrixEvent({
      event_id: "$sent:localhost",
      room_id: "!group:localhost",
      sender: "@self:localhost",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { msgtype: "m.text", body: "hello" },
    });
    const received = new MatrixEvent({
      event_id: "$received:localhost",
      room_id: "!group:localhost",
      sender: "@bob:localhost",
      type: "m.room.message",
      origin_server_ts: 2000,
      content: { msgtype: "m.text", body: "hi" },
    });
    received.makeEncrypted(
      "m.room.encrypted",
      { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "ciphertext" },
      "curve25519:BOB",
      "ed25519:BOB",
    );
    const unnamedMessage = new MatrixEvent({
      event_id: "$unnamed:localhost",
      room_id: "!group:localhost",
      sender: "@service:localhost",
      type: "m.room.message",
      origin_server_ts: 3000,
      content: { msgtype: "m.text", body: "status" },
    });
    const getReadReceiptForUserId = vi.fn(() => ({
      eventId: "$sent:localhost",
      data: { ts: 3000 },
    }));
    const room = {
      roomId: "!group:localhost",
      name: "Development Team",
      currentState: {
        getStateEvents: (type: string) =>
          type === MATRIX_GROUP_MARKER_TYPE
            ? { getContent: () => ({ version: 1 }) }
            : null,
      },
      getMembers: () => [alice, bob, ownMember, unnamedMember],
      getMember: (userId: string) =>
        [alice, bob, ownMember, unnamedMember].find((member) => member.userId === userId) ?? null,
      getLiveTimeline: () => ({ getEvents: () => [sent, received, unnamedMessage] }),
      getMyMembership: () => "join",
      getReadReceiptForUserId,
      hasEncryptionStateEvent: () => true,
      getUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => 0,
      getMxcAvatarUrl: () => null,
    } as unknown as Room;

    const conversation = conversationFromMatrixRoom(
      room,
      "@self:localhost",
      new Set(["$sent:localhost"]),
    );

    expect(conversation.isGroup).toBe(true);
    expect(conversation.isTyping).toBe(true);
    expect(conversation.typingNames).toEqual(["Alice", "Bob"]);
    expect(conversation.messages[1].senderName).toBe("Bob");
    expect(conversation.messages[1].text).toBe("hi");
    expect(conversation.messages[1].matrix?.encryptionStatus).toBe("decrypted");
    expect(conversation.messages[2].senderName).toBe("service");
    expect(conversation.messages[2].senderName).not.toContain("@service:localhost");
    expect(conversation.messages[0].delivery).toBe("sent");
    expect(conversation.messages[0].readAt).toBeUndefined();
    expect(getReadReceiptForUserId).not.toHaveBeenCalled();
  });
});
