import { ClientEvent, type MatrixClient } from "matrix-js-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readStarred, STARRED_EVENT_TYPE, toggleStarred, writeStarred, type StarredRef } from "../services/matrix/starred";

/** Per-user starred messages, stored in Matrix account data (separate from room pins). */
export function useStarredMessages(client: MatrixClient | null) {
  const [refs, setRefs] = useState<StarredRef[]>(() => (client ? readStarred(client) : []));

  useEffect(() => {
    if (!client) {
      setRefs([]);
      return undefined;
    }
    setRefs(readStarred(client));
    const onAccountData = (event: { getType: () => string }) => {
      if (event.getType() === STARRED_EVENT_TYPE) setRefs(readStarred(client));
    };
    client.on(ClientEvent.AccountData, onAccountData);
    return () => {
      client.off(ClientEvent.AccountData, onAccountData);
    };
  }, [client]);

  const keys = useMemo(() => new Set(refs.map((ref) => `${ref.roomId}|${ref.eventId}`)), [refs]);

  const toggle = useCallback(
    async (ref: StarredRef) => {
      if (!client) throw new Error("Sign in to star messages.");
      const previous = refs;
      const next = toggleStarred(refs, ref);
      setRefs(next);
      try {
        await writeStarred(client, next);
      } catch (cause) {
        setRefs(previous);
        throw cause;
      }
    },
    [client, refs],
  );

  return {
    refs,
    isStarred: (roomId: string, eventId: string) => keys.has(`${roomId}|${eventId}`),
    toggle,
  };
}
