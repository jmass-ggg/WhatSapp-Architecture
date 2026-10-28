import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EventType } from "matrix-js-sdk";

import { AppLayout } from "../layouts/AppLayout";
import { ContactInfoPanel } from "../components/chat/ContactInfoPanel";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { ChatHeader } from "../components/chat/ChatHeader";
import { MatrixConnectionStatus } from "../components/MatrixConnectionStatus";
import { MatrixSecurityDialog } from "../components/MatrixSecurityDialog";
import { MessageComposer } from "../components/chat/MessageComposer";
import { MessageList } from "../components/chat/MessageList";
import { NewConversationDialog } from "../components/chat/NewConversationDialog";
import { SearchInput } from "../components/SearchInput";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { useMatrixContext } from "../context/MatrixContext";
import { useMatrixRooms } from "../hooks/useMatrixRooms";
import { sendEncryptedTextMessage } from "../services/matrix/encryption";
import { matrixUserIdForAppUserId } from "../services/matrix/identity";
import type { Conversation, DirectoryUser, Message, UserConnection } from "../types";
import { getDemoConversations } from "../utils/demoData";

type ToastState = {
  message: string;
  kind: "success" | "error" | "info";
};

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
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
    lastMessage: "Start an encrypted conversation",
    updatedAt: new Date(0),
    unreadCount: 0,
    messages: [],
    bio: contact.profile?.bio ?? "Recruitable Chat contact",
    isDemo: false,
    isEncrypted: false,
    isGroup: false,
  };
}

export function ChatPage() {
  const { user, mode, matrixSession, api, signOut } = useAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [demoConversations, setDemoConversations] = useState(getDemoConversations);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 1180px)").matches,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [mutedIds, setMutedIds] = useState<Set<string>>(() => new Set());
  const [wallpaperIds, setWallpaperIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [connections, setConnections] = useState<UserConnection[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<UserConnection[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<UserConnection[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [startingContactId, setStartingContactId] = useState<string | null>(null);
  const provisionedConnectionIds = useRef(new Set<string>());
  const lastReadReceipt = useRef("");
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");

  const matrix = useMatrixRooms();
  const matrixContext = useMatrixContext();
  const onboardingNeedsAttention =
    matrixContext.cryptoOnboardingStatus === "restore_encryption" ||
    matrixContext.cryptoOnboardingStatus === "incomplete";
  const dismissToast = useCallback(() => setToast(null), []);
  const notify = useCallback((message: string, kind: ToastState["kind"] = "info") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (mode === "live" && onboardingNeedsAttention) {
      setSecurityOpen(true);
    }
  }, [mode, onboardingNeedsAttention]);

  const refreshConnections = useCallback(
    async (showLoading = false): Promise<boolean> => {
      if (mode !== "live" || !user) {
        setConnections([]);
        setIncomingRequests([]);
        setOutgoingRequests([]);
        setConnectionError(null);
        return true;
      }
      if (showLoading) setRequestsLoading(true);
      try {
        const [accepted, incoming, outgoing] = await Promise.all([
          api.request<UserConnection[]>("/connections"),
          api.request<UserConnection[]>("/connections/requests/incoming"),
          api.request<UserConnection[]>("/connections/requests/outgoing"),
        ]);
        setConnections(accepted);
        setIncomingRequests(incoming);
        setOutgoingRequests(outgoing);
        setConnectionError(null);
        return true;
      } catch (cause) {
        setConnectionError(
          cause instanceof Error
            ? cause.message
            : "Connection information is unavailable right now.",
        );
        return false;
      } finally {
        if (showLoading) setRequestsLoading(false);
      }
    },
    [api, mode, user],
  );

  useEffect(() => {
    void refreshConnections(true);
  }, [refreshConnections]);

  useEffect(() => {
    if (mode !== "live" || !user) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshConnections();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [mode, refreshConnections, user]);

  const connectionsByMatrixUserId = useMemo(
    () =>
      new Map(
        connections.map((connection) => [
          matrixUserIdForAppUserId(connection.other_user.id),
          connection,
        ]),
      ),
    [connections],
  );

  const conversations = useMemo(() => {
    if (mode === "demo") return demoConversations;
    if (mode !== "live") return [];

    const matrixConversations = matrix.rooms.map((room) => {
      if (room.isGroup) return { ...room, connectionAllowed: true };
      const connection = room.matrixUserId
        ? connectionsByMatrixUserId.get(room.matrixUserId)
        : undefined;
      const contact = connection?.other_user;
      return {
        ...room,
        contactUserId: contact?.id,
        connectionUserId: contact?.id,
        connectionAllowed: Boolean(connection),
        name: contact?.profile?.display_name || contact?.username || room.name,
        username: contact?.username || room.username,
        avatarUrl: contact?.profile?.profile_picture_url ?? room.avatarUrl,
      };
    });
    const roomMatrixUserIds = new Set(
      matrixConversations
        .filter((room) => !room.isGroup && room.matrixUserId)
        .map((room) => room.matrixUserId as string),
    );
    const contactsWithoutRooms = connections
      .filter(
        (connection) =>
          !roomMatrixUserIds.has(
            matrixUserIdForAppUserId(connection.other_user.id),
          ),
      )
      .map(conversationForContact);

    return [...matrixConversations, ...contactsWithoutRooms].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  }, [connections, connectionsByMatrixUserId, demoConversations, matrix.rooms, mode]);

  useEffect(() => {
    if (
      mode !== "live" ||
      !user ||
      !matrix.initialSyncComplete ||
      matrix.cryptoStatus !== "ready" ||
      matrixContext.cryptoOnboardingStatus !== "ready"
    ) {
      return;
    }
    for (const connection of connections) {
      if (
        connection.requester_id !== user.id ||
        provisionedConnectionIds.current.has(connection.id)
      ) {
        continue;
      }
      const matrixUserId = matrixUserIdForAppUserId(connection.other_user.id);
      const existingRoom = matrix.rooms.find(
        (room) =>
          !room.isGroup &&
          room.isEncrypted &&
          room.matrixUserId === matrixUserId,
      );
      if (existingRoom) {
        provisionedConnectionIds.current.add(connection.id);
        continue;
      }

      provisionedConnectionIds.current.add(connection.id);
      const name =
        connection.other_user.profile?.display_name ||
        connection.other_user.username;
      void matrix
        .createDirect(connection.other_user.id, name, matrixUserId)
        .then(() => {
          notify(`Encrypted room ready for @${connection.other_user.username}.`, "success");
        })
        .catch((cause: unknown) => {
          provisionedConnectionIds.current.delete(connection.id);
          notify(
            cause instanceof Error
              ? cause.message
              : "The encrypted room could not be created.",
            "error",
          );
        });
    }
  }, [
    connections,
    matrix.createDirect,
    matrix.cryptoStatus,
    matrixContext.cryptoOnboardingStatus,
    matrix.initialSyncComplete,
    matrix.rooms,
    mode,
    notify,
    user,
  ]);

  const selectedConversation =
    (conversationId
      ? conversations.find((conversation) => conversation.id === conversationId)
      : mode === "demo" ? conversations[0] : null) ??
    null;
  const mobileDetailOpen = Boolean(conversationId && selectedConversation);
  const selectedId = selectedConversation?.id;
  const selectedRoom = mode === "live" && selectedId
    ? matrixContext.client?.getRoom(selectedId)
    : null;
  const isInvited = selectedRoom?.getMyMembership() === "invite";
  const isDirectConversation = Boolean(
    selectedConversation && !selectedConversation.isGroup,
  );
  const directPeerJoined = Boolean(
    selectedConversation?.matrixUserId &&
      selectedRoom?.getMembers().some(
        (member) =>
          member.userId === selectedConversation.matrixUserId &&
          member.membership === "join",
      ),
  );
  const ownMatrixUserId = matrixContext.client?.getUserId();
  const ownHasEncryptedSendPermission = Boolean(
    selectedRoom &&
      ownMatrixUserId &&
      selectedRoom.currentState.maySendEvent(
        EventType.RoomMessageEncrypted,
        ownMatrixUserId,
      ),
  );
  const directPeerHasEncryptedSendPermission = Boolean(
    !isDirectConversation ||
      (selectedRoom &&
        selectedConversation?.matrixUserId &&
        selectedRoom.currentState.maySendEvent(
          EventType.RoomMessageEncrypted,
          selectedConversation.matrixUserId,
        )),
  );
  const canSendEncryptedMessage = Boolean(
    selectedRoom &&
      selectedRoom.getMyMembership() === "join" &&
      (!isDirectConversation || directPeerJoined) &&
      ownHasEncryptedSendPermission &&
      directPeerHasEncryptedSendPermission,
  );
  const canShowComposer = Boolean(
    selectedConversation &&
      (mode !== "live" ||
        selectedConversation.isGroup ||
        selectedConversation.connectionAllowed === true),
  );

  useEffect(() => {
    if (conversationId && conversations.length > 0 && !selectedConversation && mode === "demo") {
      navigate("/chat", { replace: true });
    }
  }, [
    conversationId,
    conversations.length,
    mode,
    navigate,
    selectedConversation,
  ]);

  const sendConnectionRequest = useCallback(
    async (directoryUser: DirectoryUser) => {
      await api.request<UserConnection>("/connections/requests", {
        method: "POST",
        body: JSON.stringify({ recipient_id: directoryUser.id }),
      });
      await refreshConnections();
      notify(`Connection request sent to @${directoryUser.username}.`, "success");
    },
    [api, notify, refreshConnections],
  );

  const respondToConnectionRequest = useCallback(
    async (request: UserConnection, action: "accept" | "decline") => {
      setRespondingRequestId(request.id);
      try {
        await api.request<UserConnection>(
          `/connections/${encodeURIComponent(request.id)}/${action}`,
          { method: "POST" },
        );
        await refreshConnections();
        notify(
          action === "accept"
            ? `You are now connected with @${request.other_user.username}.`
            : `Request from @${request.other_user.username} declined.`,
          "success",
        );
      } catch (cause) {
        notify(
          cause instanceof Error
            ? cause.message
            : "The connection request could not be updated.",
          "error",
        );
      } finally {
        setRespondingRequestId(null);
      }
    },
    [api, notify, refreshConnections],
  );

  const verifyAcceptedContact = useCallback(
    async (contactUserId: string): Promise<UserConnection> => {
      const acceptedConnections = await api.request<UserConnection[]>("/connections");
      const connection = acceptedConnections.find(
        (item) => item.other_user.id === contactUserId,
      );
      if (!connection) {
        void refreshConnections();
        throw new Error("Accept a connection request before starting or sending a direct chat.");
      }
      return connection;
    },
    [api, refreshConnections],
  );

  const startAcceptedConversation = useCallback(
    async (conversation: Conversation) => {
      const contactUserId = conversation.contactUserId;
      if (!contactUserId || startingContactId) return;
      setStartingContactId(contactUserId);
      try {
        if (!matrix.initialSyncComplete) {
          throw new Error("Wait for Matrix to finish syncing before starting a conversation.");
        }
        const connection = await verifyAcceptedContact(contactUserId);
        const matrixUserId = matrixUserIdForAppUserId(contactUserId);
        const existingRoom = matrix.rooms.find(
          (room) =>
            !room.isGroup &&
            room.isEncrypted &&
            room.matrixUserId === matrixUserId,
        );
        if (connection.requester_id !== user?.id) {
          if (!existingRoom) {
            throw new Error("The person who sent the request is preparing the encrypted room.");
          }
          navigate(`/chat/${encodeURIComponent(existingRoom.roomId ?? existingRoom.id)}`);
          return;
        }
        if (existingRoom) {
          navigate(`/chat/${encodeURIComponent(existingRoom.roomId ?? existingRoom.id)}`);
          return;
        }
        const roomId = await matrix.createDirect(
          contactUserId,
          conversation.name,
          matrixUserId,
        );
        navigate(`/chat/${encodeURIComponent(roomId)}`);
        notify(`Encrypted conversation ready with ${conversation.name}.`, "success");
      } catch (cause) {
        notify(
          cause instanceof Error
            ? cause.message
            : "The encrypted conversation could not be started.",
          "error",
        );
      } finally {
        setStartingContactId(null);
      }
    },
    [
      api,
      matrix.createDirect,
      matrix.initialSyncComplete,
      matrix.rooms,
      navigate,
      notify,
      startingContactId,
      user,
      verifyAcceptedContact,
    ],
  );

  const selectConversation = useCallback(
    (conversation: Conversation) => {
      if (mode === "live" && conversation.contactUserId) {
        void startAcceptedConversation(conversation);
        return;
      }
      if (startingContactId) return;
      setMessageSearch("");
      setSearchOpen(false);
      setInfoOpen(
        typeof window !== "undefined" &&
          window.matchMedia("(min-width: 1180px)").matches,
      );
      navigate(`/chat/${encodeURIComponent(conversation.id)}`);
    },
    [mode, navigate, startAcceptedConversation, startingContactId],
  );

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (mode !== "live" || !selectedConversation || isInvited ||
      (!selectedConversation.isGroup &&
        selectedConversation.connectionAllowed !== true) ||
      !pageVisible ||
      (!conversationId && window.matchMedia("(max-width: 767px)").matches)) return;
    const client = matrixContext.client;
    const room = client?.getRoom(selectedConversation.id);
    if (!client || !room || room.getMyMembership() !== "join") return;
    const lastIncoming = [...room.getLiveTimeline().getEvents()].reverse().find(
      (event) => event.getSender() !== client.getUserId() &&
        event.getId() && event.getType() === "m.room.message" &&
        !event.isDecryptionFailure(),
    );
    if (lastIncoming && selectedConversation.unreadCount > 0) {
      const receiptKey = `${client.getUserId()}:${selectedConversation.id}:${lastIncoming.getId()}`;
      if (lastReadReceipt.current === receiptKey) return;
      lastReadReceipt.current = receiptKey;
      void client.sendReadReceipt(lastIncoming).catch(() => {
        if (lastReadReceipt.current === receiptKey) lastReadReceipt.current = "";
      });
    }
  }, [
    conversationId,
    isInvited,
    matrixContext.client,
    mode,
    pageVisible,
    selectedConversation,
  ]);

  const acceptInvitation = useCallback(async () => {
    if (!matrixContext.client || !selectedId || !selectedConversation) return;
    setJoiningRoom(true);
    try {
      if (!selectedConversation.isGroup) {
        if (
          !selectedConversation.connectionAllowed ||
          !selectedConversation.connectionUserId
        ) {
          throw new Error("This direct room is unavailable until the connection is accepted.");
        }
        await verifyAcceptedContact(selectedConversation.connectionUserId);
      }
      await matrixContext.client.joinRoom(selectedId);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not join the conversation.", "error");
    } finally {
      setJoiningRoom(false);
    }
  }, [matrixContext.client, notify, selectedConversation, selectedId, verifyAcceptedContact]);

  const sendMessage = useCallback(
    async (text: string, file?: File) => {
      if (!selectedConversation) return;

      if (mode === "live") {
        if (file) {
          throw new Error(
            "Encrypted file attachments are not implemented. The file was not sent.",
          );
        }
        if (!selectedConversation.isEncrypted) {
          throw new Error(
            "This room is not encrypted. The message was not sent.",
          );
        }
        if (!selectedConversation.isGroup) {
          if (
            !selectedConversation.connectionAllowed ||
            !selectedConversation.connectionUserId
          ) {
            throw new Error(
              "Accept a connection request before sending a direct message.",
            );
          }
          await verifyAcceptedContact(selectedConversation.connectionUserId);
        }
        if (
          matrixContext.cryptoStatus !== "ready" ||
          matrixContext.cryptoOnboardingStatus !== "ready" ||
          !matrixContext.client ||
          matrixContext.crossSigningReady !== true
        ) {
          throw new Error(
            "Matrix encryption and cross-signing must be ready before sending.",
          );
        }
        const roomId = selectedConversation.roomId ?? selectedConversation.id;
        const room = matrixContext.client.getRoom(roomId);
        if (!room || room.getMyMembership() !== "join") {
          throw new Error("Join the encrypted room before sending a message.");
        }
        if (
          !selectedConversation.isGroup &&
          (!selectedConversation.matrixUserId ||
            !room.getMembers().some(
              (member) =>
                member.userId === selectedConversation.matrixUserId &&
                member.membership === "join",
            ))
        ) {
          throw new Error("Both users must join the encrypted room before messaging.");
        }
        if (
          !selectedConversation.isGroup &&
          (!selectedConversation.matrixUserId ||
            !room.currentState.maySendEvent(
              EventType.RoomMessageEncrypted,
              selectedConversation.matrixUserId,
            ))
        ) {
          throw new Error(
            "Both users need permission to send encrypted messages in this room.",
          );
        }
        const ownUserId = matrixContext.client.getUserId();
        if (
          !ownUserId ||
          !room.currentState.maySendEvent(
            EventType.RoomMessageEncrypted,
            ownUserId,
          )
        ) {
          throw new Error("You do not have permission to send encrypted messages in this room.");
        }
        await sendEncryptedTextMessage(
          matrixContext.client,
          roomId,
          text,
        );
        return;
      }
      if (mode !== "demo") {
        throw new Error("Message sending is unavailable.");
      }

      const sentAt = new Date();
      const message: Message = {
        id: crypto.randomUUID(),
        sender: "me",
        text,
        sentAt,
        delivery: "read",
        ...(file
          ? {
              attachment: {
                name: file.name,
                size: file.size,
                mimeType: file.type,
                kind: file.type.startsWith("image/") ? "image" : "file",
                url: file.type.startsWith("image/")
                  ? URL.createObjectURL(file)
                  : undefined,
                demoOnly: true,
              },
            }
          : {}),
      };
      setDemoConversations((current) =>
        current.map((conversation) =>
          conversation.id === selectedConversation.id
            ? {
                ...conversation,
                messages: [...conversation.messages, message],
                lastMessage: text || (file ? `You: ${file.name}` : "New message"),
                updatedAt: sentAt,
                unreadCount: 0,
              }
            : conversation,
        ),
      );
    },
    [
      matrixContext.client,
      matrixContext.cryptoStatus,
      matrixContext.cryptoOnboardingStatus,
      matrixContext.crossSigningReady,
      mode,
      selectedConversation,
      verifyAcceptedContact,
    ],
  );

  const handleSignOut = useCallback(() => {
    void signOut()
      .catch(() => undefined)
      .finally(() => navigate("/login", { replace: true }));
  }, [navigate, signOut]);

  function clearConversation() {
    if (!selectedConversation) return;
    if (!selectedConversation.isDemo) {
      notify(
        "Clearing server history isn't available in this prototype. Your Matrix messages remain unchanged.",
        "info",
      );
      return;
    }
    if (!window.confirm("Clear these sample messages from this demo preview?")) return;
    setDemoConversations((current) =>
      current.map((conversation) =>
        conversation.id === selectedConversation.id
          ? { ...conversation, messages: [], lastMessage: "No messages yet", unreadCount: 0 }
          : conversation,
      ),
    );
    notify("Messages were cleared from this local demo preview.", "success");
  }

  function toggleMuted() {
    if (!selectedId) return;
    const wasMuted = mutedIds.has(selectedId);
    setMutedIds((current) => {
      const updated = new Set(current);
      if (updated.has(selectedId)) updated.delete(selectedId);
      else updated.add(selectedId);
      return updated;
    });
    notify(
      wasMuted
        ? "Notifications are unmuted for this session."
        : "Notifications are muted locally for this session.",
      "info",
    );
  }

  function toggleWallpaper() {
    if (!selectedId) return;
    setWallpaperIds((current) => {
      const updated = new Set(current);
      if (updated.has(selectedId)) updated.delete(selectedId);
      else updated.add(selectedId);
      return updated;
    });
    notify("Wallpaper preference changed on this device only.", "info");
  }

  const searchCount = useMemo(() => {
    const term = messageSearch.trim().toLowerCase();
    if (!term) return 0;
    return (
      selectedConversation?.messages.filter((message) =>
        message.text.toLowerCase().includes(term) ||
        message.attachment?.name.toLowerCase().includes(term),
      ).length ?? 0
    );
  }, [messageSearch, selectedConversation?.messages]);

  if (!user || !mode) return null;

  return (
    <AppLayout>
      <div
        className={[
          "chat-app",
          infoOpen ? "contact-panel-visible" : "",
          mobileDetailOpen ? "mobile-detail-open" : "",
          selectedId && wallpaperIds.has(selectedId) ? "has-chat-wallpaper" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ConversationSidebar
          conversations={conversations}
          selectedId={selectedId}
          currentUser={user}
          mode={mode}
          matrixSession={matrixSession}
          matrixStatus={matrix.status}
          initialSyncComplete={matrix.initialSyncComplete}
          cryptoStatus={matrix.cryptoStatus}
          cryptoOnboardingStatus={matrixContext.cryptoOnboardingStatus}
          authenticationError={matrix.authenticationError}
          incomingRequests={incomingRequests}
          requestsLoading={requestsLoading}
          requestError={connectionError}
          respondingRequestId={respondingRequestId}
          onSelect={selectConversation}
          onAcceptRequest={(request) =>
            void respondToConnectionRequest(request, "accept")
          }
          onDeclineRequest={(request) =>
            void respondToConnectionRequest(request, "decline")
          }
          onNewChat={() => setNewChatOpen(true)}
          onSignOut={handleSignOut}
          onSettings={() =>
            setSecurityOpen(true)
          }
        />

        <section className="chat-main" aria-label="Chat">
          <ChatHeader
            conversation={selectedConversation}
            mode={mode}
            matrixSession={matrixSession}
            cryptoStatus={matrix.cryptoStatus}
            searchOpen={searchOpen}
            onBack={() => navigate("/chat")}
            onSearch={() => {
              setSearchOpen((open) => !open);
              setMessageSearch("");
            }}
            onContactInfo={() => setInfoOpen((open) => !open)}
          />

          {mode === "demo" && (
            <div className="mode-banner" role="status">
              <span className="demo-label">DEMO MODE</span>
              <span>Sample conversations only · messages stay in this browser preview</span>
            </div>
          )}
          {mode === "live" && matrix.status !== "connected" && (
            <div className="matrix-sync-banner">
              <MatrixConnectionStatus
                status={matrix.status}
                initialSyncComplete={matrix.initialSyncComplete}
                cryptoStatus={matrix.cryptoStatus}
                cryptoOnboardingStatus={matrixContext.cryptoOnboardingStatus}
                authenticationError={matrix.authenticationError}
                error={matrix.error}
              />
              {matrix.error && <span>{matrix.error}</span>}
            </div>
          )}

          {isInvited && (
            <div className="mode-banner" role="status">
              {selectedConversation?.isGroup ||
              selectedConversation?.connectionAllowed === true ? (
                <>
                  <span>Invitation to this conversation</span>
                  <button type="button" className="primary-button" onClick={() => void acceptInvitation()} disabled={joiningRoom}>
                    {joiningRoom ? "Joining…" : "Accept invitation"}
                  </button>
                </>
              ) : (
                <span>Accept a connection request before joining this direct room.</span>
              )}
            </div>
          )}

          {searchOpen && selectedConversation && (
            <div className="message-search-row">
              <SearchInput
                value={messageSearch}
                onChange={setMessageSearch}
                placeholder="Search loaded messages"
                label="Search messages in this conversation"
              />
              <span className="search-count">
                {messageSearch.trim() ? `${searchCount} found` : "Loaded history"}
              </span>
            </div>
          )}

          {mode === "live" &&
            matrix.initialSyncComplete &&
            conversations.length === 0 && (
              <div className="no-rooms-hint">
                <strong>No conversations yet</strong>
                <span>Search for a username and send a connection request.</span>
                <button type="button" className="primary-button" onClick={() => setNewChatOpen(true)}>
                  Start a conversation
                </button>
              </div>
            )}

          <MessageList
            conversation={selectedConversation}
            matrixSession={matrixSession}
            searchTerm={messageSearch}
            searchOpen={searchOpen}
            conversationRouteId={conversationId}
          />

          {selectedConversation && mode === "live" &&
            isDirectConversation && !selectedConversation.connectionAllowed && (
              <div className="connection-required-note" role="status">
                This direct conversation is unavailable until you accept a connection.
              </div>
            )}

          {selectedConversation && canShowComposer && (
            <MessageComposer
              disabled={
                mode === "live" &&
                (isInvited || !selectedConversation.isEncrypted ||
                  matrix.cryptoStatus !== "ready" ||
                  matrixContext.cryptoOnboardingStatus !== "ready" ||
                  matrixContext.crossSigningReady !== true ||
                  !canSendEncryptedMessage)
              }
              attachmentsDisabled={mode === "live"}
              busy={false}
              placeholder={
                selectedConversation.isEncrypted
                  ? matrix.cryptoStatus !== "ready"
                    ? "Encryption is not ready"
                    : matrixContext.cryptoOnboardingStatus !== "ready"
                      ? "Finish secure messaging setup"
                    : matrixContext.crossSigningReady !== true
                      ? "Set up cross-signing to send"
                      : isDirectConversation && !directPeerJoined
                        ? "Waiting for contact to join"
                      : "Write an end-to-end encrypted message…"
                  : mode === "demo"
                  ? "Write a demo message…"
                  : "This room is not encrypted"
              }
              hint={
                mode === "live"
                  ? selectedConversation.isEncrypted
                    ? matrix.cryptoStatus !== "ready"
                      ? "Encrypted sending is unavailable until Rust crypto is ready."
                    : matrixContext.cryptoOnboardingStatus !== "ready"
                        ? "Wait for secure messaging setup to finish."
                      : matrixContext.crossSigningReady !== true
                        ? "Cross-signing must be ready before sending."
                      : isDirectConversation && !directPeerJoined
                        ? "Both users must join the encrypted room before messaging."
                        : isDirectConversation &&
                            !directPeerHasEncryptedSendPermission
                          ? "Your contact does not have permission to send encrypted messages in this room."
                        : !canSendEncryptedMessage
                          ? "You do not have permission to send messages in this room."
                        : "Messages are encrypted on this device before they reach Synapse."
                    : "This existing room is plaintext. Create a new encrypted room to send messages."
                  : undefined
              }
              onSend={sendMessage}
            />
          )}
        </section>

        {selectedConversation && infoOpen && (
          <ContactInfoPanel
            conversation={selectedConversation}
            mode={mode}
            matrixSession={matrixSession}
            open
            muted={Boolean(selectedId && mutedIds.has(selectedId))}
            wallpaperOn={Boolean(selectedId && wallpaperIds.has(selectedId))}
            onClose={() => setInfoOpen(false)}
            onToggleMute={toggleMuted}
            onSearch={() => {
              setSearchOpen(true);
              setInfoOpen(false);
            }}
            onToggleWallpaper={toggleWallpaper}
            onClearChat={clearConversation}
            onStarred={() =>
              notify(
                mode === "demo"
                  ? "Starred-message management is a visual preview."
                  : "Starred-message management is not connected yet.",
                "info",
              )
            }
          />
        )}
      </div>

      <NewConversationDialog
        open={newChatOpen}
        mode={mode}
        api={api}
        currentUserId={user.id}
        conversations={conversations}
        connections={connections}
        incomingRequests={incomingRequests}
        outgoingRequests={outgoingRequests}
        onClose={() => setNewChatOpen(false)}
        onSelectDemo={(conversation) => {
          setNewChatOpen(false);
          selectConversation(conversation);
        }}
        onSendRequest={sendConnectionRequest}
      />
      {securityOpen && (
        <MatrixSecurityDialog
          manager={matrixContext.manager}
          snapshot={matrixContext}
          peerUserId={
            selectedConversation && !selectedConversation.isGroup
              ? selectedConversation.matrixUserId
              : undefined
          }
          roomId={
            selectedConversation && !selectedConversation.isGroup
              ? selectedConversation.roomId ?? selectedConversation.id
              : undefined
          }
          onClose={() => setSecurityOpen(false)}
        />
      )}
      {toast && (
        <Toast message={toast.message} kind={toast.kind} onClose={dismissToast} />
      )}
    </AppLayout>
  );
}
