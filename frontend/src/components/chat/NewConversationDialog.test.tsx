import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../services/api/client";
import type { DirectoryUser } from "../../types";
import { NewConversationDialog } from "./NewConversationDialog";

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
});
