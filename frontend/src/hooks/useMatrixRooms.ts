import { useCallback, useEffect, useRef, useState } from "react";

import type { Conversation, Message, MatrixSession } from "../types";
import {
  createMatrixDirectRoom,
  createOptimisticMessage,
  MatrixApiError,
  MATRIX_SERVER_NAME,
  mergeMatrixSync,
  markMatrixRoomRead,
  sendMatrixFile,
  sendMatrixText,
  syncMatrix,
  type MatrixEvent,
  type MatrixRoomView,
} from "../services/matrix/client";

type MatrixStatus = "disabled" | "syncing" | "ready" | "error";

interface UseMatrixRoomsResult {
  rooms: Conversation[];
  status: MatrixStatus;
  error: string | null;
  sendText: (roomId: string, text: string) => Promise<void>;
  sendFile: (roomId: string, file: File) => Promise<void>;
  createDirect: (
    userId: string,
    displayName: string,
    matrixUserId: string,
  ) => Promise<string>;
  markRead: (roomId: string, eventId: string) => Promise<void>;
  retry: () => void;
}

function appendOptimisticMessage(
  room: MatrixRoomView,
  message: Message,
): MatrixRoomView {
  return {
    ...room,
    conversation: {
      ...room.conversation,
      messages: [...room.conversation.messages, message],
      lastMessage: message.text || message.attachment?.name || "Attachment",
      updatedAt: message.sentAt,
    },
  };
}

function updateMessage(
  room: MatrixRoomView,
  originalId: string,
  updated: Message,
  event?: MatrixEvent,
): MatrixRoomView {
  return {
    ...room,
    conversation: {
      ...room.conversation,
      messages: room.conversation.messages.map((message) =>
        message.id === originalId ? updated : message,
      ),
      lastMessage: updated.text || updated.attachment?.name || "Attachment",
      updatedAt: updated.sentAt,
    },
    messageEvents: event
      ? [...room.messageEvents.filter((item) => item.event_id !== event.event_id), event]
      : room.messageEvents,
  };
}

export function useMatrixRooms(
  session: MatrixSession | null,
  enabled: boolean,
): UseMatrixRoomsResult {
  const [roomViews, setRoomViews] = useState<MatrixRoomView[]>([]);
  const [status, setStatus] = useState<MatrixStatus>("disabled");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!enabled || !session) {
      setRoomViews([]);
      setStatus("disabled");
      setError(null);
      return;
    }

    let stopped = false;
    let since: string | null = null;
    let controller: AbortController | null = null;

    const runSync = async () => {
      setStatus("syncing");
      setError(null);
      while (!stopped) {
        controller = new AbortController();
        try {
          const update = await syncMatrix(
            session.access_token,
            since,
            controller.signal,
          );
          since = update.next_batch;
          setRoomViews((current) =>
            mergeMatrixSync(current, update, session.user_id),
          );
          setStatus("ready");
          setError(null);
        } catch (cause) {
          if (stopped || controller.signal.aborted) break;
          const message =
            cause instanceof MatrixApiError
              ? cause.message
              : "Matrix sync is temporarily unavailable.";
          setStatus("error");
          setError(message);
          if (cause instanceof MatrixApiError && cause.status === 401) break;
          await new Promise((resolve) => window.setTimeout(resolve, 2500));
        }
      }
    };

    void runSync();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }, [enabled, retryCount, session?.access_token, session?.user_id]);

  const sendText = useCallback(async (roomId: string, text: string) => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error("Sign in to send a message.");
    const localId = `local-${crypto.randomUUID()}`;
    const message = createOptimisticMessage(localId, text);
    setRoomViews((current) =>
      current.map((room) =>
        room.conversation.id === roomId
          ? appendOptimisticMessage(room, message)
          : room,
      ),
    );
    try {
      const result = await sendMatrixText(
        activeSession.access_token,
        roomId,
        text,
      );
      const sentAt = new Date();
      const sentMessage: Message = {
        ...message,
        id: result.event_id,
        sentAt,
        delivery: "sent",
      };
      const event: MatrixEvent = {
        event_id: result.event_id,
        type: "m.room.message",
        sender: activeSession.user_id,
        origin_server_ts: sentAt.getTime(),
        content: { msgtype: "m.text", body: text },
      };
      setRoomViews((current) =>
        current.map((room) =>
          room.conversation.id === roomId
            ? updateMessage(room, localId, sentMessage, event)
            : room,
        ),
      );
    } catch (cause) {
      setRoomViews((current) =>
        current.map((room) =>
          room.conversation.id === roomId
            ? updateMessage(room, localId, { ...message, delivery: "failed" })
            : room,
        ),
      );
      throw cause;
    }
  }, []);

  const sendFile = useCallback(async (roomId: string, file: File) => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error("Sign in to send an attachment.");
    const localId = `local-${crypto.randomUUID()}`;
    const isImage = file.type.startsWith("image/");
    const message = createOptimisticMessage(localId, "", {
      name: file.name,
      size: file.size,
      mimeType: file.type,
      kind: isImage ? "image" : "file",
    });
    setRoomViews((current) =>
      current.map((room) =>
        room.conversation.id === roomId
          ? appendOptimisticMessage(room, message)
          : room,
      ),
    );
    try {
      const result = await sendMatrixFile(
        activeSession.access_token,
        roomId,
        file,
      );
      const sentAt = new Date();
      const sentMessage: Message = {
        ...message,
        id: result.event_id,
        sentAt,
        delivery: "sent",
        attachment: {
          ...message.attachment!,
          mediaUri: result.content_uri,
        },
      };
      const event: MatrixEvent = {
        event_id: result.event_id,
        type: "m.room.message",
        sender: activeSession.user_id,
        origin_server_ts: sentAt.getTime(),
        content: {
          msgtype: isImage ? "m.image" : "m.file",
          body: file.name,
          url: result.content_uri,
          info: { mimetype: file.type, size: file.size },
        },
      };
      setRoomViews((current) =>
        current.map((room) =>
          room.conversation.id === roomId
            ? updateMessage(room, localId, sentMessage, event)
            : room,
        ),
      );
    } catch (cause) {
      setRoomViews((current) =>
        current.map((room) =>
          room.conversation.id === roomId
            ? updateMessage(room, localId, { ...message, delivery: "failed" })
            : room,
        ),
      );
      throw cause;
    }
  }, []);

  const createDirect = useCallback(
    async (userId: string, displayName: string, matrixUserId: string) => {
      const activeSession = sessionRef.current;
      if (!activeSession) throw new Error("Sign in to start a conversation.");
      const result = await createMatrixDirectRoom(
        activeSession.access_token,
        matrixUserId,
        displayName,
      );
      const initials = displayName
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();
      const conversation: Conversation = {
        id: result.room_id,
        roomId: result.room_id,
        name: displayName,
        username: userId,
        matrixUserId,
        initials: initials || "??",
        accent: Math.abs(result.room_id.length * 13) % 6,
        lastMessage: "Conversation started",
        updatedAt: new Date(),
        unreadCount: 0,
        messages: [],
        bio: "Matrix conversation",
        isDemo: false,
      };
      const stateEvents: MatrixEvent[] = [
        {
          type: "m.room.member",
          state_key: activeSession.user_id,
          content: { membership: "join" },
        },
        {
          type: "m.room.member",
          state_key: matrixUserId,
          content: { membership: "invite", displayname: displayName },
        },
      ];
      setRoomViews((current) => {
        if (current.some((room) => room.conversation.id === result.room_id)) {
          return current;
        }
        return [
          {
            conversation,
            stateEvents,
            messageEvents: [],
            presenceEvents: [],
          },
          ...current,
        ];
      });
      return result.room_id;
    },
    [],
  );

  const markRead = useCallback(async (roomId: string, eventId: string) => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    try {
      await markMatrixRoomRead(activeSession.access_token, roomId, eventId);
      setRoomViews((current) =>
        current.map((room) =>
          room.conversation.id === roomId
            ? {
                ...room,
                conversation: { ...room.conversation, unreadCount: 0 },
              }
            : room,
        ),
      );
    } catch {
      // Opening a room remains useful if its read receipt cannot be sent.
    }
  }, []);

  const retry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  return {
    rooms: roomViews.map((room) => room.conversation),
    status,
    error,
    sendText,
    sendFile,
    createDirect,
    markRead,
    retry,
  };
}
