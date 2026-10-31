import { useEffect, useMemo, useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";

import {
  pinnedSummaryFromMessage,
  type PinnedMessageSummary,
} from "../components/chat/PinnedMessageBanner";
import { loadMatrixMessagePreview } from "../services/matrix/messageNavigation";
import { getPinnedEventIds } from "../services/matrix/pinning";
import type { Message } from "../types";

/** Resolves banner summaries for the selected room's pinned events. */
export function usePinnedMessages(
  client: MatrixClient | null,
  room: Room | null | undefined,
  fallbackName: string,
  messages: Message[] | undefined,
) {
  const roomId = room?.roomId;
  const pinnedEventIds = getPinnedEventIds(room);
  const key = pinnedEventIds.join("\u0000");
  const pinnedEventIdSet = useMemo(() => new Set(pinnedEventIds), [key, roomId]);
  const [state, setState] = useState<{ roomId: string; items: PinnedMessageSummary[] } | null>(null);

  useEffect(() => {
    if (!roomId || !room || !client || pinnedEventIds.length === 0) {
      setState(roomId ? { roomId, items: [] } : null);
      return;
    }
    let cancelled = false;
    void Promise.all(
      pinnedEventIds.map(async (eventId) => {
        try {
          return pinnedSummaryFromMessage(
            eventId,
            await loadMatrixMessagePreview(client, room, eventId, fallbackName),
          );
        } catch {
          return pinnedSummaryFromMessage(eventId, null);
        }
      }),
    ).then((items) => {
      if (!cancelled) setState({ roomId, items });
    });
    return () => {
      cancelled = true;
    };
  }, [client, key, messages, roomId, room, fallbackName]);

  return {
    pinnedEventIds,
    pinnedEventIdSet,
    summaries: state && state.roomId === roomId ? state.items : [],
  };
}
