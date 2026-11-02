import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EventType } from "matrix-js-sdk";

import { AppLayout } from "../layouts/AppLayout";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { ChannelsView } from "../components/channels/ChannelsView";
import { ContactsView } from "../components/contacts/ContactsView";
import { NavigationRail, type NavSection } from "../components/NavigationRail";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { ChatHeader } from "../components/chat/ChatHeader";
import { MessageComposer } from "../components/chat/MessageComposer";
import { MessageList, type MessageListHandle } from "../components/chat/MessageList";
import { ConversationInfoPanel, type StarredEntry } from "../components/chat/ConversationInfoPanel";
import { RoomSearchBar } from "../components/chat/RoomSearchBar";
import { PinnedMessageBanner } from "../components/chat/PinnedMessageBanner";
import { NewConversationDialog } from "../components/chat/NewConversationDialog";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { useMatrixContext } from "../context/MatrixContext";
import { useConnections } from "../hooks/useConnections";
import { useMatrixRooms } from "../hooks/useMatrixRooms";
import { usePinnedMessages } from "../hooks/usePinnedMessages";
import { useStarredMessages } from "../hooks/useStarredMessages";
import { useRoomTags } from "../hooks/useRoomTags";
import { useReadReceipts } from "../hooks/useReadReceipts";
import { sendAttachment, sendVoiceMessage, type VoiceRecording, type VoiceSendAttempt } from "../services/matrix/attachments";
import { matrixUserIdForAppUserId } from "../services/matrix/identity";
import {
  acceptGroupInvitation,
  assertSendReady,
  declineGroupInvitation,
  sendTextMessage,
  queueTextMessage,
  retryFailedMessage,
} from "../services/matrix/messaging";
import { roomMembers, roomTopic } from "../services/matrix/members";
import type { MentionEntity } from "../services/matrix/mentions";
import { extractSharedContent } from "../services/matrix/sharedContent";
import { hasOlderHistory, loadOlderMessages } from "../services/matrix/history";
import { loadMatrixMessage } from "../services/matrix/messageNavigation";
import { canManagePinnedMessages, getPinnedEventIds, updatePinnedEvent } from "../services/matrix/pinning";
import type { Conversation, Message, UserConnection } from "../types";

const CONNECTION_VERIFY_TTL_MS = 15_000;

type ToastState = { message: string; kind: "success" | "error" | "info" };

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function conversationForContact(connection: UserConnection): Conversation {
  const contact = connection.other_user;
  const name = contact.profile?.display_name || contact.username;
  return {
    id: `contact:${contact.id}`,
    contactUserId: contact.id,
    connectionUserId: contact.id,
    connectionAllowed: true,
    name,
    username: contact.username,
    matrixUserId: matrixUserIdForAppUserId(contact.id),
    initials: initialsFor(name),
    avatarUrl: contact.profile?.profile_picture_url,
    accent: Math.abs(contact.id.length * 13) % 6,
    lastMessage: "Start a conversation",
    updatedAt: new Date(0),
    unreadCount: 0,
    messages: [],
    bio: contact.profile?.bio ?? "Contact",
    jobTitle: contact.profile?.job_title ?? undefined,
    department: contact.profile?.department ?? undefined,
    about: contact.profile?.bio ?? undefined,
    isGroup: false,
  };
}

const SECTION_PATHS: Record<NavSection, string> = {
  chats: "/chat",
  groups: "/groups",
  channels: "/channels",
  contacts: "/contacts",
  settings: "/chat",
};

export function ChatPage({ section = "chats" }: { section?: NavSection }) {
  const basePath = section === "groups" ? "/groups" : "/chat";
  const { user, mode, matrixSession, api, signOut } = useAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const matrix = useMatrixRooms();
  const { client, presence } = useMatrixContext();
  const tags = useRoomTags(client, matrix.rooms);
  const starred = useStarredMessages(client);
  const contacts = useConnections(api, mode === "live" ? user?.id : undefined);

  const [dialog, setDialog] = useState<null | "chat" | "group">(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activePinnedIndex, setActivePinnedIndex] = useState(0);
  const [attachmentProgress, setAttachmentProgress] = useState("");
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [startingContactId, setStartingContactId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [highlightedMember, setHighlightedMember] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const messageListRef = useRef<MessageListHandle>(null);
  const groupCreationPromise = useRef<Promise<void> | null>(null);

  const notify = useCallback(
    (message: string, kind: ToastState["kind"] = "info") => setToast({ message, kind }),
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  const connectionsByMatrixUserId = useMemo(
    () => new Map(contacts.connections.map((c) => [matrixUserIdForAppUserId(c.other_user.id), c])),
    [contacts.connections],
  );

  const conversations = useMemo(() => {
    const roomConversations = matrix.rooms.map((room) => {
      if (room.isGroup) return { ...room, presence: undefined, connectionAllowed: true };
      const connection = room.matrixUserId ? connectionsByMatrixUserId.get(room.matrixUserId) : undefined;
      const contact = connection?.other_user;
      return {
        ...room,
        contactUserId: contact?.id,
        connectionUserId: contact?.id,
        connectionAllowed: Boolean(connection),
        presence: room.matrixUserId ? presence[room.matrixUserId] ?? "unknown" : "unknown",
        name: contact?.profile?.display_name || contact?.username || room.name,
        username: contact?.username || room.username,
        jobTitle: contact?.profile?.job_title ?? undefined,
        department: contact?.profile?.department ?? undefined,
        about: contact?.profile?.bio ?? undefined,
        avatarUrl: contact?.profile?.profile_picture_url ?? room.avatarUrl,
      };
    });
    const withRooms = new Set(
      roomConversations.filter((room) => !room.isGroup && room.matrixUserId).map((room) => room.matrixUserId as string),
    );
    const withoutRooms = contacts.connections
      .filter((c) => !withRooms.has(matrixUserIdForAppUserId(c.other_user.id)))
      .map(conversationForContact);
    return [...roomConversations, ...withoutRooms].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  }, [contacts.connections, connectionsByMatrixUserId, matrix.rooms, presence]);

  const selectedConversation = conversationId
    ? conversations.find((conversation) => conversation.id === conversationId) ?? null
    : null;
  const selectedId = selectedConversation?.id;
  useEffect(() => {
    setReplyTo(null);
    setSearchOpen(false);
    setInfoOpen(false);
    setSearchTerm("");
  }, [selectedId]);

  const selectedRoom = selectedId ? client?.getRoom(selectedId) : null;
  const ownMatrixUserId = client?.getUserId();
  const isInvited = selectedRoom?.getMyMembership() === "invite";
  const isDirect = Boolean(selectedConversation && !selectedConversation.isGroup);
  const peerId = selectedConversation?.matrixUserId;
  const peerJoined = Boolean(
    peerId && selectedRoom?.getMembers().some((m) => m.userId === peerId && m.membership === "join"),
  );
  const maySend = (userId: string | undefined | null) =>
    Boolean(selectedRoom && userId && selectedRoom.currentState.maySendEvent(EventType.RoomMessage, userId));
  const canSend = Boolean(
    selectedRoom &&
      selectedRoom.getMyMembership() === "join" &&
      (!isDirect || (peerJoined && maySend(peerId))) &&
      maySend(ownMatrixUserId),
  );
  const canShowComposer = Boolean(
    selectedConversation && (selectedConversation.isGroup || selectedConversation.connectionAllowed === true),
  );

  const pins = usePinnedMessages(
    client,
    selectedRoom,
    selectedConversation?.isGroup ? "A participant" : selectedConversation?.name ?? "Contact",
    selectedConversation?.messages,
  );
  const shared = useMemo(
    () => extractSharedContent(selectedConversation?.messages ?? []),
    [selectedConversation?.messages],
  );
  const starredInRoom = useMemo<StarredEntry[]>(() => {
    if (!selectedId) return [];
    const byId = new Map(
      (selectedConversation?.messages ?? []).flatMap((m) => (m.matrix ? [[m.matrix.eventId, m] as const] : [])),
    );
    return starred.refs
      .filter((ref) => ref.roomId === selectedId)
      .map<StarredEntry>(({ eventId }) => {
        const message = byId.get(eventId);
        return message
          ? { eventId, text: message.text, senderName: message.sender === "me" ? "You" : message.senderName ?? selectedConversation?.name, sentAt: message.sentAt }
          : { eventId };
      });
  }, [selectedConversation?.messages, selectedConversation?.name, selectedId, starred.refs]);
  const starredEventIds = useMemo(() => new Set(starredInRoom.map((entry) => entry.eventId)), [starredInRoom]);
  const members = useMemo(
    () => (selectedRoom && selectedConversation?.isGroup ? roomMembers(selectedRoom) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRoom, selectedConversation?.isGroup, selectedConversation?.messages, matrix.rooms],
  );
  // Mention candidates are always the active room's joined members (groups and direct rooms alike).
  const mentionMembers = useMemo(
    () => (selectedRoom ? roomMembers(selectedRoom) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRoom, selectedConversation?.messages, matrix.rooms],
  );
  const openMention = useCallback((userId: string) => {
    // Resolve by Matrix ID within this room only; never by display name.
    if (!mentionMembers.some((m) => m.userId === userId)) {
      notify("That person is no longer in this conversation.", "error");
      return;
    }
    setHighlightedMember(userId);
    setInfoOpen(true);
  }, [mentionMembers, notify]);
  const canManagePins = canManagePinnedMessages(selectedRoom, ownMatrixUserId);
  useEffect(() => setActivePinnedIndex(0), [selectedId]);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useReadReceipts({
    client,
    roomId: selectedId,
    active: Boolean(
      mode === "live" && matrix.status === "connected" && pageVisible && conversationId &&
        selectedConversation && !isInvited && canShowComposer,
    ),
    timelineKey: selectedConversation?.messages,
  });

  const loadMessageForJump = useCallback(
    async (eventId: string) => {
      if (!client || !selectedRoom || !selectedConversation) {
        throw new Error("Select a joined conversation before opening that message.");
      }
      return loadMatrixMessage(
        client, selectedRoom, eventId,
        selectedConversation.isGroup ? "A participant" : selectedConversation.name, true,
      );
    },
    [client, selectedConversation, selectedRoom],
  );

  const togglePinnedMessage = useCallback(
    async (eventId: string) => {
      const userId = client?.getUserId();
      if (!client || !selectedRoom || !userId) {
        notify("Sign in to manage pinned messages.", "error");
        return;
      }
      const action = getPinnedEventIds(selectedRoom).includes(eventId) ? "unpin" : "pin";
      try {
        await updatePinnedEvent(client, selectedRoom, userId, eventId, action);
        notify(action === "pin" ? "Message pinned." : "Message unpinned.", "success");
      } catch (cause) {
        notify(errorMessage(cause, "Pinned messages could not be updated."), "error");
      }
    },
    [client, notify, selectedRoom],
  );

  const respondToRequest = useCallback(
    async (request: UserConnection, action: "accept" | "decline") => {
      setRespondingRequestId(request.id);
      try {
        await contacts.respond(request, action);
        notify(
          action === "accept"
            ? `You are now connected with @${request.other_user.username}.`
            : `Request from @${request.other_user.username} declined.`,
          "success",
        );
      } catch (cause) {
        notify(errorMessage(cause, "The connection request could not be updated."), "error");
      } finally {
        setRespondingRequestId(null);
      }
    },
    [contacts.respond, notify],
  );

  const sendConnectionRequest = useCallback(
    async (directoryUser: Parameters<typeof contacts.sendRequest>[0]) => {
      await contacts.sendRequest(directoryUser);
      notify(`Connection request sent to @${directoryUser.username}.`, "success");
    },
    [contacts.sendRequest, notify],
  );

  const createGroup = useCallback(
    async (name: string, contactUserIds: string[]) => {
      if (groupCreationPromise.current) return groupCreationPromise.current;
      const creation = (async () => {
        if (mode !== "live" || !client || !user) throw new Error("Sign in to create a group.");
        if (!matrix.initialSyncComplete) throw new Error("Wait for the connection to finish syncing before creating a group.");
        const unique = [...new Set(contactUserIds)];
        if (unique.length !== contactUserIds.length || unique.length < 2) {
          throw new Error("Select at least two different accepted contacts.");
        }
        if (unique.includes(user.id)) throw new Error("The current user cannot be selected as a group participant.");
        // Authorization is re-checked against the server, not the cached contact list.
        const accepted = await api.request<UserConnection[]>("/connections");
        const acceptedIds = new Set(accepted.filter((c) => c.status === "accepted").map((c) => c.other_user.id));
        if (unique.some((id) => !acceptedIds.has(id))) {
          throw new Error("Groups can only include your currently accepted contacts.");
        }
        const roomId = await matrix.createGroup(name, unique.map(matrixUserIdForAppUserId));
        setDialog(null);
        navigate(`/groups/${encodeURIComponent(roomId)}`);
        notify(`Group "${name.trim()}" created. Invitations were sent.`, "success");
      })();
      groupCreationPromise.current = creation;
      try {
        await creation;
      } finally {
        if (groupCreationPromise.current === creation) groupCreationPromise.current = null;
      }
    },
    [api, client, matrix.createGroup, matrix.initialSyncComplete, mode, navigate, notify, user],
  );

  const selectConversation = useCallback(
    async (conversation: Conversation) => {
      const contactUserId = conversation.contactUserId;
      if (!contactUserId || conversation.roomId) {
        navigate(`${basePath}/${encodeURIComponent(conversation.id)}`);
        return;
      }
      if (startingContactId) return;
      setStartingContactId(contactUserId);
      try {
        if (!matrix.initialSyncComplete) throw new Error("Wait for the connection to finish syncing.");
        await contacts.verifyAccepted(contactUserId);
        // createDirect re-discovers existing/pending rooms first and only then creates one.
        const roomId = await matrix.createDirect(
          contactUserId,
          conversation.name,
          matrixUserIdForAppUserId(contactUserId),
        );
        navigate(`/chat/${encodeURIComponent(roomId)}`);
      } catch (cause) {
        notify(errorMessage(cause, "The conversation could not be started."), "error");
      } finally {
        setStartingContactId(null);
      }
    },
    [basePath, contacts.verifyAccepted, matrix.createDirect, matrix.initialSyncComplete, navigate, notify, startingContactId],
  );

  const messageContact = useCallback(
    (contact: UserConnection["other_user"]) => {
      const target = conversations.find((conversation) => !conversation.isGroup && conversation.contactUserId === contact.id);
      if (target) void selectConversation(target);
    },
    [conversations, selectConversation],
  );

  const acceptInvitation = useCallback(async () => {
    if (!client || !selectedId || !selectedConversation) return;
    setJoiningRoom(true);
    try {
      if (selectedConversation.isGroup) {
        await acceptGroupInvitation(client, selectedId);
      } else {
        if (!selectedConversation.connectionAllowed || !selectedConversation.connectionUserId) {
          throw new Error("This direct room is unavailable until the connection is accepted.");
        }
        await contacts.verifyAccepted(selectedConversation.connectionUserId);
        await client.joinRoom(selectedId);
      }
    } catch (cause) {
      notify(errorMessage(cause, "Could not join the conversation."), "error");
    } finally {
      setJoiningRoom(false);
    }
  }, [client, contacts.verifyAccepted, notify, selectedConversation, selectedId]);

  const declineInvitation = useCallback(async () => {
    if (!client || !selectedId || !selectedConversation?.isGroup) return;
    setJoiningRoom(true);
    try {
      await declineGroupInvitation(client, selectedId);
      notify(`Invitation to "${selectedConversation.name}" declined.`, "success");
      navigate(basePath);
    } catch (cause) {
      notify(errorMessage(cause, "Could not decline the group invitation."), "error");
    } finally {
      setJoiningRoom(false);
    }
  }, [basePath, client, navigate, notify, selectedConversation, selectedId]);

  const verifiedConnections = useRef(new Map<string, number>());
  useEffect(() => { verifiedConnections.current.clear(); }, [client]);

  const prepareSend = useCallback(async () => {
    if (!selectedConversation || !client) throw new Error("Select a conversation first.");
    if (!selectedConversation.isGroup) {
      if (!selectedConversation.connectionAllowed || !selectedConversation.connectionUserId) {
        throw new Error("Accept a connection request before sending a direct message.");
      }
      // A successful server check stays valid briefly so rapid sends don't each wait on a round trip.
      const connectionUserId = selectedConversation.connectionUserId;
      const verifiedAt = verifiedConnections.current.get(connectionUserId);
      if (verifiedAt === undefined || Date.now() - verifiedAt > CONNECTION_VERIFY_TTL_MS) {
        await contacts.verifyAccepted(connectionUserId);
        verifiedConnections.current.set(connectionUserId, Date.now());
      }
      if (!canSend) throw new Error("Both users must join the room before messaging.");
    }
    return { client, roomId: selectedConversation.roomId ?? selectedConversation.id, replyEventId: replyTo?.matrix?.eventId };
  }, [canSend, client, contacts.verifyAccepted, replyTo, selectedConversation]);

  const sendMessage = useCallback(
    async (text: string, file?: File, mentions?: MentionEntity[]) => {
      const { client, roomId, replyEventId } = await prepareSend();
      if (file) {
        try {
          assertSendReady(client, roomId, replyEventId);
          await sendAttachment(client, roomId, file, replyEventId, setAttachmentProgress);
          if (text.trim()) await sendTextMessage(client, roomId, text, undefined, mentions);
        } catch (error) {
          setAttachmentProgress("Failed");
          throw error;
        }
      } else {
        // Locally accepted once queueTextMessage returns (SDK local echo); acknowledgment is async.
        const { acknowledged } = queueTextMessage(client, roomId, text, replyEventId, mentions);
        void acknowledged.catch((cause) =>
          notify(errorMessage(cause, "A message could not be sent. Use Retry on the message."), "error"));
      }
      // Only clear the reply this send used, never a newer one chosen meanwhile.
      setReplyTo((current) => (current?.matrix?.eventId === replyEventId ? null : current));
    },
    [notify, prepareSend],
  );

  const retryMessage = useCallback(
    (message: Message) => {
      const roomId = selectedConversation?.roomId ?? selectedConversation?.id;
      if (!client || !roomId || !message.matrix?.eventId) return;
      retryFailedMessage(client, roomId, message.matrix.eventId).catch((cause) =>
        notify(errorMessage(cause, "Retry failed."), "error"));
    },
    [client, notify, selectedConversation],
  );

  const sendVoice = useCallback(
    async (recording: VoiceRecording, attempt: VoiceSendAttempt) => {
      const { client, roomId, replyEventId } = await prepareSend();
      try {
        assertSendReady(client, roomId, replyEventId);
        await sendVoiceMessage(client, roomId, recording, replyEventId, setAttachmentProgress, attempt);
      } catch (error) {
        setAttachmentProgress("Upload failed");
        throw error;
      }
      setReplyTo(null);
    },
    [prepareSend],
  );

  // Completed upload feedback is transient; real delivery state lives on the message itself.
  useEffect(() => {
    if (attachmentProgress !== "Sent") return;
    const timer = setTimeout(() => setAttachmentProgress(""), 2000);
    return () => clearTimeout(timer);
  }, [attachmentProgress]);
  useEffect(() => setAttachmentProgress(""), [selectedId]);

  const toggleStar = useCallback(
    async (eventId: string) => {
      if (!selectedId) return;
      try {
        await starred.toggle({ roomId: selectedId, eventId });
      } catch (cause) {
        notify(errorMessage(cause, "Starred messages could not be updated."), "error");
      }
    },
    [notify, selectedId, starred.toggle],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchTerm("");
  }, []);

  const loadOlder = useCallback(async () => {
    if (!client || !selectedRoom) return;
    setLoadingOlder(true);
    try {
      await loadOlderMessages(client, selectedRoom);
    } catch (cause) {
      notify(errorMessage(cause, "Older messages could not be loaded."), "error");
    } finally {
      setLoadingOlder(false);
    }
  }, [client, notify, selectedRoom]);

  const toggleTag = useCallback(
    async (toggle: (roomId: string) => Promise<void>, label: string) => {
      if (!selectedConversation?.roomId) return;
      try {
        await toggle(selectedConversation.roomId);
      } catch (cause) {
        notify(errorMessage(cause, `Could not update ${label}.`), "error");
      }
    },
    [notify, selectedConversation?.roomId],
  );

  const handleSignOut = useCallback(() => {
    void signOut().catch(() => undefined).finally(() => navigate("/login", { replace: true }));
  }, [navigate, signOut]);

  if (!user || !mode) return null;

  const showEmpty = matrix.initialSyncComplete && contacts.loaded && conversations.length === 0;
  const composerHint = !canSend
    ? isDirect && !peerJoined
      ? "Waiting for your contact to join."
      : "You do not have permission to send messages in this room."
    : undefined;

  return (
    <AppLayout>
      <div className={`chat-app${(section === "chats" || section === "groups") && conversationId && selectedConversation ? " mobile-detail-open" : ""}${infoOpen && selectedConversation ? " has-info-panel" : ""}`}>
        <NavigationRail
          active={section}
          currentUser={user}
          matrixSession={matrixSession}
          presence={ownMatrixUserId ? presence[ownMatrixUserId] : undefined}
          onNavigate={(target) => target !== "settings" && navigate(SECTION_PATHS[target])}
          onSignOut={handleSignOut}
        />
        {section === "contacts" && (
          <ContactsView
            connections={contacts.connections}
            incomingRequests={contacts.incomingRequests}
            outgoingRequests={contacts.outgoingRequests}
            loading={contacts.loading}
            error={contacts.error}
            matrixSession={matrixSession}
            respondingRequestId={respondingRequestId}
            startingContactId={startingContactId}
            onMessage={messageContact}
            onAccept={(request) => void respondToRequest(request, "accept")}
            onDecline={(request) => void respondToRequest(request, "decline")}
            onAddContact={() => setDialog("chat")}
          />
        )}
        {section === "channels" && <ChannelsView />}
        {(section === "chats" || section === "groups") && (<>
        <ConversationSidebar
          mode={section === "groups" ? "groups" : "chats"}
          conversations={section === "groups" ? conversations.filter((c) => c.isGroup) : conversations}
          selectedId={selectedId}
          matrixSession={matrixSession}
          favoriteIds={tags.favorites}
          pinnedIds={tags.pinned}
          loading={!matrix.initialSyncComplete && matrix.status !== "error"}
          incomingRequests={contacts.incomingRequests}
          requestsLoading={contacts.loading}
          requestError={contacts.error}
          respondingRequestId={respondingRequestId}
          onSelect={(conversation) => void selectConversation(conversation)}
          onAcceptRequest={(request) => void respondToRequest(request, "accept")}
          onDeclineRequest={(request) => void respondToRequest(request, "decline")}
          onNewChat={() => setDialog("chat")}
          onNewGroup={() => setDialog("group")}
        />

        <section className="chat-main" aria-label="Chat">
          <ChatHeader
            conversation={selectedConversation}
            matrixSession={matrixSession}
            isFavorite={Boolean(selectedId && tags.favorites.has(selectedId))}
            isPinned={Boolean(selectedId && tags.pinned.has(selectedId))}
            canTag={Boolean(selectedConversation?.roomId)}
            onToggleFavorite={() => void toggleTag(tags.toggleFavorite, "favorite")}
            onTogglePinned={() => void toggleTag(tags.togglePinned, "pin")}
            infoOpen={infoOpen}
            onOpenInfo={() => setInfoOpen((open) => !open)}
            searchOpen={searchOpen}
            onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            onBack={() => navigate(basePath)}
          />

          {searchOpen && selectedConversation && (
            <RoomSearchBar
              value={searchTerm}
              onChange={setSearchTerm}
              onClose={closeSearch}
              canLoadOlder={Boolean(selectedRoom && hasOlderHistory(selectedRoom))}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder()}
            />
          )}

          <ConnectionBanner
            status={matrix.status}
            initialSyncComplete={matrix.initialSyncComplete}
            authenticationError={matrix.authenticationError}
            error={matrix.error}
          />

          {pins.summaries.length > 0 && (
            <PinnedMessageBanner
              messages={pins.summaries}
              activeIndex={activePinnedIndex}
              onSelectIndex={setActivePinnedIndex}
              onJump={(eventId) => void messageListRef.current?.jumpTo(eventId)}
              canUnpin={canManagePins}
              onUnpin={(eventId) => void togglePinnedMessage(eventId)}
            />
          )}

          {isInvited && selectedConversation && (
            <div className="invitation-banner" role="status">
              {selectedConversation.isGroup || selectedConversation.connectionAllowed ? (
                <>
                  <span>
                    {selectedConversation.isGroup
                      ? `You were invited to the group "${selectedConversation.name}".`
                      : "You were invited to this conversation."}
                  </span>
                  <div className="invitation-actions">
                    <button type="button" className="primary-button" onClick={() => void acceptInvitation()} disabled={joiningRoom}>
                      {joiningRoom ? "Joining…" : "Accept"}
                    </button>
                    {selectedConversation.isGroup && (
                      <button type="button" className="secondary-button" onClick={() => void declineInvitation()} disabled={joiningRoom}>
                        Decline
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <span>Accept the connection request before joining this conversation.</span>
              )}
            </div>
          )}

          {showEmpty && !selectedConversation && (
            <div className="no-rooms-hint">
              <strong>No conversations yet</strong>
              <span>Search for a username and send a connection request.</span>
              <button type="button" className="primary-button" onClick={() => setDialog("chat")}>
                Start a conversation
              </button>
            </div>
          )}

          <MessageList
            ref={messageListRef}
            conversation={selectedConversation}
            matrixSession={matrixSession}
            searchTerm={searchTerm}
            searchOpen={searchOpen}
            conversationRouteId={conversationId}
            onReply={setReplyTo}
            onRetry={retryMessage}
            onMentionClick={openMention}
            starredEventIds={starredEventIds}
            onToggleStar={(eventId) => void toggleStar(eventId)}
            ownAvatar={{
              name: user.profile.display_name || user.username,
              avatarUrl: user.profile.profile_picture_url,
            }}
            pinnedEventIds={pins.pinnedEventIdSet}
            canManagePins={canManagePins}
            onTogglePin={togglePinnedMessage}
            onLoadMessage={loadMessageForJump}
            onJumpError={(message) => notify(message, "error")}
          />

          {selectedConversation && isDirect && !selectedConversation.connectionAllowed && (
            <div className="connection-required-note" role="status">
              This conversation is unavailable until you accept a connection.
            </div>
          )}

          {selectedConversation && canShowComposer && (
            <MessageComposer
              key={selectedConversation.id}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              typingClient={client}
              typingRoomId={selectedRoom?.roomId}
              typingAllowed={Boolean(matrix.status === "connected" && canSend)}
              disabled={isInvited || !canSend}
              uploadStatus={attachmentProgress}
              placeholder={canSend ? "Write a message…" : "Messaging is unavailable"}
              hint={composerHint}
              onSend={sendMessage}
              mentionMembers={mentionMembers}
              ownUserId={ownMatrixUserId ?? undefined}
              onSendVoice={sendVoice}
            />
          )}
        </section>

        {infoOpen && selectedConversation && (
          <ConversationInfoPanel
            conversation={selectedConversation}
            matrixSession={matrixSession}
            shared={shared}
            starred={starredInRoom}
            members={members}
            highlightedMemberId={highlightedMember}
            topic={selectedRoom && selectedConversation.isGroup ? roomTopic(selectedRoom) : undefined}
            isFavorite={Boolean(selectedId && tags.favorites.has(selectedId))}
            canTag={Boolean(selectedConversation.roomId)}
            canLoadOlder={Boolean(selectedRoom && hasOlderHistory(selectedRoom))}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void loadOlder()}
            onToggleFavorite={() => void toggleTag(tags.toggleFavorite, "favorite")}
            onSearch={() => {
              setSearchOpen(true);
              if (window.matchMedia("(max-width: 1023px)").matches) setInfoOpen(false);
            }}
            onOpenMessage={(eventId) => {
              if (window.matchMedia("(max-width: 1023px)").matches) setInfoOpen(false);
              void messageListRef.current?.jumpTo(eventId);
            }}
            onNotify={notify}
            onClose={() => setInfoOpen(false)}
          />
        )}
        </>)}
      </div>

      <NewConversationDialog
        open={dialog !== null}
        initialGroupMode={dialog === "group"}
        api={api}
        currentUserId={user.id}
        connections={contacts.connections}
        incomingRequests={contacts.incomingRequests}
        outgoingRequests={contacts.outgoingRequests}
        onClose={() => setDialog(null)}
        onSendRequest={sendConnectionRequest}
        onCreateGroup={createGroup}
      />
      {toast && <Toast message={toast.message} kind={toast.kind} onClose={dismissToast} />}
    </AppLayout>
  );
}
