import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../services/api/client";
import type { DirectoryUser, UserConnection } from "../../types";
import { NewConversationDialog } from "./NewConversationDialog";

afterEach(cleanup);

const kanye: DirectoryUser = {
  id: "kanye-user-id",
  username: "kanyewest",
  profile: {
    user_id: "kanye-user-id",
    display_name: "Kanye West",
    profile_picture_url: null,
    bio: null,
    job_title: null,
    department: null,
  },
};

function acceptedContact(id: string, username: string): UserConnection {
  return {
    id: `connection-${id}`,
    requester_id: "james-user-id",
    recipient_id: id,
    status: "accepted",
    created_at: "",
    updated_at: "",
    accepted_at: "",
    other_user: {
      id,
      username,
      profile: {
        user_id: id,
        display_name: username,
        profile_picture_url: null,
        bio: null,
        job_title: null,
        department: null,
      },
    },
  };
}

describe("NewConversationDialog", () => {
  it("sends a connection request and keeps the result in Request Sent state", async () => {
    const request = vi.fn().mockResolvedValue({
      items: [kanye],
      limit: 20,
      offset: 0,
      total: 1,
    });
    const api = { request } as unknown as ApiClient;
    const onSendRequest = vi.fn().mockResolvedValue(undefined);

    render(
      <NewConversationDialog
        open
        mode="live"
        api={api}
        currentUserId="james-user-id"
        conversations={[]}
        connections={[]}
        incomingRequests={[]}
        outgoingRequests={[]}
        onClose={vi.fn()}
        onSelectDemo={vi.fn()}
        onSendRequest={onSendRequest}
        onCreateGroup={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search people" }), {
      target: { value: "kanye" },
    });
    await screen.findByText("Kanye West");

    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));
    await waitFor(() => expect(onSendRequest).toHaveBeenCalledWith(kanye));

    const requestSent = await screen.findByRole("button", { name: "Request Sent" });
    expect(requestSent.hasAttribute("disabled")).toBe(true);
    expect(request).toHaveBeenCalledWith("/users/search?q=kanye&limit=20");
  });

  it("validates the group name and minimum participant count", async () => {
    const onCreateGroup = vi.fn().mockResolvedValue(undefined);
    render(
      <NewConversationDialog
        open
        mode="live"
        api={{ request: vi.fn() } as unknown as ApiClient}
        currentUserId="james-user-id"
        conversations={[]}
        connections={[acceptedContact("bob-id", "Bob"), acceptedContact("charlie-id", "Charlie")]}
        incomingRequests={[]}
        outgoingRequests={[]}
        onClose={vi.fn()}
        onSelectDemo={vi.fn()}
        onSendRequest={vi.fn()}
        onCreateGroup={onCreateGroup}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New Group" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/enter a name/i);

    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
      target: { value: "Development Team" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Bob" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least two/i);
    expect(onCreateGroup).not.toHaveBeenCalled();
  });

  it("creates a group with unique accepted contacts and blocks repeated clicks", async () => {
    let resolveCreation: (() => void) | undefined;
    const onCreateGroup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    render(
      <NewConversationDialog
        open
        mode="live"
        api={{ request: vi.fn() } as unknown as ApiClient}
        currentUserId="james-user-id"
        conversations={[]}
        connections={[
          acceptedContact("bob-id", "Bob"),
          acceptedContact("charlie-id", "Charlie"),
          acceptedContact("charlie-id", "Charlie"),
          { ...acceptedContact("pending-id", "Pending"), status: "pending" },
          acceptedContact("james-user-id", "James"),
        ]}
        incomingRequests={[]}
        outgoingRequests={[]}
        onClose={vi.fn()}
        onSelectDemo={vi.fn()}
        onSendRequest={vi.fn()}
        onCreateGroup={onCreateGroup}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New Group" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
      target: { value: "Development Team" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Bob" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Charlie" }));
    expect(screen.queryByRole("checkbox", { name: "James" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Pending" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
    await waitFor(() =>
      expect(onCreateGroup).toHaveBeenCalledWith(
        "Development Team",
        ["bob-id", "charlie-id"],
      ),
    );
    expect(onCreateGroup).toHaveBeenCalledOnce();
    resolveCreation?.();
  });
});
