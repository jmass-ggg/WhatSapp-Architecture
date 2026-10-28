import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation } from "../../types";
import { ChatHeader } from "./ChatHeader";

afterEach(cleanup);

it("shows and clears incoming typing in an encrypted room while retaining the lock", () => {
  const conversation = {
    id: "!room:localhost", name: "Alice", initials: "A", accent: 0,
    isEncrypted: true, isTyping: true, connectionAllowed: true,
  } as Conversation;
  const props = {
    conversation, mode: "live" as const, matrixSession: null,
    cryptoStatus: "ready" as const, searchOpen: false,
    onBack: vi.fn(), onSearch: vi.fn(), onContactInfo: vi.fn(),
  };
  const view = render(<ChatHeader {...props} />);
  expect(screen.getByText("typing…")).toBeTruthy();
  expect(screen.getByLabelText("End-to-end encrypted room")).toBeTruthy();
  view.rerender(<ChatHeader {...props} conversation={{ ...conversation, isTyping: false }} />);
  expect(screen.queryByText("typing…")).toBeNull();
  expect(screen.getByText("End-to-end encrypted · Rust crypto")).toBeTruthy();
});
