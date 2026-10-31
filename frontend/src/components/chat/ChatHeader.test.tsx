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

it.each(["unknown", "unavailable", "offline"] as const)("shows no dot or online text when presence is %s", (presence) => {
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, presence }} matrixSession={null} onBack={vi.fn()} />);
  expect(screen.queryByText("Online")).toBeNull();
  expect(screen.queryByRole("img", { name: "Online" })).toBeNull();
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
