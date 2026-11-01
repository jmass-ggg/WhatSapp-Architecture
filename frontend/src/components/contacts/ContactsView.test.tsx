import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { UserConnection } from "../../types";
import { ContactsView } from "./ContactsView";

afterEach(cleanup);

const connection = (id: string, username: string, name: string, extra = {}): UserConnection =>
  ({
    id: `c-${id}`, status: "accepted",
    other_user: { id, username, profile: { display_name: name, profile_picture_url: null, bio: null, job_title: null, department: null, user_id: id, ...extra } },
  }) as unknown as UserConnection;

const setup = (over: Partial<Parameters<typeof ContactsView>[0]> = {}) => {
  const props = {
    connections: [
      connection("u1", "maya", "Maya Thompson", { job_title: "Designer", department: "Product", bio: "Hello!" }),
      connection("u2", "olivia", "Olivia Park"),
    ],
    incomingRequests: [], outgoingRequests: [], loading: false, error: null, matrixSession: null,
    respondingRequestId: null, startingContactId: null,
    onMessage: vi.fn(), onAccept: vi.fn(), onDecline: vi.fn(), onAddContact: vi.fn(), ...over,
  };
  render(<ContactsView {...props} />);
  return props;
};

it("lists accepted contacts, filters by name, username or job title, and opens a real profile", () => {
  const props = setup();
  fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "designer" } });
  expect(screen.queryByText("Olivia Park")).toBeNull();
  fireEvent.click(screen.getByText("Maya Thompson"));
  expect(screen.getByText("Hello!")).toBeTruthy();
  expect(screen.getByText("Product")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(props.onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
});

it("accepts and declines incoming requests and lists sent ones as pending", () => {
  const request = { ...connection("u3", "sam", "Sam Lee"), status: "pending" } as UserConnection;
  const props = setup({ incomingRequests: [request], outgoingRequests: [{ ...request, id: "c-out", other_user: { ...request.other_user, id: "u4", username: "pat" } }] });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(props.onAccept).toHaveBeenCalledWith(request);
  expect(props.onDecline).toHaveBeenCalledWith(request);
  expect(screen.getByText("Pending")).toBeTruthy();
});

it("shows an empty state and an Add contact action when there are no contacts", () => {
  const props = setup({ connections: [] });
  expect(screen.getByText(/No contacts yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
  expect(props.onAddContact).toHaveBeenCalled();
});
