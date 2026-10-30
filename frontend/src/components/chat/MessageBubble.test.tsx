import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("message pin actions and timestamps", () => {
  const conversation = { id: "!room:localhost", isGroup: true } as Conversation;
  const message = {
    id: "$message:localhost",
    sender: "them",
    senderName: "Kelly Boyle",
    text: "Please check this",
    sentAt: new Date("2026-10-30T15:07:00.000Z"),
    delivery: "sent",
    matrix: {
      eventId: "$message:localhost",
      roomId: "!room:localhost",
      eventType: "m.room.encrypted",
      senderId: "@kelly:localhost",
    },
  } as Message;

  it("opens accessible actions and calls pin and unpin handlers", () => {
    const onTogglePin = vi.fn();
    const view = render(
      <MessageBubble
        message={message}
        conversation={conversation}
        matrixSession={null}
        canManagePins
        onTogglePin={onTogglePin}
        isPinned={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin message" }));
    expect(onTogglePin).toHaveBeenCalledWith("$message:localhost");

    view.rerender(
      <MessageBubble
        message={message}
        conversation={conversation}
        matrixSession={null}
        canManagePins
        onTogglePin={onTogglePin}
        isPinned
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin message" }));
    expect(onTogglePin).toHaveBeenLastCalledWith("$message:localhost");
    expect(screen.getByLabelText("Pinned message")).toBeTruthy();
  });

  it("shows a readable full timestamp and safely handles invalid dates", () => {
    const view = render(
      <MessageBubble message={message} conversation={conversation} matrixSession={null} />,
    );
    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/i);
    expect(time.getAttribute("title")).toBeTruthy();
    expect(time.getAttribute("dateTime")).toBe(message.sentAt?.toISOString());

    view.rerender(
      <MessageBubble
        message={{ ...message, sentAt: new Date(Number.NaN) }}
        conversation={conversation}
        matrixSession={null}
      />,
    );
    expect(screen.getByText("Time unavailable")).toBeTruthy();
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });

  it("disables pinning when the room already has three pins", () => {
    render(
      <MessageBubble
        message={message}
        conversation={conversation}
        matrixSession={null}
        canManagePins
        canPinNewMessage={false}
        onTogglePin={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin message" }).hasAttribute("disabled")).toBe(true);
  });

  it("closes the action menu on Escape and keeps focus on its trigger", () => {
    render(
      <MessageBubble
        message={message}
        conversation={conversation}
        matrixSession={null}
        canManagePins
        onTogglePin={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Message actions" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Message actions" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Message actions" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
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
