import type { MatrixClient } from "matrix-js-sdk";
import { Preset, Visibility } from "matrix-js-sdk";
import type { ISendEventResponse } from "matrix-js-sdk";

export const MATRIX_ROOM_ENCRYPTION_ALGORITHM = "m.megolm.v1.aes-sha2";

export interface CreateEncryptedRoomOptions {
  invitees: string[];
  name?: string;
  isDirect?: boolean;
}

export async function createEncryptedRoom(
  client: MatrixClient,
  options: CreateEncryptedRoomOptions,
): Promise<string> {
  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Matrix Rust crypto is unavailable; no room was created.");
  }
  if (!(await crypto.isCrossSigningReady())) {
    throw new Error(
      "Secure recovery must be ready before creating an encrypted conversation.",
    );
  }
  if (options.invitees.length === 0) {
    throw new Error("An encrypted room must have at least one invitee.");
  }

  const result = await client.createRoom({
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    is_direct: options.isDirect ?? options.invitees.length === 1,
    invite: [...new Set(options.invitees)],
    ...(options.name ? { name: options.name } : {}),
    initial_state: [
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: MATRIX_ROOM_ENCRYPTION_ALGORITHM },
      },
    ],
  });

  const encryptionState = await client.getStateEvent(
    result.room_id,
    "m.room.encryption",
    "",
  );
  if (encryptionState.algorithm !== MATRIX_ROOM_ENCRYPTION_ALGORITHM) {
    throw new Error(
      "Synapse did not confirm the encrypted-room state. Messages are blocked.",
    );
  }

  await waitForSdkEncryptionState(client, result.room_id);
  return result.room_id;
}

export async function sendEncryptedTextMessage(
  client: MatrixClient,
  roomId: string,
  text: string,
): Promise<ISendEventResponse> {
  const body = text.trim();
  if (!body) throw new Error("Message is empty.");

  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Matrix Rust crypto is unavailable; message was not sent.");
  }
  if (!(await crypto.isCrossSigningReady())) {
    throw new Error(
      "Cross-signing is not set up on this account. Configure secure recovery before sending encrypted messages.",
    );
  }

  const room = client.getRoom(roomId);
  if (!room?.hasEncryptionStateEvent()) {
    throw new Error(
      "This room is not confirmed as encrypted. The message was not sent.",
    );
  }

  const encryptionState = await client.getStateEvent(
    roomId,
    "m.room.encryption",
    "",
  );
  if (
    encryptionState.algorithm !== MATRIX_ROOM_ENCRYPTION_ALGORITHM ||
    !(await crypto.isEncryptionEnabledInRoom(roomId))
  ) {
    throw new Error(
      "This room's encryption state could not be verified. The message was not sent.",
    );
  }

  // MatrixClient performs Megolm encryption and Olm key distribution locally.
  // If that fails, the SDK rejects this call; this code never falls back to plaintext.
  return client.sendTextMessage(roomId, body);
}

async function waitForSdkEncryptionState(
  client: MatrixClient,
  roomId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Matrix Rust crypto became unavailable.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const room = client.getRoom(roomId);
    if (
      room?.hasEncryptionStateEvent() &&
      (await crypto.isEncryptionEnabledInRoom(roomId))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    "The Matrix client did not synchronize the encrypted-room state. Messages are blocked.",
  );
}
