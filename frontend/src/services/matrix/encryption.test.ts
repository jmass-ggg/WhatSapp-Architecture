import type { MatrixClient } from "matrix-js-sdk";
import { Preset, Visibility } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  acceptEncryptedGroupInvitation,
  createEncryptedRoom,
  declineGroupInvitation,
  MATRIX_CONVERSATION_MARKER_VERSION,
  MATRIX_DIRECT_MARKER_TYPE,
  MATRIX_GROUP_MARKER_TYPE,
  MATRIX_ROOM_ENCRYPTION_ALGORITHM,
  sendEncryptedTextMessage,
} from "./encryption";

const roomId = "!secure:localhost";

function mockClient({
  hasEncryptionState = true,
  rustCrypto = true,
  sdkEncryptionReady = true,
  crossSigningReady = true,
  algorithm = MATRIX_ROOM_ENCRYPTION_ALGORITHM,
  joined = true,
  canSendEncrypted = true,
}: {
  hasEncryptionState?: boolean;
  rustCrypto?: boolean;
  sdkEncryptionReady?: boolean;
  crossSigningReady?: boolean;
  algorithm?: string;
  joined?: boolean;
  canSendEncrypted?: boolean;
} = {}) {
  const createRoom = vi.fn(async () => ({ room_id: roomId }));
  const sendTextMessage = vi.fn(async () => ({ event_id: "$encrypted:localhost" }));
  const sendMessage = vi.fn(async () => ({ event_id: "$encrypted-reply:localhost" }));
  const maySendEvent = vi.fn(() => canSendEncrypted);
  const crypto = {
    isCrossSigningReady: vi.fn(async () => crossSigningReady),
    isEncryptionEnabledInRoom: vi.fn(async () => sdkEncryptionReady),
  };
  const client = {
    createRoom,
    getCrypto: () => (rustCrypto ? crypto : null),
    getStateEvent: vi.fn(async () => ({ algorithm })),
    getRoom: () => ({
      hasEncryptionStateEvent: () => hasEncryptionState,
      findEventById: () => ({}),
      getMyMembership: () => (joined ? "join" : "leave"),
      currentState: { maySendEvent },
    }),
    getUserId: () => "@sender:localhost",
    sendMessage,
    sendTextMessage,
  } as unknown as MatrixClient;

  return { client, createRoom, crypto, maySendEvent, sendMessage, sendTextMessage };
}

describe("Matrix encrypted room and message operations", () => {
  it("creates a private room with encryption in its initial state", async () => {
    const { client, createRoom } = mockClient();

    await expect(
      createEncryptedRoom(client, {
        invitees: ["@peer:localhost"],
        isDirect: true,
      }),
    ).resolves.toBe(roomId);

    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: Visibility.Private,
        preset: Preset.PrivateChat,
        is_direct: true,
        invite: ["@peer:localhost"],
        initial_state: [
          {
            type: "m.room.encryption",
            state_key: "",
            content: { algorithm: MATRIX_ROOM_ENCRYPTION_ALGORITHM },
          },
          {
            type: MATRIX_DIRECT_MARKER_TYPE,
            state_key: "",
            content: { version: MATRIX_CONVERSATION_MARKER_VERSION },
          },
        ],
      }),
    );
  });

  it("creates an encrypted named group with is_direct false, a versioned marker, and invitations", async () => {
    const { client, createRoom } = mockClient();

    await expect(
      createEncryptedRoom(client, {
        invitees: ["@bob:localhost", "@charlie:localhost"],
        name: "Development Team",
        isDirect: false,
        isGroup: true,
      }),
    ).resolves.toBe(roomId);

    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        is_direct: false,
        name: "Development Team",
        invite: ["@bob:localhost", "@charlie:localhost"],
        initial_state: [
          {
            type: "m.room.encryption",
            state_key: "",
            content: { algorithm: MATRIX_ROOM_ENCRYPTION_ALGORITHM },
          },
          {
            type: MATRIX_GROUP_MARKER_TYPE,
            state_key: "",
            content: { version: MATRIX_CONVERSATION_MARKER_VERSION },
          },
        ],
      }),
    );
  });

  it("rejects invalid group creation before creating a room", async () => {
    const { client, createRoom } = mockClient();
    await expect(
      createEncryptedRoom(client, {
        invitees: ["@bob:localhost", "@charlie:localhost"],
        name: " ",
        isDirect: false,
        isGroup: true,
      }),
    ).rejects.toThrow(/name for the group/i);
    await expect(
      createEncryptedRoom(client, {
        invitees: ["@bob:localhost"],
        name: "Development Team",
        isDirect: false,
        isGroup: true,
      }),
    ).rejects.toThrow(/at least two accepted contacts/i);
    await expect(
      createEncryptedRoom(client, {
        invitees: ["@bob:localhost", "@bob:localhost"],
        name: "Development Team",
        isDirect: false,
        isGroup: true,
      }),
    ).rejects.toThrow(/invited to a room once/i);
    await expect(
      createEncryptedRoom(client, {
        invitees: ["@sender:localhost", "@bob:localhost"],
        name: "Development Team",
        isDirect: false,
        isGroup: true,
      }),
    ).rejects.toThrow(/cannot invite yourself/i);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("does not create a room if Rust crypto is unavailable", async () => {
    const { client, createRoom } = mockClient({ rustCrypto: false });

    await expect(
      createEncryptedRoom(client, { invitees: ["@peer:localhost"] }),
    ).rejects.toThrow(/Rust crypto is unavailable/);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("does not create a room until cross-signing is ready", async () => {
    const { client, createRoom } = mockClient({ crossSigningReady: false });

    await expect(
      createEncryptedRoom(client, { invitees: ["@peer:localhost"] }),
    ).rejects.toThrow(/cross-signing must be ready/i);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("rejects sending to plaintext or unconfirmed rooms without calling a plaintext API", async () => {
    const { client, sendTextMessage } = mockClient({
      hasEncryptionState: false,
    });

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).rejects.toThrow(/not confirmed as encrypted/);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("blocks encrypted sending when the current user has not joined", async () => {
    const { client, sendTextMessage } = mockClient({ joined: false });

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).rejects.toThrow(/join the encrypted room/i);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("blocks encrypted sending when room power levels deny the event", async () => {
    const { client, maySendEvent, sendTextMessage } = mockClient({
      canSendEncrypted: false,
    });

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).rejects.toThrow(/permission to send encrypted messages/i);
    expect(maySendEvent).toHaveBeenCalledWith(
      "m.room.encrypted",
      "@sender:localhost",
    );
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("sends only through the SDK text-message API after crypto confirms encryption", async () => {
    const { client, crypto, sendTextMessage } = mockClient();

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).resolves.toEqual({ event_id: "$encrypted:localhost" });

    expect(crypto.isCrossSigningReady).toHaveBeenCalledOnce();
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(roomId);
    expect(sendTextMessage).toHaveBeenCalledWith(roomId, "synthetic message");
  });

  it("sends a group reply through the Matrix SDK encrypted send path", async () => {
    const { client, sendMessage, sendTextMessage } = mockClient();

    await expect(
      sendEncryptedTextMessage(client, roomId, "Reply", "$original:localhost"),
    ).resolves.toEqual({ event_id: "$encrypted-reply:localhost" });

    expect(sendMessage).toHaveBeenCalledWith(roomId, {
      msgtype: "m.text",
      body: "Reply",
      "m.relates_to": {
        "m.in_reply_to": { event_id: "$original:localhost" },
      },
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("blocks sending until cross-signing is ready", async () => {
    const { client, sendTextMessage } = mockClient({
      crossSigningReady: false,
    });

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).rejects.toThrow(/Cross-signing is not ready/);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("fails closed when SDK encryption state does not match the room state", async () => {
    const { client, sendTextMessage } = mockClient({
      algorithm: "m.megolm.unknown",
    });

    await expect(
      sendEncryptedTextMessage(client, roomId, "synthetic message"),
    ).rejects.toThrow(/encryption state could not be verified/);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("accepts an encrypted group invitation and declines an invitation with Matrix membership APIs", async () => {
    let membership = "invite";
    const room = {
      getMyMembership: () => membership,
      hasEncryptionStateEvent: () => true,
    };
    const crypto = {
      isEncryptionEnabledInRoom: vi.fn(async () => true),
    };
    const client = {
      getRoom: () => room,
      getCrypto: () => crypto,
      joinRoom: vi.fn(async () => {
        membership = "join";
        return room;
      }),
      leave: vi.fn(async () => {
        membership = "leave";
        return {};
      }),
    } as unknown as MatrixClient;

    await acceptEncryptedGroupInvitation(client, roomId);
    expect(client.joinRoom).toHaveBeenCalledWith(roomId);
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(roomId);

    membership = "invite";
    await declineGroupInvitation(client, roomId);
    expect(client.leave).toHaveBeenCalledWith(roomId);
  });

  it("reports when group encryption is unavailable after accepting an invite", async () => {
    let membership = "invite";
    const room = {
      getMyMembership: () => membership,
      hasEncryptionStateEvent: () => true,
    };
    const client = {
      getRoom: () => room,
      getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn(async () => false) }),
      joinRoom: vi.fn(async () => {
        membership = "join";
        return room;
      }),
    } as unknown as MatrixClient;

    await expect(
      acceptEncryptedGroupInvitation(client, roomId),
    ).rejects.toThrow(/encryption is not ready/i);
    expect(client.joinRoom).toHaveBeenCalledOnce();
  });

  it("does not join a group invitation without confirmed encryption state", async () => {
    const client = {
      getRoom: () => ({
        getMyMembership: () => "invite",
        hasEncryptionStateEvent: () => false,
      }),
      joinRoom: vi.fn(),
    } as unknown as MatrixClient;

    await expect(
      acceptEncryptedGroupInvitation(client, roomId),
    ).rejects.toThrow(/does not contain confirmed encryption state/i);
    expect(client.joinRoom).not.toHaveBeenCalled();
  });
});
