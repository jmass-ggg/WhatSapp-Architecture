import { useEffect, useRef } from "react";
import { ReceiptType, type MatrixClient } from "matrix-js-sdk";

interface ReadReceiptOptions {
  client: MatrixClient | null;
  roomId: string | undefined;
  /** Send only while the conversation is actually on screen and joined. */
  active: boolean;
  /** Changes whenever the room timeline changes, so a new message re-runs the check. */
  timelineKey: unknown;
}

/** Sends an `m.read` receipt for the newest incoming message of the open room. */
export function useReadReceipts({ client, roomId, active, timelineKey }: ReadReceiptOptions) {
  const lastSent = useRef("");

  useEffect(() => {
    if (!active || !client || !roomId) return;
    const room = client.getRoom(roomId);
    const ownUserId = client.getUserId();
    if (!room || !ownUserId || room.getMyMembership() !== "join") return;

    const events = room.getLiveTimeline().getEvents();
    const lastIncoming = [...events].reverse().find(
      (event) =>
        event.getSender() !== ownUserId &&
        event.getId() &&
        event.getType() === "m.room.message",
    );
    if (!lastIncoming) return;

    const ownReceipt = room.getReadReceiptForUserId(ownUserId, true, ReceiptType.Read);
    const ownIndex = ownReceipt
      ? events.findIndex((event) => event.getId() === ownReceipt.eventId)
      : -1;
    if (ownIndex >= events.indexOf(lastIncoming)) return;

    const key = `${ownUserId}:${roomId}:${lastIncoming.getId()}`;
    if (lastSent.current === key) return;
    lastSent.current = key;
    void client.sendReadReceipt(lastIncoming).catch(() => {
      if (lastSent.current === key) lastSent.current = "";
    });
  }, [active, client, roomId, timelineKey]);
}
