import { useCallback, useEffect, useState } from "react";

import type { ApiClient } from "../services/api/client";
import type { DirectoryUser, UserConnection } from "../types";

/** Accepted contacts and pending connection requests from the FastAPI backend. */
export function useConnections(api: ApiClient, userId: string | undefined) {
  const [connections, setConnections] = useState<UserConnection[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<UserConnection[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<UserConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (showLoading = false): Promise<boolean> => {
      if (!userId) {
        setConnections([]);
        setIncomingRequests([]);
        setOutgoingRequests([]);
        setError(null);
        return true;
      }
      if (showLoading) setLoading(true);
      try {
        const [accepted, incoming, outgoing] = await Promise.all([
          api.request<UserConnection[]>("/connections"),
          api.request<UserConnection[]>("/connections/requests/incoming"),
          api.request<UserConnection[]>("/connections/requests/outgoing"),
        ]);
        setConnections(accepted);
        setIncomingRequests(incoming);
        setOutgoingRequests(outgoing);
        setError(null);
        return true;
      } catch (cause) {
        setConnections([]);
        setError(
          cause instanceof Error ? cause.message : "Connection information is unavailable right now.",
        );
        return false;
      } finally {
        if (showLoading) setLoading(false);
        setLoaded(true);
      }
    },
    [api, userId],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!userId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refresh, userId]);

  const sendRequest = useCallback(
    async (directoryUser: DirectoryUser) => {
      await api.request<UserConnection>("/connections/requests", {
        method: "POST",
        body: JSON.stringify({ recipient_id: directoryUser.id }),
      });
      await refresh();
    },
    [api, refresh],
  );

  const respond = useCallback(
    async (request: UserConnection, action: "accept" | "decline") => {
      await api.request<UserConnection>(
        `/connections/${encodeURIComponent(request.id)}/${action}`,
        { method: "POST" },
      );
      await refresh();
    },
    [api, refresh],
  );

  /** Re-checks the server so a stale client cannot message a removed contact. */
  const verifyAccepted = useCallback(
    async (contactUserId: string): Promise<UserConnection> => {
      const accepted = await api.request<UserConnection[]>("/connections");
      const connection = accepted.find((item) => item.other_user.id === contactUserId);
      if (!connection) {
        void refresh();
        throw new Error("Accept a connection request before starting or sending a direct chat.");
      }
      return connection;
    },
    [api, refresh],
  );

  return {
    connections,
    incomingRequests,
    outgoingRequests,
    loading,
    loaded,
    error,
    refresh,
    sendRequest,
    respond,
    verifyAccepted,
  };
}
