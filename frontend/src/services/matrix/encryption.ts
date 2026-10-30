import type { MatrixClient } from "matrix-js-sdk";
import { EventType, MsgType, Preset, Visibility } from "matrix-js-sdk";
import type { ISendEventResponse } from "matrix-js-sdk";

export const MATRIX_ROOM_ENCRYPTION_ALGORITHM = "m.megolm.v1.aes-sha2";
export const MATRIX_GROUP_MARKER_TYPE = "org.recruitable.chat.group";
export const MATRIX_DIRECT_MARKER_TYPE = "org.recruitable.chat.direct";
export const MATRIX_CONVERSATION_MARKER_VERSION = 1;

export interface CreateEncryptedRoomOptions {
  invitees: string[];
  name?: string;
  isDirect?: boolean;
  isGroup?: boolean;
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
      "Cross-signing must be ready before creating an encrypted conversation.",
    );
  }
  if (options.invitees.length === 0) {
    throw new Error("An encrypted room must have at least one invitee.");
  }
  if (new Set(options.invitees).size !== options.invitees.length) {
    throw new Error("A participant can only be invited to a room once.");
  }
  const ownUserId = client.getUserId();
  if (ownUserId && options.invitees.includes(ownUserId)) {
    throw new Error("You cannot invite yourself to a conversation.");
  }
  const name = options.name?.trim();
  if (options.isGroup && !name) {
    throw new Error("Enter a name for the group.");
  }
  if (options.isGroup && options.invitees.length < 2) {
    throw new Error("Select at least two accepted contacts for a group.");
  }
  if (options.isGroup && options.isDirect === true) {
    throw new Error("A group conversation cannot be marked as a direct chat.");
  }
  const isDirect = options.isDirect ?? options.invitees.length === 1;

  const result = await client.createRoom({
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    is_direct: isDirect,
    invite: [...new Set(options.invitees)],
    ...(name ? { name } : {}),
    initial_state: [
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: MATRIX_ROOM_ENCRYPTION_ALGORITHM },
      },
      ...(options.isGroup
        ? [{
            type: MATRIX_GROUP_MARKER_TYPE,
            state_key: "",
            content: { version: MATRIX_CONVERSATION_MARKER_VERSION },
          }]
        : isDirect
          ? [{
              type: MATRIX_DIRECT_MARKER_TYPE,
              state_key: "",
              content: { version: MATRIX_CONVERSATION_MARKER_VERSION },
            }]
          : []),
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

export async function acceptEncryptedGroupInvitation(
  client: MatrixClient,
  roomId: string,
): Promise<void> {
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "invite") {
    throw new Error("This group invitation is no longer available.");
  }
  if (!room.hasEncryptionStateEvent()) {
    throw new Error(
      "This group invitation does not contain confirmed encryption state, so it was not accepted.",
    );
  }

  const joinedRoom = await client.joinRoom(roomId);
  const activeRoom = client.getRoom(roomId) ?? joinedRoom;
  if (activeRoom.getMyMembership() !== "join") {
    throw new Error("The group invitation was accepted, but the room did not finish joining.");
  }
  if (!activeRoom.hasEncryptionStateEvent()) {
    throw new Error("You joined the group, but its encrypted-room state is unavailable.");
  }

  const crypto = client.getCrypto();
  let encryptionReady = false;
  try {
    encryptionReady = Boolean(
      crypto && (await crypto.isEncryptionEnabledInRoom(roomId)),
    );
  } catch {
    encryptionReady = false;
  }
  if (!encryptionReady) {
    throw new Error(
      "You joined the group, but encryption is not ready on this device. Messages remain blocked until room keys are available.",
    );
  }
}

export async function declineGroupInvitation(
  client: MatrixClient,
  roomId: string,
): Promise<void> {
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "invite") {
    throw new Error("This group invitation is no longer available.");
  }
  await client.leave(roomId);
}

export async function sendEncryptedTextMessage(
  client: MatrixClient,
  roomId: string,
  text: string,
  replyEventId?: string,
): Promise<ISendEventResponse> {
  const body = text.trim();
  if (!body) throw new Error("Message is empty.");

  await assertEncryptedSendReady(client, roomId, replyEventId);
  return replyEventId
    ? client.sendMessage(roomId, { msgtype: MsgType.Text, body, "m.relates_to": { "m.in_reply_to": { event_id: replyEventId } } })
    : client.sendTextMessage(roomId, body);
}

export async function assertEncryptedSendReady(client: MatrixClient, roomId: string, replyEventId?: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Matrix Rust crypto is unavailable; message was not sent.");
  }
  if (!(await crypto.isCrossSigningReady())) {
    throw new Error(
      "Cross-signing is not ready on this account; the message was not sent.",
    );
  }

  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "join") {
    throw new Error("Join the encrypted room before sending a message.");
  }
  const ownUserId = client.getUserId();
  if (
    !ownUserId ||
    !room.currentState.maySendEvent(
      EventType.RoomMessageEncrypted,
      ownUserId,
    )
  ) {
    throw new Error(
      "You do not have permission to send encrypted messages in this room.",
    );
  }
  if (!room?.hasEncryptionStateEvent()) {
    throw new Error(
      "This room is not confirmed as encrypted. The message was not sent.",
    );
  }
  if (replyEventId && (!replyEventId.startsWith("$") || !room.findEventById(replyEventId))) {
    throw new Error("The original message is not confirmed in this room.");
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
