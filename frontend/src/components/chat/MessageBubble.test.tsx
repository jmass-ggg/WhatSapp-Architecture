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

it("does not show group delivery or read receipts from one member", () => {
  const conversation = { isGroup: true } as Conversation;
  const message = {
    id: "$group-message",
    sender: "me",
    text: "Hello group",
    sentAt: new Date(1_750_000_000_000),
    delivery: "read",
    readAt: new Date(1_750_000_000_000),
  } as Message;

  render(
    <MessageBubble
      message={message}
      conversation={conversation}
      matrixSession={null}
    />,
  );

  expect(screen.getByLabelText("Sent")).toBeTruthy();
  expect(screen.queryByLabelText("Read")).toBeNull();
  expect(screen.queryByLabelText(/^Seen at /)).toBeNull();
});

it("keeps group sender labels, replies, and event timestamps visible", () => {
  const sentAt = new Date(1_750_000_000_000);
  const conversation = { isGroup: true } as Conversation;
  const message = {
    id: "$reply",
    sender: "them",
    senderName: "Bob",
    text: "Thanks!",
    sentAt,
    delivery: "sent",
    replyTo: {
      eventId: "$original",
      sender: "Alice",
      text: "Please review this.",
    },
    matrix: {
      eventId: "$reply",
      roomId: "!group:localhost",
      eventType: "m.room.encrypted",
      senderId: "@bob:localhost",
      encryptionStatus: "decrypted",
    },
  } as Message;
  const view = render(
    <MessageBubble
      message={message}
      conversation={conversation}
      matrixSession={null}
    />,
  );

  expect(view.container.querySelector(".message-sender")?.textContent).toBe("Bob");
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText("Please review this.")).toBeTruthy();
  expect(view.container.querySelector("time")?.getAttribute("dateTime")).toBe(
    sentAt.toISOString(),
  );
});
