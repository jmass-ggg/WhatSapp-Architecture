import type { MatrixClient } from "matrix-js-sdk";
import { Preset, Visibility } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedRoom,
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
      getMyMembership: () => (joined ? "join" : "leave"),
      currentState: { maySendEvent },
    }),
    getUserId: () => "@sender:localhost",
    sendTextMessage,
  } as unknown as MatrixClient;

  return { client, createRoom, crypto, maySendEvent, sendTextMessage };
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
        ],
      }),
    );
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
});
