import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation } from "../../types";
import { ChatHeader } from "./ChatHeader";

afterEach(cleanup);

const conversation = {
  id: "!room:localhost", name: "Alice", username: "alice", initials: "A", accent: 0,
  isTyping: true, connectionAllowed: true,
} as Conversation;

it("shows and clears incoming typing without any encryption indicator", () => {
  const props = { conversation, matrixSession: null, onBack: vi.fn() };
  const view = render(<ChatHeader {...props} />);
  expect(screen.getByText("typing…")).toBeTruthy();
  expect(screen.queryByLabelText(/encrypt/i)).toBeNull();
  view.rerender(<ChatHeader {...props} conversation={{ ...conversation, isTyping: false }} />);
  expect(screen.queryByText("typing…")).toBeNull();
  expect(screen.getByText("@alice")).toBeTruthy();
});

it("shows Online text and a green dot for an online direct contact", () => {
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, presence: "online" }} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.getByText("Online")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
});

it.each([["unavailable", "Away"], ["offline", "Offline"]] as const)("shows %s as %s text with a matching dot, never Online", (presence, label) => {
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, presence }} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.getByText(label).className).toBe("presence-text");
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  expect(screen.queryByText("Online")).toBeNull();
  expect(screen.queryByText("@alice")).toBeNull();
});

it.each(["unknown", undefined] as const)("falls back to the handle with no dot when presence is %s", (presence) => {
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, presence }} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.getByText("@alice")).toBeTruthy();
  expect(screen.queryByRole("img", { name: /Online|Away|Offline/ })).toBeNull();
  expect(screen.queryByText(/Online|Away|Offline/)).toBeNull();
});

it("never shows a single-user online dot for a group", () => {
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, isGroup: true, presence: "online" }} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.queryByRole("img", { name: "Online" })).toBeNull();
  expect(screen.queryByText("Online")).toBeNull();
});

it("offers a back button for mobile", () => {
  const onBack = vi.fn();
  render(<ChatHeader conversation={{ ...conversation, isTyping: false }} matrixSession={null} onBack={onBack} />);
  fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
  expect(onBack).toHaveBeenCalled();
});

it("exposes search, favorite, pin and info actions only when they are implemented", () => {
  const handlers = { onToggleSearch: vi.fn(), onToggleFavorite: vi.fn(), onTogglePinned: vi.fn(), onOpenInfo: vi.fn() };
  const quiet = { ...conversation, isTyping: false };
  const view = render(<ChatHeader conversation={quiet} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /Search in conversation|favorites|More actions/ })).toBeNull();
  view.unmount();

  render(<ChatHeader conversation={quiet} matrixSession={null} canTag onBack={vi.fn()} {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "Search in conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
  fireEvent.click(screen.getByRole("button", { name: "Open details for Alice" }));
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pin conversation" }));
  expect(handlers.onToggleSearch).toHaveBeenCalled();
  expect(handlers.onToggleFavorite).toHaveBeenCalled();
  expect(handlers.onOpenInfo).toHaveBeenCalled();
  expect(handlers.onTogglePinned).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /call/i })).toBeNull();
});
