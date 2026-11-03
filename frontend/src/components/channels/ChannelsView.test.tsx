import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Channel, UserProfile } from "../../types";
import type { ChannelRoomSummary } from "../../services/matrix/channels";

const { matrixSnapshot } = vi.hoisted(() => ({
  matrixSnapshot: {
    client: null as unknown,
    manager: null,
    session: null,
    channelRooms: {} as Record<string, ChannelRoomSummary>,
    rooms: [],
    legacyRoomIds: [],
    status: "connected",
    initialSyncComplete: true,
    error: null,
    authenticationError: false,
    recentEvents: [],
    presence: {},
  },
}));
vi.mock("../../context/MatrixContext", () => ({ useMatrixContext: () => matrixSnapshot }));

import { ChannelsView } from "./ChannelsView";
import type { ApiClient } from "../../services/api/client";

afterEach(cleanup);

const baseUser = {
  id: "u1", email: "u@example.com", username: "ana", role: "user", is_active: true, is_email_verified: true,
  created_at: "", updated_at: "",
  profile: { user_id: "u1", display_name: "Ana", profile_picture_url: null, bio: null, job_title: null, department: null },
} as UserProfile;

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "c1", matrix_room_id: "!eng:localhost", name: "Engineering Team", description: "Sprint news", avatar_url: null,
    category: "engineering", creator_id: "owner1", is_verified: false, status: "active", created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z", member_count: 3,
    membership: { role: "member", status: "joined", joined_at: "2026-11-01T00:00:00Z" }, can_manage: false, can_edit: false, can_publish: false,
    ...overrides,
  };
}

function roomSummary(overrides: Partial<ChannelRoomSummary> = {}): ChannelRoomSummary {
  return {
    roomId: "!eng:localhost", membership: "join", unreadCount: 0, announcements: [], lastActivity: new Date(0), latestPreview: "",
    canPublish: false, canReact: true, joinedCount: 3, hasOlder: false, avatarUrl: null, ...overrides,
  };
}

function fakeApi(responses: Record<string, unknown>) {
  const request = vi.fn(async (path: string) => {
    if (path in responses) return responses[path];
    throw new Error(`unexpected ${path}`);
  });
  return { api: { request } as unknown as ApiClient, request };
}

function renderView(user: UserProfile, api: ApiClient, selectedChannelId?: string) {
  const onSelectChannel = vi.fn();
  const onNotify = vi.fn();
  const view = render(
    <ChannelsView api={api} user={user} matrixSession={null} selectedChannelId={selectedChannelId} onSelectChannel={onSelectChannel} onNotify={onNotify} />,
  );
  return { ...view, onSelectChannel, onNotify };
}

describe("ChannelsView (communities)", () => {
  beforeEach(() => {
    matrixSnapshot.channelRooms = {};
    matrixSnapshot.client = null;
  });

  it("shows a loading state, then an honest empty state, and lets any user create a community", async () => {
    let resolve: (value: Channel[]) => void = () => undefined;
    const api = { request: vi.fn(() => new Promise<Channel[]>((r) => { resolve = r; })) } as unknown as ApiClient;
    renderView(baseUser, api);
    expect(screen.getByRole("status").textContent).toContain("Loading communities");
    await act(async () => resolve([]));
    expect(await screen.findByText(/No communities yet/)).toBeTruthy();
    expect(screen.queryByText(/Engineering|Finance|HR Team|members/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create community" })).toBeTruthy();
    expect(screen.queryByText(/Discover/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create community" }));
    expect(screen.getByRole("dialog", { name: "Create a community" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Gaming" })).toBeTruthy();
  });

  it("renders a member's community read-only with the admin-only notice, live reactions and a Joined control", async () => {
    matrixSnapshot.channelRooms = {
      "!eng:localhost": roomSummary({
        unreadCount: 2,
        latestPreview: "Sprint v2.4 is now live!",
        announcements: [{
          id: "$a1", sender: "them", senderName: "Alice", title: "Sprint v2.4 is now live!", text: "Deployed.", delivery: "sent",
          sentAt: new Date(), matrix: { eventId: "$a1", roomId: "!eng:localhost", eventType: "m.room.message", senderId: "@a:localhost" },
          reactions: [{ key: "👍", count: 4, mine: false }],
        }],
      }),
    };
    const { api } = fakeApi({ "/channels": [channel()], "/channels/c1": channel() });
    renderView(baseUser, api, "c1");
    expect(await screen.findByRole("heading", { level: 1, name: /Engineering Team/ })).toBeTruthy();
    expect(screen.getByText("3 members · Engineering · Sprint news")).toBeTruthy();
    expect(screen.getByText("Only community admins can post announcements")).toBeTruthy();
    expect(screen.queryByLabelText("Announcement text")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sprint v2.4 is now live!" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "👍 4" })).toBeTruthy();
    expect(screen.getByLabelText("2 unread announcements").textContent).toBe("2");
    expect(screen.getByRole("button", { name: /Joined/ })).toBeTruthy();
    expect(screen.queryByLabelText("Verified community")).toBeNull();
    expect(screen.getByRole("tab", { name: "Members (3)" })).toBeTruthy();
  });

  it("shows the composer and the owner badge to the owner", async () => {
    matrixSnapshot.channelRooms = { "!eng:localhost": roomSummary({ canPublish: true }) };
    const owned = channel({ creator_id: "u1", membership: { role: "owner", status: "joined", joined_at: null }, can_manage: true, can_edit: true, can_publish: true });
    const { api } = fakeApi({ "/channels": [owned], "/channels/c1": owned });
    renderView(baseUser, api, "c1");
    expect(await screen.findByLabelText("Announcement text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.queryByText("Only community admins can post announcements")).toBeNull();
    expect(screen.getByRole("heading", { name: "No announcements yet" })).toBeTruthy();
  });

  it("previews a community before joining and marks it Joined only once membership is confirmed", async () => {
    const open = channel({ id: "c3", matrix_room_id: "!hr:localhost", name: "People Updates", description: "HR news", category: "hr", membership: null, member_count: 12 });
    const invited = { ...open, membership: { role: "member" as const, status: "invited" as const, joined_at: null } };
    const { api, request } = fakeApi({ "/channels": [open], "/channels/c3": open, "/channels/c3/join": invited });
    renderView(baseUser, api, "c3");
    expect(await screen.findByRole("heading", { level: 2, name: "People Updates" })).toBeTruthy();
    expect(screen.getByText("HR · 12 members")).toBeTruthy();
    expect(screen.queryByText(/Only community admins/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Join community" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/channels/c3/join", expect.objectContaining({ method: "POST" })));
    // The backend only invited so far: no "Joined" until Matrix membership is confirmed.
    await waitFor(() => expect(screen.getByText("Joining the community…")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Joined/ })).toBeNull();
  });

  it("separates similar names, never renders one ID twice, and offers Join on other communities", async () => {
    matrixSnapshot.channelRooms = {
      "!eng:localhost": roomSummary({ unreadCount: 1, latestPreview: "Hello" }),
      "!eng2:localhost": roomSummary({ roomId: "!eng2:localhost", unreadCount: 0 }),
    };
    const twin = channel({ id: "c2", matrix_room_id: "!eng2:localhost", name: "Engineering Team b" });
    const open = channel({ id: "c3", matrix_room_id: "!hr:localhost", name: "People Updates", membership: null });
    const joinedOpen = { ...open, membership: { role: "member" as const, status: "joined" as const, joined_at: null } };
    const { api, request } = fakeApi({ "/channels": [channel(), twin, channel(), open], "/channels/c3/join": joinedOpen, "/channels/c3": joinedOpen });
    const { onSelectChannel } = renderView(baseUser, api);
    expect(await screen.findByText("Engineering Team b")).toBeTruthy();
    expect(screen.getAllByText("Engineering Team")).toHaveLength(1);
    expect(screen.getByText("People Updates")).toBeTruthy();
    expect(screen.getByText("My communities")).toBeTruthy();
    expect(screen.getByText("More communities")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Unread/ }));
    expect(screen.getByText("Engineering Team")).toBeTruthy();
    expect(screen.queryByText("Engineering Team b")).toBeNull();
    expect(screen.queryByText("People Updates")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByText("Engineering Team b")).toBeTruthy();
    expect(screen.queryByText("People Updates")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Join People Updates" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/channels/c3/join", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(onSelectChannel).toHaveBeenCalledWith("c3"));
  });

  it("shows a not-available state for a direct link to an unknown or archived community", async () => {
    const { api } = fakeApi({ "/channels": [] });
    renderView(baseUser, api, "missing");
    expect(await screen.findByText("This community is not available")).toBeTruthy();
  });

  it("accepts a pending invite for a joined community through the Matrix client", async () => {
    const joinRoom = vi.fn().mockResolvedValue({});
    matrixSnapshot.client = { joinRoom, getUserId: () => "@u1:localhost", getRooms: () => [], on: vi.fn(), off: vi.fn() };
    matrixSnapshot.channelRooms = { "!eng:localhost": roomSummary({ membership: "invite" }) };
    const invited = channel({ membership: { role: "member", status: "invited", joined_at: null } });
    const { api } = fakeApi({ "/channels": [invited], "/channels/c1": channel() });
    renderView(baseUser, api);
    await waitFor(() => expect(joinRoom).toHaveBeenCalledWith("!eng:localhost"));
  });
});
