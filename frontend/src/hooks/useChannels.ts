import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMatrixContext } from "../context/MatrixContext";
import { channelsApi } from "../services/api/channels";
import type { ApiClient } from "../services/api/client";
import type { ChannelRoomSummary } from "../services/matrix/channels";
import type { Channel, ChannelCreateInput, ChannelUpdateInput } from "../types";

export interface ChannelEntry {
  channel: Channel;
  /** Live Matrix data for the community's room; absent until the user is joined or invited. */
  room?: ChannelRoomSummary;
  /** Backend records the user as a member (joined, or invited and about to join). */
  member: boolean;
  /** Membership is confirmed on both the backend and the Matrix room. */
  joined: boolean;
}

export interface UseChannelsResult {
  entries: ChannelEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshChannel: (channelId: string) => Promise<Channel>;
  create: (input: ChannelCreateInput) => Promise<Channel>;
  update: (channelId: string, input: ChannelUpdateInput) => Promise<Channel>;
  archive: (channelId: string) => Promise<void>;
  join: (channelId: string) => Promise<Channel>;
  leave: (channelId: string) => Promise<Channel>;
}

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Last known community list per user, so re-opening Communities renders before the refresh lands. */
const listCache = new Map<string, Channel[]>();
const JOIN_RETRY_MS = 30_000;

export function isMember(channel: Channel): boolean {
  const status = channel.membership?.status;
  return status === "joined" || status === "invited";
}

/** Keeps the first occurrence of every community ID, whatever the backend or cache returned. */
export function dedupeChannels(channels: Channel[]): Channel[] {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    if (seen.has(channel.id)) return false;
    seen.add(channel.id);
    return true;
  });
}

/**
 * Backend community registry merged with the Matrix sync snapshot. Only communities the backend
 * returns are ever shown; channel-type rooms it does not list stay hidden everywhere.
 */
export function useChannels(api: ApiClient, userId: string | undefined, enabled: boolean): UseChannelsResult {
  const { client, channelRooms, initialSyncComplete } = useMatrixContext();
  const [channels, setChannels] = useState<Channel[] | null>(() => (userId && listCache.get(userId)) || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const joinAttempts = useRef(new Map<string, number>());
  const inflight = useRef(new Map<string, Promise<Channel>>());

  const store = useCallback(
    (updater: (current: Channel[]) => Channel[]) => {
      setChannels((current) => {
        const next = dedupeChannels(updater(current ?? []));
        if (userId) listCache.set(userId, next);
        return next;
      });
    },
    [userId],
  );
  const applyChannel = useCallback(
    (channel: Channel) =>
      store((current) =>
        current.some((item) => item.id === channel.id)
          ? current.map((item) => (item.id === channel.id ? channel : item))
          : [...current, channel],
      ),
    [store],
  );

  const refresh = useCallback(async () => {
    if (!userId) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const list = dedupeChannels(await channelsApi.list(api));
      if (id !== requestId.current) return;
      listCache.set(userId, list);
      setChannels(list);
      setError(null);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(errorMessage(cause, "Communities could not be loaded."));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [api, userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    void refresh();
  }, [enabled, refresh, userId]);

  const refreshChannel = useCallback(
    async (channelId: string) => {
      const channel = await channelsApi.get(api, channelId);
      applyChannel(channel);
      return channel;
    },
    [api, applyChannel],
  );

  // Invites the backend arranged are accepted here (needed when the service identity cannot
  // join users itself). The detail read afterwards reconciles the membership to "joined".
  useEffect(() => {
    if (!client || !initialSyncComplete || !channels) return;
    for (const channel of channels) {
      const roomId = channel.matrix_room_id;
      if (!roomId || !isMember(channel)) continue;
      if (channelRooms[roomId]?.membership !== "invite") continue;
      const last = joinAttempts.current.get(roomId) ?? 0;
      if (Date.now() - last < JOIN_RETRY_MS) continue;
      joinAttempts.current.set(roomId, Date.now());
      void client
        .joinRoom(roomId)
        .then(() => refreshChannel(channel.id))
        .catch(() => undefined);
    }
  }, [channelRooms, channels, client, initialSyncComplete, refreshChannel]);

  /** One request per key at a time; a double-click shares the in-flight promise. */
  const once = useCallback((key: string, run: () => Promise<Channel>) => {
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const promise = run().finally(() => {
      if (inflight.current.get(key) === promise) inflight.current.delete(key);
    });
    inflight.current.set(key, promise);
    return promise;
  }, []);

  const create = useCallback(
    (input: ChannelCreateInput) =>
      once(`create:${input.request_id ?? input.name}`, async () => {
        const channel = await channelsApi.create(api, input);
        applyChannel(channel);
        return channel;
      }),
    [api, applyChannel, once],
  );
  const update = useCallback(
    async (channelId: string, input: ChannelUpdateInput) => {
      const channel = await channelsApi.update(api, channelId, input);
      applyChannel(channel);
      return channel;
    },
    [api, applyChannel],
  );
  const archive = useCallback(
    async (channelId: string) => {
      await channelsApi.archive(api, channelId);
      store((current) => current.filter((item) => item.id !== channelId));
    },
    [api, store],
  );
  const join = useCallback(
    (channelId: string) =>
      once(`join:${channelId}`, async () => {
        let channel = await channelsApi.join(api, channelId);
        applyChannel(channel);
        if (channel.membership?.status === "invited" && channel.matrix_room_id && client) {
          try {
            await client.joinRoom(channel.matrix_room_id);
            channel = await refreshChannel(channel.id);
          } catch {
            // The invite is still pending; the auto-join effect retries once the room syncs.
          }
        }
        return channel;
      }),
    [api, applyChannel, client, once, refreshChannel],
  );
  const leave = useCallback(
    (channelId: string) =>
      once(`leave:${channelId}`, async () => {
        const channel = await channelsApi.leave(api, channelId);
        applyChannel(channel);
        return channel;
      }),
    [api, applyChannel, once],
  );

  const entries = useMemo<ChannelEntry[]>(
    () =>
      dedupeChannels(channels ?? [])
        .filter((channel) => channel.status === "active" || channel.status === "provisioning")
        .map((channel) => {
          const room = channel.matrix_room_id ? channelRooms[channel.matrix_room_id] : undefined;
          const member = isMember(channel);
          return { channel, room, member, joined: member && room?.membership === "join" };
        }),
    [channelRooms, channels],
  );

  return { entries, loaded: channels !== null, loading, error, refresh, refreshChannel, create, update, archive, join, leave };
}
