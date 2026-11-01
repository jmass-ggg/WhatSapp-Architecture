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

describe("MessageComposer reply preview", () => {
  const base = { id: "1", text: "asdasd", sender: "them", senderName: "Acton Glenn", time: "8:30", delivery: "read" } as never;
  const renderReply = (message: Record<string, unknown>, onCancelReply = vi.fn()) => {
    render(<MessageComposer onSend={vi.fn().mockResolvedValue(undefined)} replyTo={{ ...(base as object), ...message } as never} onCancelReply={onCancelReply} />);
    return onCancelReply;
  };

  it("shows sender and excerpt, and cancel keeps the draft and refocuses the input", () => {
    const cancel = renderReply({});
    expect(screen.getByText("Replying to Acton Glenn")).toBeTruthy();
    expect(screen.getByText("asdasd")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft" } });
    const btn = screen.getByRole("button", { name: "Cancel reply" });
    expect(btn.getAttribute("title")).toBe("Cancel reply");
    fireEvent.click(btn);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("draft");
    expect(document.activeElement).toBe(input);
  });

  it("labels own messages and attachment kinds without raw payloads", () => {
    cleanup();
    renderReply({ sender: "me", text: "" , attachment: { kind: "audio", name: "v.webm" } });
    expect(screen.getByText("Replying to yourself")).toBeTruthy();
    expect(screen.getByText("Voice message")).toBeTruthy();
    cleanup();
    renderReply({ text: "", attachment: { kind: "image", name: "a.png" } });
    expect(screen.getByText("Photo")).toBeTruthy();
    cleanup();
    renderReply({ text: "", attachment: { kind: "file", name: "cv.pdf" } });
    expect(screen.getByText("cv.pdf")).toBeTruthy();
    cleanup();
    renderReply({ text: "" });
    expect(screen.getByText("Original message unavailable")).toBeTruthy();
  });
});

describe("MessageComposer mentions", () => {
  const members = [
    { userId: "@james:x", name: "James Gurung" },
    { userId: "@james2:x", name: "James Gurung" },
    { userId: "@alex:x", name: "Alex Smith" },
    { userId: "@me:x", name: "Me" },
  ];
  const setupMentions = (onSend = vi.fn().mockResolvedValue(undefined)) => {
    render(<MessageComposer onSend={onSend} mentionMembers={members} ownUserId="@me:x" />);
    const input = screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
    return { onSend, input };
  };
  const type = (input: HTMLTextAreaElement, value: string) => fireEvent.change(input, { target: { value } });

  it("opens on @, filters by name/username, shows an empty state, and excludes yourself", () => {
    const { input } = setupMentions();
    type(input, "@");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /^Me,/ })).toBeNull();
    type(input, "@ALEX");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    type(input, "@nobody");
    expect(screen.getByText("No matching members")).toBeTruthy();
    type(input, "mail a@b.com");
    expect(screen.queryByText("Mention someone")).toBeNull();
  });

  it("navigates with arrows, Enter selects without sending, Escape closes, normal Enter still sends", async () => {
    const { input, onSend } = setupMentions();
    type(input, "Hi @j");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Hi @James Gurung ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(onSend).toHaveBeenCalledWith("Hi @James Gurung", undefined, [{ userId: "@james2:x", label: "@James Gurung", start: 3, end: 16 }]);
    expect(input.value).toBe("");
    type(input, "@a");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects by mouse, supports several mentions, and drops a mention whose text is edited", async () => {
    const { input, onSend } = setupMentions();
    type(input, "@ale");
    fireEvent.click(screen.getByRole("option", { name: /Alex Smith/ }));
    type(input, `${input.value}and @jam`);
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(document.activeElement).toBe(input);
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    const mentions = onSend.mock.calls[0][2];
    expect(mentions.map((m: { userId: string }) => m.userId)).toEqual(["@alex:x", "@james:x"]);
    type(input, "@ale");
    fireEvent.click(screen.getByRole("option", { name: /Alex/ }));
    type(input, "@Alx Smith ");
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onSend.mock.calls[1][2]).toBeUndefined();
  });

  it("keeps plain @text unmentioned, shifts offsets when pasting before a mention, and keeps state after a failed send", async () => {
    const onSend = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { input } = setupMentions(onSend);
    type(input, "@Alex Smith plain");
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onSend.mock.calls[0][2]).toBeUndefined(); // typed, never selected
    type(input, "@ale");
    fireEvent.click(screen.getByRole("option", { name: /Alex/ }));
    type(input, `PASTE ${input.value}`);
    await act(async () => { fireEvent.submit(input.closest("form")!); }); // fails
    expect(input.value).toBe("PASTE @Alex Smith ");
    await act(async () => { fireEvent.submit(input.closest("form")!); }); // retry succeeds
    expect(onSend.mock.calls[2][2]).toEqual([{ userId: "@alex:x", label: "@Alex Smith", start: 6, end: 17 }]);
    expect(input.value).toBe("");
  });

  it("only suggests the supplied room's members after the room changes", () => {
    const { rerender } = render(<MessageComposer onSend={vi.fn()} mentionMembers={members} ownUserId="@me:x" />);
    rerender(<MessageComposer onSend={vi.fn()} mentionMembers={[{ userId: "@zed:y", name: "Zed" }]} ownUserId="@me:x" />);
    const input = screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
    type(input, "@");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Zed/ })).toBeTruthy();
  });
});
