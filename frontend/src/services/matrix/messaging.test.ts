import type { MatrixClient } from "matrix-js-sdk";
import { Preset, Visibility } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  acceptGroupInvitation,
  createPlainRoom,
  declineGroupInvitation,
  isLegacyEncryptedRoom,
  MATRIX_DIRECT_MARKER_TYPE,
  MATRIX_GROUP_MARKER_TYPE,
  queueTextMessage,
  retryFailedMessage,
  sendTextMessage,
} from "./messaging";

const roomId = "!plain:localhost";

function mockClient({
  encrypted = false,
  joined = true,
  invited = false,
  canSend = true,
  knowsReplyTarget = true,
}: {
  encrypted?: boolean;
  joined?: boolean;
  invited?: boolean;
  canSend?: boolean;
  knowsReplyTarget?: boolean;
} = {}) {
  const createRoom = vi.fn(async () => ({ room_id: roomId }));
  const sendMessage = vi.fn(async () => ({ event_id: "$sent:localhost" }));
  const joinRoom = vi.fn(async () => room);
  const leave = vi.fn(async () => ({}));
  const membership = () => (invited ? "invite" : joined ? "join" : "leave");
  const room = {
    hasEncryptionStateEvent: () => encrypted,
    findEventById: () => (knowsReplyTarget ? {} : undefined),
    getMyMembership: membership,
    getMember: (id: string) => (id === "@gone:localhost" ? { membership: "leave" } : { membership: "join" }),
    currentState: {
      maySendEvent: vi.fn(() => canSend),
      getStateEvents: () => null,
    },
  };
  const client = {
    createRoom,
    getRoom: () => room,
    getUserId: () => "@sender:localhost",
    sendMessage,
    joinRoom,
    leave,
  } as unknown as MatrixClient;
  return { client, createRoom, sendMessage, joinRoom, leave };
}

describe("createPlainRoom", () => {
  it("creates a private direct room without any encryption state", async () => {
    const { client, createRoom } = mockClient();
    await expect(
      createPlainRoom(client, { invitees: ["@peer:localhost"], isDirect: true }),
    ).resolves.toBe(roomId);
    const request = (createRoom.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(request).toMatchObject({
      visibility: Visibility.Private,
      preset: Preset.PrivateChat,
      is_direct: true,
      invite: ["@peer:localhost"],
    });
    const states = request.initial_state as { type: string }[];
    expect(states.map((s) => s.type)).toEqual([MATRIX_DIRECT_MARKER_TYPE]);
    expect(JSON.stringify(request)).not.toContain("m.room.encryption");
  });

  it("creates a named group with a group marker and unique invitees", async () => {
    const { client, createRoom } = mockClient();
    await createPlainRoom(client, {
      invitees: ["@a:localhost", "@b:localhost"],
      name: " Team ",
      isGroup: true,
      isDirect: false,
    });
    const request = (createRoom.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(request).toMatchObject({ name: "Team", is_direct: false });
    expect((request.initial_state as { type: string }[]).map((s) => s.type)).toEqual([
      MATRIX_GROUP_MARKER_TYPE,
    ]);
  });

  it.each([
    [{ invitees: [] }, /at least one invitee/],
    [{ invitees: ["@a:localhost", "@a:localhost"] }, /only be invited to a room once/],
    [{ invitees: ["@sender:localhost"] }, /yourself/],
    [{ invitees: ["@a:localhost", "@b:localhost"], isGroup: true }, /name for the group/],
    [{ invitees: ["@a:localhost"], isGroup: true, name: "G" }, /at least two/],
  ])("rejects invalid options %#", async (options, message) => {
    const { client, createRoom } = mockClient();
    await expect(createPlainRoom(client, options)).rejects.toThrow(message);
    expect(createRoom).not.toHaveBeenCalled();
  });
});

describe("sendTextMessage", () => {
  it("sends a standard m.room.message text event", async () => {
    const { client, sendMessage } = mockClient();
    await sendTextMessage(client, roomId, "  hello  ");
    expect(sendMessage).toHaveBeenCalledWith(roomId, { msgtype: "m.text", body: "hello" });
  });

  it("sends replies with an in_reply_to relation", async () => {
    const { client, sendMessage } = mockClient();
    await sendTextMessage(client, roomId, "re", "$orig:localhost");
    expect(sendMessage).toHaveBeenCalledWith(roomId, {
      msgtype: "m.text",
      body: "re",
      "m.relates_to": { "m.in_reply_to": { event_id: "$orig:localhost" } },
    });
  });

  it("sends real mentions with escaped HTML, deduped ids, no self-notification and the reply relation", async () => {
    const { client, sendMessage } = mockClient();
    const text = "Hi @James <b>&</b> @James\n@Me @Gone";
    const at = (label: string, nth = 0) => { let i = -1; for (let n = 0; n <= nth; n++) i = text.indexOf(label, i + 1); return { start: i, end: i + label.length, label }; };
    await sendTextMessage(client, roomId, `  ${text}  `, "$orig:localhost", [
      { userId: "@james:localhost", ...{ start: at("@James").start + 2, end: at("@James").end + 2, label: "@James" } },
      { userId: "@james:localhost", ...{ start: at("@James", 1).start + 2, end: at("@James", 1).end + 2, label: "@James" } },
      { userId: "@sender:localhost", ...{ start: at("@Me").start + 2, end: at("@Me").end + 2, label: "@Me" } },
      { userId: "@gone:localhost", ...{ start: at("@Gone").start + 2, end: at("@Gone").end + 2, label: "@Gone" } },
    ]);
    const content = (sendMessage.mock.calls as unknown as [string, Record<string, unknown>][])[0][1];
    expect(content.body).toBe(text);
    expect(content["m.mentions"]).toEqual({ user_ids: ["@james:localhost"] });
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toBe(
      'Hi <a href="https://matrix.to/#/@james:localhost">@James</a> &lt;b&gt;&amp;&lt;/b&gt; <a href="https://matrix.to/#/@james:localhost">@James</a><br><a href="https://matrix.to/#/@sender:localhost">@Me</a> @Gone',
    );
    expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig:localhost" } });
  });

  it("treats a stale or edited mention as plain text", async () => {
    const { client, sendMessage } = mockClient();
    await sendTextMessage(client, roomId, "hello @Jam", undefined, [{ userId: "@james:localhost", label: "@James", start: 6, end: 12 }]);
    expect(sendMessage).toHaveBeenCalledWith(roomId, { msgtype: "m.text", body: "hello @Jam" });
  });

  it("refuses empty messages, unknown reply targets, missing permission and unjoined rooms", async () => {
    await expect(sendTextMessage(mockClient().client, roomId, "  ")).rejects.toThrow(/empty/);
    await expect(
      sendTextMessage(mockClient({ knowsReplyTarget: false }).client, roomId, "x", "$nope"),
    ).rejects.toThrow(/not confirmed/);
    await expect(sendTextMessage(mockClient({ canSend: false }).client, roomId, "x")).rejects.toThrow(/permission/);
    await expect(sendTextMessage(mockClient({ joined: false }).client, roomId, "x")).rejects.toThrow(/Join the room/);
  });

  it("never sends into a retired encrypted room", async () => {
    const { client, sendMessage } = mockClient({ encrypted: true });
    await expect(sendTextMessage(client, roomId, "x")).rejects.toThrow(/retired encrypted room/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("invitations", () => {
  it("accepts a plaintext group invitation", async () => {
    const { client, joinRoom } = mockClient({ invited: true });
    // After joining the mocked room still reports "invite"; the guard must notice.
    await expect(acceptGroupInvitation(client, roomId)).rejects.toThrow(/did not finish joining/);
    expect(joinRoom).toHaveBeenCalledWith(roomId);
  });

  it("refuses invitations to retired encrypted rooms", async () => {
    const { client, joinRoom } = mockClient({ invited: true, encrypted: true });
    await expect(acceptGroupInvitation(client, roomId)).rejects.toThrow(/retired encrypted room/);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("declines only pending invitations", async () => {
    const pending = mockClient({ invited: true });
    await declineGroupInvitation(pending.client, roomId);
    expect(pending.leave).toHaveBeenCalledWith(roomId);
    await expect(declineGroupInvitation(mockClient().client, roomId)).rejects.toThrow(/no longer available/);
  });
});

describe("isLegacyEncryptedRoom", () => {
  it("detects the encryption state event", () => {
    expect(isLegacyEncryptedRoom({ hasEncryptionStateEvent: () => true })).toBe(true);
    expect(isLegacyEncryptedRoom({ hasEncryptionStateEvent: () => false })).toBe(false);
    expect(
      isLegacyEncryptedRoom({ currentState: { getStateEvents: () => ({}) } }),
    ).toBe(true);
  });
});

describe("queueTextMessage (local acceptance vs acknowledgment)", () => {
  it("submits ten messages in order synchronously without awaiting any acknowledgment", () => {
    const { client, sendMessage } = mockClient();
    sendMessage.mockImplementation(() => new Promise(() => {}) as never);
    for (let i = 0; i < 10; i++) queueTextMessage(client, roomId, `m${i}`);
    expect(sendMessage).toHaveBeenCalledTimes(10);
    expect((sendMessage.mock.calls as unknown as [string, { body: string }][]).map((c) => c[1].body))
      .toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  });

  it("keeps per-message reply context and rejects before submission when not permitted", () => {
    const { client, sendMessage } = mockClient();
    queueTextMessage(client, roomId, "a", "$one:localhost");
    queueTextMessage(client, roomId, "b");
    const calls = sendMessage.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls[0][1]["m.relates_to"]).toBeDefined();
    expect(calls[1][1]["m.relates_to"]).toBeUndefined();
    const blocked = mockClient({ canSend: false });
    expect(() => queueTextMessage(blocked.client, roomId, "x")).toThrow(/permission/);
    expect(blocked.sendMessage).not.toHaveBeenCalled();
  });

  it("does not raise an unhandled rejection when the server fails the send", async () => {
    const { client, sendMessage } = mockClient();
    sendMessage.mockRejectedValue(new Error("rate limited") as never);
    const { acknowledged } = queueTextMessage(client, roomId, "hi");
    await expect(acknowledged).rejects.toThrow("rate limited");
  });
});

describe("retryFailedMessage", () => {
  it("resends the original pending event instead of creating a new one", async () => {
    const { client, sendMessage } = mockClient();
    const event = { getId: () => "~txn1", status: "not_sent" };
    const room = client.getRoom(roomId) as unknown as Record<string, unknown>;
    // Default pendingEventOrdering is chronological: pending events are only reachable by id.
    room.findEventById = (id: string) => (id === "~txn1" ? event : undefined);
    const resendEvent = vi.fn(async () => "$id");
    (client as unknown as Record<string, unknown>).resendEvent = resendEvent;
    await retryFailedMessage(client, roomId, "~txn1");
    expect(resendEvent).toHaveBeenCalledWith(event, room);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(retryFailedMessage(client, roomId, "~gone")).rejects.toThrow(/no longer/);
  });
});
