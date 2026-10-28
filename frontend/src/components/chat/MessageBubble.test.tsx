import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { Conversation, Message } from "../../types";
import { MessageBubble } from "./MessageBubble";

afterEach(cleanup);

it("shows SDK-derived outgoing status and no receipt for incoming messages", () => {
  const conversation = { isGroup: false } as Conversation;
  const message = {
    id: "~local", sender: "me", text: "Hello", sentAt: new Date(1_750_000_000_000),
    delivery: "sending",
  } as Message;
  const view = render(<MessageBubble message={message} conversation={conversation} matrixSession={null} />);
  expect(screen.getByLabelText("Sending")).toBeTruthy();
  view.rerender(<MessageBubble message={{ ...message, delivery: "sent" }} conversation={conversation} matrixSession={null} />);
  expect(screen.getByLabelText("Sent")).toBeTruthy();
  view.rerender(<MessageBubble message={{ ...message, delivery: "read", readAt: new Date(1_750_000_000_000) }} conversation={conversation} matrixSession={null} />);
  expect(screen.getByLabelText("Read")).toBeTruthy();
  expect(screen.getByLabelText(/^Seen at /)).toBeTruthy();
  view.rerender(<MessageBubble message={{ ...message, delivery: "failed" }} conversation={conversation} matrixSession={null} />);
  expect(screen.getByText("Not sent")).toBeTruthy();
  view.rerender(<MessageBubble message={{ ...message, sender: "them" }} conversation={conversation} matrixSession={null} />);
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(screen.queryByLabelText("Sent")).toBeNull();
});
