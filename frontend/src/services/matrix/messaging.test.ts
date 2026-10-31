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
