import type { MatrixClient } from "matrix-js-sdk";
import { EventType, MsgType, Preset, Visibility } from "matrix-js-sdk";
import type { ISendEventResponse } from "matrix-js-sdk";

export const MATRIX_GROUP_MARKER_TYPE = "org.recruitable.chat.group";
export const MATRIX_DIRECT_MARKER_TYPE = "org.recruitable.chat.direct";
export const MATRIX_CONVERSATION_MARKER_VERSION = 1;
export const ROOM_ENCRYPTION_EVENT_TYPE = "m.room.encryption";

/**
 * Old rooms carry an `m.room.encryption` state event, which can never be
 * removed. Those rooms are retired: hidden from the UI and never reused.
 */
export function isLegacyEncryptedRoom(room: {
  hasEncryptionStateEvent?: () => boolean;
  currentState?: { getStateEvents: (type: string, key: string) => unknown };
}): boolean {
  if (typeof room.hasEncryptionStateEvent === "function" && room.hasEncryptionStateEvent()) {
    return true;
  }
  return Boolean(room.currentState?.getStateEvents(ROOM_ENCRYPTION_EVENT_TYPE, ""));
}

export interface CreatePlainRoomOptions {
  invitees: string[];
  name?: string;
  isDirect?: boolean;
  isGroup?: boolean;
}

export async function createPlainRoom(
  client: MatrixClient,
  options: CreatePlainRoomOptions,
): Promise<string> {
  if (options.invitees.length === 0) {
    throw new Error("A room must have at least one invitee.");
  }
  if (new Set(options.invitees).size !== options.invitees.length) {
    throw new Error("A participant can only be invited to a room once.");
  }
  const ownUserId = client.getUserId();
  if (ownUserId && options.invitees.includes(ownUserId)) {
    throw new Error("You cannot invite yourself to a conversation.");
  }
  const name = options.name?.trim();
  if (options.isGroup && !name) throw new Error("Enter a name for the group.");
  if (options.isGroup && options.invitees.length < 2) {
    throw new Error("Select at least two accepted contacts for a group.");
  }
  if (options.isGroup && options.isDirect === true) {
    throw new Error("A group conversation cannot be marked as a direct chat.");
  }
  const isDirect = options.isDirect ?? options.invitees.length === 1;

  // No m.room.encryption state is set: the room is plaintext by design.
  const result = await client.createRoom({
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    is_direct: isDirect,
    invite: [...new Set(options.invitees)],
    ...(name ? { name } : {}),
    initial_state: [
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
  return result.room_id;
}

export async function acceptGroupInvitation(
  client: MatrixClient,
  roomId: string,
): Promise<void> {
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "invite") {
    throw new Error("This group invitation is no longer available.");
  }
  if (isLegacyEncryptedRoom(room)) {
    throw new Error("This invitation is for a retired encrypted room and cannot be accepted.");
  }
  const joinedRoom = await client.joinRoom(roomId);
  const activeRoom = client.getRoom(roomId) ?? joinedRoom;
  if (activeRoom.getMyMembership() !== "join") {
    throw new Error("The group invitation was accepted, but the room did not finish joining.");
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

export function assertSendReady(client: MatrixClient, roomId: string, replyEventId?: string): void {
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "join") {
    throw new Error("Join the room before sending a message.");
  }
  if (isLegacyEncryptedRoom(room)) {
    throw new Error("This is a retired encrypted room. Start a new conversation instead.");
  }
  const ownUserId = client.getUserId();
  if (!ownUserId || !room.currentState.maySendEvent(EventType.RoomMessage, ownUserId)) {
    throw new Error("You do not have permission to send messages in this room.");
  }
  if (replyEventId && (!replyEventId.startsWith("$") || !room.findEventById(replyEventId))) {
    throw new Error("The original message is not confirmed in this room.");
  }
}

export async function sendTextMessage(
  client: MatrixClient,
  roomId: string,
  text: string,
  replyEventId?: string,
): Promise<ISendEventResponse> {
  const body = text.trim();
  if (!body) throw new Error("Message is empty.");
  assertSendReady(client, roomId, replyEventId);
  return client.sendMessage(roomId, {
    msgtype: MsgType.Text,
    body,
    ...(replyEventId ? { "m.relates_to": { "m.in_reply_to": { event_id: replyEventId } } } : {}),
  });
}
