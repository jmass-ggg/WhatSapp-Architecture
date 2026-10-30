import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageComposer } from "./MessageComposer";

const roomId = "!room:localhost";

function setup(allowed = true) {
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  const onSend = vi.fn().mockResolvedValue(undefined);
  const client = { sendTyping } as unknown as MatrixClient;
  const view = render(<MessageComposer typingClient={client} typingRoomId={roomId} typingAllowed={allowed} onSend={onSend} />);
  const input = screen.getByRole("textbox", { name: "Write a message" });
  return { sendTyping, onSend, client, input, ...view };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("MessageComposer typing", () => {
  it("starts once, refreshes during continued activity, and stops after inactivity", () => {
    vi.useFakeTimers();
    const { input, sendTyping } = setup();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.change(input, { target: { value: "hello!" } });
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith(roomId, true, 5000);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.change(input, { target: { value: "hello!!" } });
    act(() => vi.advanceTimersByTime(2000));
    expect(sendTyping).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(500));
    expect(sendTyping).toHaveBeenLastCalledWith(roomId, false, 0);
  });

  it("stops when cleared and after a successful send", async () => {
    const { input, sendTyping, onSend } = setup();
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(sendTyping).toHaveBeenLastCalledWith(roomId, false, 0);
    fireEvent.change(input, { target: { value: "message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await act(async () => { await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledWith("message", undefined);
    expect(sendTyping).toHaveBeenLastCalledWith(roomId, false, 0);
  });

  it("stops the old room on switch and unmount", () => {
    vi.useFakeTimers();
    const { input, sendTyping, client, rerender, unmount, onSend } = setup();
    fireEvent.change(input, { target: { value: "hello" } });
    rerender(<MessageComposer typingClient={client} typingRoomId="!other:localhost" typingAllowed onSend={onSend} />);
    expect(sendTyping).toHaveBeenLastCalledWith(roomId, false, 0);
    act(() => vi.advanceTimersByTime(5000));
    expect(sendTyping).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { value: "again" } });
    unmount();
    expect(sendTyping).toHaveBeenLastCalledWith("!other:localhost", false, 0);
  });

  it("never sends for disabled or unauthorized conversations", () => {
    const { input, sendTyping, client, rerender, onSend } = setup(false);
    fireEvent.change(input, { target: { value: "hello" } });
    expect(sendTyping).not.toHaveBeenCalled();
    rerender(<MessageComposer typingClient={client} typingRoomId={roomId} typingAllowed disabled onSend={onSend} />);
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(sendTyping).not.toHaveBeenCalled();
  });
});

describe("MessageComposer emoji insertion", () => {
  it("inserts multiple emoji at the caret, preserves the draft, and keeps the picker open", async () => {
    const { input } = setup();
    const textarea = input as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello world" } });
    textarea.focus();
    textarea.setSelectionRange(5, 5);

    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    const search = await screen.findByRole(
      "searchbox",
      { name: "Search emoji" },
      { timeout: 5000 },
    );
    fireEvent.change(search, { target: { value: "fire" } });
    fireEvent.click(await screen.findByRole("button", { name: "Insert Fire" }));

    expect(textarea.value).toBe("hello🔥 world");
    expect(textarea.selectionStart).toBe(7);
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Insert Fire" }));
    expect(textarea.value).toBe("hello🔥🔥 world");
    expect(textarea.selectionStart).toBe(9);
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();
  });
});
