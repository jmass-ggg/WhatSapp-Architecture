import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EventType } from "matrix-js-sdk";

import { AppLayout } from "../layouts/AppLayout";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { ChatHeader } from "../components/chat/ChatHeader";
import { MessageComposer } from "../components/chat/MessageComposer";
import { MessageList, type MessageListHandle } from "../components/chat/MessageList";
import { PinnedMessageBanner } from "../components/chat/PinnedMessageBanner";
import { NewConversationDialog } from "../components/chat/NewConversationDialog";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { useMatrixContext } from "../context/MatrixContext";
import { useConnections } from "../hooks/useConnections";
import { useMatrixRooms } from "../hooks/useMatrixRooms";
import { usePinnedMessages } from "../hooks/usePinnedMessages";
import { useReadReceipts } from "../hooks/useReadReceipts";
import { sendAttachment } from "../services/matrix/attachments";
import { matrixUserIdForAppUserId } from "../services/matrix/identity";
import {
  acceptGroupInvitation,
  assertSendReady,
  declineGroupInvitation,
  sendTextMessage,
} from "../services/matrix/messaging";
import { loadMatrixMessage } from "../services/matrix/messageNavigation";
import { canManagePinnedMessages, getPinnedEventIds, updatePinnedEvent } from "../services/matrix/pinning";
import type { Conversation, Message, UserConnection } from "../types";

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
    isGroup: false,
  };
}

export function ChatPage() {
  const { user, mode, matrixSession, api, signOut } = useAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const matrix = useMatrixRooms();
  const { client, presence } = useMatrixContext();
  const contacts = useConnections(api, mode === "live" ? user?.id : undefined);

  const [dialog, setDialog] = useState<null | "chat" | "group">(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activePinnedIndex, setActivePinnedIndex] = useState(0);
  const [attachmentProgress, setAttachmentProgress] = useState("");
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [startingContactId, setStartingContactId] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const messageListRef = useRef<MessageListHandle>(null);
  const groupCreationPromise = useRef<Promise<void> | null>(null);
  const provisionedConnectionIds = useRef(new Set<string>());

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

  // The requester of an accepted connection creates the fresh plaintext direct room.
  useEffect(() => {
    if (mode !== "live" || !user || !matrix.initialSyncComplete) return;
    for (const connection of contacts.connections) {
      if (connection.requester_id !== user.id || provisionedConnectionIds.current.has(connection.id)) continue;
      const matrixUserId = matrixUserIdForAppUserId(connection.other_user.id);
      provisionedConnectionIds.current.add(connection.id);
      if (matrix.rooms.some((room) => !room.isGroup && room.matrixUserId === matrixUserId)) continue;
      const name = connection.other_user.profile?.display_name || connection.other_user.username;
      void matrix
        .createDirect(connection.other_user.id, name, matrixUserId)
        .then(() => notify(`Conversation ready with @${connection.other_user.username}.`, "success"))
        .catch((cause: unknown) => {
          provisionedConnectionIds.current.delete(connection.id);
          notify(errorMessage(cause, "The conversation could not be created."), "error");
        });
    }
  }, [contacts.connections, matrix.createDirect, matrix.initialSyncComplete, matrix.rooms, mode, notify, user]);

  const selectedConversation = conversationId
    ? conversations.find((conversation) => conversation.id === conversationId) ?? null
    : null;
  const selectedId = selectedConversation?.id;
  useEffect(() => setReplyTo(null), [selectedId]);

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
        navigate(`/chat/${encodeURIComponent(roomId)}`);
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
        navigate(`/chat/${encodeURIComponent(conversation.id)}`);
        return;
      }
      if (startingContactId) return;
      setStartingContactId(contactUserId);
      try {
        if (!matrix.initialSyncComplete) throw new Error("Wait for the connection to finish syncing.");
        const connection = await contacts.verifyAccepted(contactUserId);
        const matrixUserId = matrixUserIdForAppUserId(contactUserId);
        const existing = matrix.rooms.find((room) => !room.isGroup && room.matrixUserId === matrixUserId);
        if (existing) {
          navigate(`/chat/${encodeURIComponent(existing.roomId ?? existing.id)}`);
        } else if (connection.requester_id !== user?.id) {
          throw new Error("The person who sent the request is preparing the conversation.");
        } else {
          const roomId = await matrix.createDirect(contactUserId, conversation.name, matrixUserId);
          navigate(`/chat/${encodeURIComponent(roomId)}`);
        }
      } catch (cause) {
        notify(errorMessage(cause, "The conversation could not be started."), "error");
      } finally {
        setStartingContactId(null);
      }
    },
    [contacts.verifyAccepted, matrix.createDirect, matrix.initialSyncComplete, matrix.rooms, navigate, notify, startingContactId, user],
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
      navigate("/chat");
    } catch (cause) {
      notify(errorMessage(cause, "Could not decline the group invitation."), "error");
    } finally {
      setJoiningRoom(false);
    }
  }, [client, navigate, notify, selectedConversation, selectedId]);

  const sendMessage = useCallback(
    async (text: string, file?: File) => {
      if (!selectedConversation || !client) throw new Error("Select a conversation first.");
      if (!selectedConversation.isGroup) {
        if (!selectedConversation.connectionAllowed || !selectedConversation.connectionUserId) {
          throw new Error("Accept a connection request before sending a direct message.");
        }
        await contacts.verifyAccepted(selectedConversation.connectionUserId);
        if (!canSend) throw new Error("Both users must join the room before messaging.");
      }
      const roomId = selectedConversation.roomId ?? selectedConversation.id;
      const replyEventId = replyTo?.matrix?.eventId;
      if (file) {
        try {
          assertSendReady(client, roomId, replyEventId);
          await sendAttachment(client, roomId, file, replyEventId, setAttachmentProgress);
          if (text.trim()) await sendTextMessage(client, roomId, text);
        } catch (error) {
          setAttachmentProgress("Failed");
          throw error;
        }
      } else {
        await sendTextMessage(client, roomId, text, replyEventId);
      }
      setReplyTo(null);
    },
    [canSend, client, contacts.verifyAccepted, replyTo, selectedConversation],
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
      <div className={`chat-app${conversationId && selectedConversation ? " mobile-detail-open" : ""}`}>
        <ConversationSidebar
          conversations={conversations}
          selectedId={selectedId}
          currentUser={user}
          matrixSession={matrixSession}
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
          onSignOut={handleSignOut}
        />

        <section className="chat-main" aria-label="Chat">
          <ChatHeader conversation={selectedConversation} matrixSession={matrixSession} onBack={() => navigate("/chat")} />

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
            searchTerm=""
            searchOpen={false}
            conversationRouteId={conversationId}
            onReply={setReplyTo}
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
            />
          )}
        </section>
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
