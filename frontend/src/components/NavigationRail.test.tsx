import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { UserProfile } from "../types";
import { NavigationRail } from "./NavigationRail";

afterEach(cleanup);

const user = {
  id: "me", username: "maya", profile: { display_name: "Maya Chen", profile_picture_url: null },
} as unknown as UserProfile;

const setup = (active: "chats" | "channels" = "chats") => {
  const onNavigate = vi.fn();
  const onSignOut = vi.fn();
  render(<NavigationRail active={active} currentUser={user} matrixSession={null} onNavigate={onNavigate} onSignOut={onSignOut} />);
  return { onNavigate, onSignOut };
};

it("marks exactly one primary item as current", () => {
  setup("chats");
  const current = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");
  expect(current).toHaveLength(1);
  expect(current[0].textContent).toContain("Chats");
});

it("disables sections that have no view yet instead of leaving dead buttons", () => {
  setup();
  expect((screen.getByRole("button", { name: /Channels/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("navigates to chats and signs out from the account menu", () => {
  const { onNavigate, onSignOut } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  expect(onNavigate).toHaveBeenCalledWith("chats");
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  expect(screen.getByText("@maya")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
  expect(onSignOut).toHaveBeenCalled();
});
