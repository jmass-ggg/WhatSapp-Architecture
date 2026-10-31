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

it("never claims online presence and offers a back button for mobile", () => {
  const onBack = vi.fn();
  render(<ChatHeader conversation={{ ...conversation, isTyping: false, isOnline: true }} matrixSession={null} onBack={onBack} />);
  expect(screen.queryByText(/online/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
  expect(onBack).toHaveBeenCalled();
});
