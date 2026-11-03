import { Info, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConnectionBanner } from "../ConnectionBanner";
import { ChannelAnnouncementList } from "./ChannelAnnouncementList";
import { ChannelAvatar } from "./ChannelAvatar";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTabs, type ChannelTab } from "./ChannelTabs";
import { AboutPanel, FilesPanel, LinksPanel, MembersPanel } from "./ChannelTabPanels";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { categoryMeta, memberLabel } from "./channelMeta";
import { useMatrixContext } from "../../context/MatrixContext";
import { useChannels } from "../../hooks/useChannels";
import { useReadReceipts } from "../../hooks/useReadReceipts";
import { useRoomTags } from "../../hooks/useRoomTags";
import type { ApiClient } from "../../services/api/client";
import {
  ANNOUNCEMENT_PAGE,
  publishAnnouncement,
  toggleReaction,
  type AnnouncementDraft,
} from "../../services/matrix/channels";
import { loadOlderMessages } from "../../services/matrix/history";
import { retryFailedMessage } from "../../services/matrix/messaging";
import type { Announcement, Channel, MatrixSession, UserProfile } from "../../types";

export interface ChannelsViewProps {
  api: ApiClient;
  user: UserProfile;
  matrixSession: MatrixSession | null;
  selectedChannelId?: string;
  onSelectChannel: (channelId: string | null) => void;
  onNotify: (message: string, kind: "success" | "error" | "info") => void;
}

const EMPTY_ANNOUNCEMENTS: Announcement[] = [];
const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Public information shown before a user joins a community. */
function CommunityPreview({ channel, matrixToken, joining, onJoin }: { channel: Channel; matrixToken?: string | null; joining: boolean; onJoin: () => void }) {
  const category = categoryMeta(channel.category);
  return (
    <div className="announcement-scroll" id="channel-panel-messages" role="tabpanel" aria-labelledby="channel-tab-messages">
      <div className="community-preview">
        <ChannelAvatar name={channel.name} category={channel.category} avatarUrl={channel.avatar_url} matrixToken={matrixToken} size="lg" />
        <h2>{channel.name}</h2>
        <span className="community-preview-meta">{category.label} · {memberLabel(channel.member_count)}</span>
        <p>{channel.description || "This community has no description yet."}</p>
        <button type="button" className="primary-button" disabled={joining} onClick={onJoin}>
          {joining ? "Joining…" : "Join community"}
        </button>
        <small>Join to read announcements and react to them.</small>
      </div>
    </div>
  );
}

export function ChannelsView({ api, user, matrixSession, selectedChannelId, onSelectChannel, onNotify }: ChannelsViewProps) {
  const { client, channelRooms, status, initialSyncComplete, authenticationError, error: matrixError, manager } = useMatrixContext();
  const channels = useChannels(api, user.id, true);
  const tags = useRoomTags(client, channelRooms);

  const [tab, setTab] = useState<ChannelTab>("messages");
  const [dialog, setDialog] = useState<null | "create" | "edit">(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [membersKey, setMembersKey] = useState(0);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");

  const selectedEntry = useMemo(
    () => channels.entries.find((entry) => entry.channel.id === selectedChannelId) ?? null,
    [channels.entries, selectedChannelId],
  );
  const channel = selectedEntry?.channel ?? null;
  const room = selectedEntry?.room;
  const roomId = channel?.matrix_room_id ?? undefined;
  const member = Boolean(selectedEntry?.member);
  const joined = Boolean(selectedEntry?.joined);
  const canPublish = Boolean(joined && room?.canPublish && channel?.can_publish);
  const announcements = room?.announcements ?? EMPTY_ANNOUNCEMENTS;
  // Members see the live Matrix count the moment someone joins or leaves; the backend record
  // (used before joining) is re-read shortly after so both stay aligned.
  const liveCount = joined && room ? room.joinedCount : channel?.member_count ?? 0;
  const liveChannel = useMemo(
    () => (channel && channel.member_count !== liveCount ? { ...channel, member_count: liveCount } : channel),
    [channel, liveCount],
  );
  const syncedCount = useRef<number | null>(null);
  useEffect(() => {
    if (!channel || !joined || !room) return;
    if (syncedCount.current === room.joinedCount) return;
    const first = syncedCount.current === null;
    syncedCount.current = room.joinedCount;
    if (first) return;
    const timer = window.setTimeout(() => void channels.refreshChannel(channel.id).catch(() => undefined), 1200);
    return () => window.clearTimeout(timer);
  }, [channel, channels, joined, room]);
  useEffect(() => {
    syncedCount.current = null;
  }, [selectedChannelId]);

  useEffect(() => {
    setTab("messages");
    setUploadStatus("");
  }, [selectedChannelId]);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Opening a community refreshes its backend record (membership reconciliation, counts).
  const refreshedId = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedChannelId || !channels.loaded || refreshedId.current === selectedChannelId) return;
    refreshedId.current = selectedChannelId;
    void channels.refreshChannel(selectedChannelId).catch(() => undefined);
  }, [channels, selectedChannelId]);

  // A membership the backend still records while the room is gone (removed, archived) is
  // re-read so the UI switches to the preview state instead of waiting on a room forever.
  useEffect(() => {
    if (!channel || !initialSyncComplete || !member || channel.membership?.status !== "joined" || room) return;
    const timer = window.setTimeout(() => void channels.refreshChannel(channel.id).catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [channel, channels, initialSyncComplete, member, room]);

  useReadReceipts({
    client,
    roomId,
    active: Boolean(joined && status === "connected" && pageVisible && tab === "messages"),
    timelineKey: announcements,
  });

  useEffect(() => {
    if (uploadStatus !== "Published") return;
    const timer = window.setTimeout(() => setUploadStatus(""), 2000);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

  const join = useCallback(
    async (channelId: string) => {
      setJoiningId(channelId);
      try {
        const result = await channels.join(channelId);
        onNotify(
          result.membership?.status === "joined" ? `You joined ${result.name}.` : `Joining ${result.name}…`,
          result.membership?.status === "joined" ? "success" : "info",
        );
        onSelectChannel(channelId);
      } catch (cause) {
        onNotify(errorMessage(cause, "Could not join the community."), "error");
      } finally {
        setJoiningId(null);
      }
    },
    [channels, onNotify, onSelectChannel],
  );

  const leave = useCallback(async () => {
    if (!channel) return;
    if (!window.confirm(`Leave "${channel.name}"? You will stop receiving its announcements.`)) return;
    setBusy(true);
    try {
      await channels.leave(channel.id);
      onNotify(`You left ${channel.name}.`, "success");
    } catch (cause) {
      onNotify(errorMessage(cause, "Could not leave the community."), "error");
    } finally {
      setBusy(false);
    }
  }, [channel, channels, onNotify]);

  const archive = useCallback(async () => {
    if (!channel) return;
    if (!window.confirm(`Archive "${channel.name}"? Members lose access and it disappears from Communities.`)) return;
    setBusy(true);
    try {
      await channels.archive(channel.id);
      onNotify(`Community "${channel.name}" archived.`, "success");
      onSelectChannel(null);
    } catch (cause) {
      onNotify(errorMessage(cause, "The community could not be archived."), "error");
    } finally {
      setBusy(false);
    }
  }, [channel, channels, onNotify, onSelectChannel]);

  const createChannel = useCallback(
    async (input: Parameters<typeof channels.create>[0]) => {
      const created = await channels.create(input);
      setDialog(null);
      onNotify(`Community "${created.name}" created.`, "success");
      onSelectChannel(created.id);
    },
    [channels, onNotify, onSelectChannel],
  );

  const updateChannel = useCallback(
    async (channelId: string, input: Parameters<typeof channels.update>[1]) => {
      await channels.update(channelId, input);
      setDialog(null);
      onNotify("Community updated.", "success");
    },
    [channels, onNotify],
  );

  const publish = useCallback(
    async (draft: AnnouncementDraft) => {
      if (!client || !roomId) throw new Error("Wait for the messaging connection.");
      if (!channel?.can_publish) throw new Error("Only community admins can post announcements.");
      try {
        await publishAnnouncement(client, roomId, draft, setUploadStatus);
        if (draft.file) setUploadStatus("Published");
      } catch (cause) {
        setUploadStatus("");
        throw cause;
      }
    },
    [channel?.can_publish, client, roomId],
  );

  const handleReaction = useCallback(
    (announcement: Announcement, key: string) => {
      if (!client || !roomId) return;
      toggleReaction(client, roomId, announcement, key).catch((cause) =>
        onNotify(errorMessage(cause, "The reaction could not be updated."), "error"));
    },
    [client, onNotify, roomId],
  );

  const handleRetry = useCallback(
    (announcement: Announcement) => {
      if (!client || !roomId || !announcement.matrix?.eventId) return;
      retryFailedMessage(client, roomId, announcement.matrix.eventId).catch((cause) =>
        onNotify(errorMessage(cause, "Retry failed."), "error"));
    },
    [client, onNotify, roomId],
  );

  const loadOlder = useCallback(async () => {
    if (!client || !roomId || !manager) return;
    const matrixRoom = client.getRoom(roomId);
    if (!matrixRoom) return;
    setLoadingOlder(true);
    try {
      await loadOlderMessages(client, matrixRoom);
      manager.setChannelWindow(roomId, announcements.length + ANNOUNCEMENT_PAGE);
    } catch (cause) {
      onNotify(errorMessage(cause, "Older announcements could not be loaded."), "error");
    } finally {
      setLoadingOlder(false);
    }
  }, [announcements.length, client, manager, onNotify, roomId]);

  const toggleFavorite = useCallback(async () => {
    if (!roomId) return;
    try {
      await tags.toggleFavorite(roomId);
    } catch (cause) {
      onNotify(errorMessage(cause, "Could not update favourites."), "error");
    }
  }, [onNotify, roomId, tags]);

  const cardChannel = useMemo(
    () => (channel ? { name: channel.name, category: channel.category, avatarUrl: channel.avatar_url } : null),
    [channel],
  );

  const renderDetail = (selected: Channel) => {
    const joiningThis = joiningId === selected.id;
    return (
      <>
        <ChannelHeader
          channel={selected}
          matrixToken={matrixSession?.access_token}
          member={member}
          joined={joined}
          joining={joiningThis}
          isFavorite={Boolean(roomId && tags.favorites.has(roomId))}
          canFavorite={joined}
          onToggleFavorite={() => void toggleFavorite()}
          onLeave={() => void leave()}
          onJoin={() => void join(selected.id)}
          onEdit={() => setDialog("edit")}
          onArchive={() => void archive()}
          onBack={() => onSelectChannel(null)}
        />
        <ChannelTabs active={tab} memberCount={selected.member_count} onChange={setTab} />
        <ConnectionBanner status={status} initialSyncComplete={initialSyncComplete} authenticationError={authenticationError} error={matrixError} />
        {tab === "messages" && cardChannel && (
          !member ? (
            <CommunityPreview channel={selected} matrixToken={matrixSession?.access_token} joining={joiningThis} onJoin={() => void join(selected.id)} />
          ) : (
            <ChannelAnnouncementList
              channelId={selected.id}
              channel={cardChannel}
              announcements={announcements}
              matrixToken={matrixSession?.access_token}
              canReact={Boolean(joined && room?.canReact)}
              canPublish={canPublish}
              joined={joined}
              hasOlder={Boolean(room?.hasOlder)}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder()}
              onToggleReaction={handleReaction}
              onRetry={handleRetry}
            />
          )
        )}
        {tab === "files" && <FilesPanel announcements={announcements} joined={joined} matrixToken={matrixSession?.access_token} />}
        {tab === "links" && <LinksPanel announcements={announcements} joined={joined} />}
        {tab === "members" && (
          <MembersPanel
            api={api}
            channel={selected}
            joined={joined}
            currentUserId={user.id}
            matrixToken={matrixSession?.access_token}
            refreshKey={`${membersKey}:${selected.member_count}:${room?.joinedCount ?? 0}`}
            onNotify={onNotify}
            onMembershipChanged={() => {
              setMembersKey((value) => value + 1);
              void channels.refreshChannel(selected.id).catch(() => undefined);
            }}
          />
        )}
        {tab === "about" && (
          <AboutPanel
            channel={selected}
            member={member}
            joined={joined}
            busy={busy || joiningThis}
            onJoin={() => void join(selected.id)}
            onLeave={() => void leave()}
            onEdit={() => setDialog("edit")}
          />
        )}
        {tab === "messages" && member && (
          joined ? (
            canPublish ? (
              <div className="channel-composer-wrap">
                <ChannelComposer
                  key={selected.id}
                  channelName={selected.name}
                  disabled={status !== "connected"}
                  uploadStatus={uploadStatus}
                  onPublish={publish}
                />
              </div>
            ) : (
              <div className="channel-readonly-wrap">
                <div className="channel-readonly" role="status">
                  <Info size={18} aria-hidden="true" />
                  <span>Only community admins can post announcements</span>
                </div>
              </div>
            )
          ) : (
            <div className="channel-readonly-wrap">
              <div className="channel-readonly" role="status">
                <Info size={18} aria-hidden="true" />
                <span>{initialSyncComplete ? "Joining the community…" : "Connecting to the community…"}</span>
              </div>
            </div>
          )
        )}
      </>
    );
  };

  return (
    <>
      <ChannelSidebar
        entries={channels.entries}
        selectedId={selectedChannelId}
        matrixToken={matrixSession?.access_token}
        favoriteRoomIds={tags.favorites}
        loading={channels.loading}
        loaded={channels.loaded}
        error={channels.error}
        joiningId={joiningId}
        onSelect={onSelectChannel}
        onJoin={(channelId) => void join(channelId)}
        onCreate={() => setDialog("create")}
        onRetry={() => void channels.refresh()}
      />
      <section className="chat-main channel-main" aria-label="Community">
        {liveChannel ? (
          renderDetail(liveChannel)
        ) : (
          <div className="empty-chat channel-empty">
            <span className="empty-chat-icon"><Radio size={28} /></span>
            <h2>{selectedChannelId && channels.loaded ? "This community is not available" : "Community announcements live here"}</h2>
            <p>
              {selectedChannelId && channels.loaded
                ? "It may have been archived, or you may not have access to it."
                : "Pick a community to read its announcements, join a new one, or create your own."}
            </p>
            {!(selectedChannelId && channels.loaded) && (
              <button type="button" className="primary-button community-empty-create" onClick={() => setDialog("create")}>
                Start a community
              </button>
            )}
          </div>
        )}
      </section>
      <CreateChannelDialog
        open={dialog !== null}
        channel={dialog === "edit" ? channel : null}
        client={client}
        onClose={() => setDialog(null)}
        onCreate={createChannel}
        onUpdate={updateChannel}
      />
    </>
  );
}
