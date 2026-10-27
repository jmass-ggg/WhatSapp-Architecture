import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { AppLayout } from "../layouts/AppLayout";
import { ContactInfoPanel } from "../components/chat/ContactInfoPanel";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { ChatHeader } from "../components/chat/ChatHeader";
import { MatrixConnectionStatus } from "../components/MatrixConnectionStatus";
import { MessageComposer } from "../components/chat/MessageComposer";
import { MessageList } from "../components/chat/MessageList";
import { NewConversationDialog } from "../components/chat/NewConversationDialog";
import { SearchInput } from "../components/SearchInput";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { useMatrixRooms } from "../hooks/useMatrixRooms";
import type { Conversation, DirectoryUser, Message } from "../types";
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

export function ChatPage() {
  const { user, mode, matrixSession, api, signOut } = useAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [demoConversations, setDemoConversations] = useState(getDemoConversations);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 1180px)").matches,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [mutedIds, setMutedIds] = useState<Set<string>>(() => new Set());
  const [wallpaperIds, setWallpaperIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<ToastState | null>(null);

  const matrix = useMatrixRooms();
  const conversations =
    mode === "demo" ? demoConversations : mode === "live" ? matrix.rooms : [];
  const selectedConversation =
    conversations.find((conversation) => conversation.id === conversationId) ??
    conversations[0] ??
    null;
  const mobileDetailOpen = Boolean(conversationId && selectedConversation);
  const selectedId = selectedConversation?.id;

  const dismissToast = useCallback(() => setToast(null), []);
  const notify = useCallback((message: string, kind: ToastState["kind"] = "info") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (conversationId && conversations.length > 0 && !selectedConversation && mode === "demo") {
      navigate("/chat", { replace: true });
    }
    if (
      conversationId &&
      mode === "live" &&
      matrix.initialSyncComplete &&
      conversations.length > 0 &&
      !selectedConversation
    ) {
      navigate("/chat", { replace: true });
    }
  }, [
    conversationId,
    conversations.length,
    matrix.initialSyncComplete,
    mode,
    navigate,
    selectedConversation,
  ]);

  const selectConversation = useCallback(
    (conversation: Conversation) => {
      setMessageSearch("");
      setSearchOpen(false);
      setInfoOpen(
        typeof window !== "undefined" &&
          window.matchMedia("(min-width: 1180px)").matches,
      );
      navigate(`/chat/${encodeURIComponent(conversation.id)}`);
    },
    [navigate],
  );

  const sendMessage = useCallback(
    async (text: string, file?: File) => {
      if (!selectedConversation) return;

      if (mode !== "demo") {
        throw new Error("Live Matrix message sending is not enabled yet.");
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
    [mode, selectedConversation],
  );

  const handleNewDirect = useCallback(
    async (directoryUser: DirectoryUser, matrixUserId: string) => {
      const displayName =
        directoryUser.profile.display_name || directoryUser.username;
      const roomId = await matrix.createDirect(
        directoryUser.id,
        displayName,
        matrixUserId,
      );
      setNewChatOpen(false);
      selectConversation({
        id: roomId,
        roomId,
        name: displayName,
        username: directoryUser.username,
        matrixUserId,
        initials: initialsFor(displayName),
        avatarUrl: directoryUser.profile.profile_picture_url,
        accent: Math.abs(roomId.length * 13) % 6,
        lastMessage: "Conversation started",
        updatedAt: new Date(),
        unreadCount: 0,
        messages: [],
        bio: "Matrix conversation",
        isDemo: false,
      });
    },
    [matrix, selectConversation],
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
          authenticationError={matrix.authenticationError}
          onSelect={selectConversation}
          onNewChat={() => setNewChatOpen(true)}
          onSignOut={handleSignOut}
          onSettings={() =>
            notify("Preferences are a local preview and are not saved yet.", "info")
          }
        />

        <section className="chat-main" aria-label="Chat">
          <ChatHeader
            conversation={selectedConversation}
            mode={mode}
            matrixSession={matrixSession}
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
                authenticationError={matrix.authenticationError}
                error={matrix.error}
              />
              {matrix.error && <span>{matrix.error}</span>}
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
                <span>Start a chat with someone in your LumaChat directory.</span>
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

          {selectedConversation && (
            <MessageComposer
              disabled={selectedConversation.isEncrypted || mode === "live"}
              busy={false}
              placeholder={
                selectedConversation.isEncrypted
                  ? "Encrypted messaging is not supported in this client"
                  : mode === "demo"
                  ? "Write a demo message…"
                  : "Matrix message sending is not enabled yet"
              }
              hint={
                mode === "live"
                  ? "Live room events synchronize here; message sending is deferred to a later step."
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
        onClose={() => setNewChatOpen(false)}
        onSelectDemo={(conversation) => {
          setNewChatOpen(false);
          selectConversation(conversation);
        }}
        onCreateDirect={handleNewDirect}
      />
      {toast && (
        <Toast message={toast.message} kind={toast.kind} onClose={dismissToast} />
      )}
    </AppLayout>
  );
}
