import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "../../types";
import { MessageList } from "./MessageList";

// Deterministic animation frames: scrollToLatest schedules one frame per batch of changes and a
// cancelled frame must never run (that is what React StrictMode's remount does in development).
let frames: (FrameRequestCallback | null)[] = [];
function flushFrames() {
  act(() => {
    const pending = frames;
    frames = [];
    for (const frame of pending) frame?.(performance.now());
  });
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = null; });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW_HEIGHT = 60;
const VIEWPORT = 400;

function message(id: string, sender: "me" | "them", text: string, delivery: Message["delivery"] = "sent"): Message {
  const eventId = id.startsWith("txn:") ? `~${id.slice(4)}` : id;
  return {
    id, sender, text, delivery, sentAt: new Date("2026-10-30T15:07:00.000Z"),
    matrix: { eventId, roomId: "!room:localhost", eventType: "m.room.message", senderId: sender === "me" ? "@self:localhost" : "@peer:localhost" },
  };
}

function conversation(messages: Message[]): Conversation {
  return {
    id: "!room:localhost", name: "Peer", initials: "P", accent: 0, lastMessage: "", updatedAt: new Date(0),
    unreadCount: 0, messages,
  } as Conversation;
}

const history = Array.from({ length: 30 }, (_, i) => message(`$h${i}`, i % 2 ? "me" : "them", `history ${i}`));

/** jsdom has no layout: give the scroller a height per rendered bubble and a working scrollTo. */
function setup(initial: Conversation, strict = false) {
  const scrollTo = vi.fn();
  const element = (current: Conversation) => (
    <MessageList conversation={current} matrixSession={null} searchTerm="" searchOpen={false} ownAvatar={{ name: "Self" }} />
  );
  const view = render(strict ? <StrictMode>{element(initial)}</StrictMode> : element(initial));
  const scroller = view.container.querySelector<HTMLDivElement>(".messages-scroll")!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => scroller.querySelectorAll("article[data-event-id]").length * ROW_HEIGHT,
  });
  scroller.scrollTo = scrollTo.mockImplementation((options: ScrollToOptions) => {
    // Browsers clamp to the maximum scroll offset.
    scroller.scrollTop = Math.max(0, Math.min(options.top ?? 0, scroller.scrollHeight - VIEWPORT));
  }) as unknown as typeof scroller.scrollTo;
  const distanceFromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const scrollTo_ = (top: number) => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  };
  const update = (next: Conversation) => {
    act(() => { view.rerender(strict ? <StrictMode>{element(next)}</StrictMode> : element(next)); });
    flushFrames();
  };
  // Settle the initial open-conversation scroll.
  flushFrames();
  scrollTo.mockClear();
  return { view, scroller, scrollTo, distanceFromBottom, scrollUserTo: scrollTo_, update };
}

describe("auto-scroll on send", () => {
  it("scrolls to the newest message when sending while reading older history", () => {
    const t = setup(conversation(history));
    t.scrollUserTo(0);
    expect(t.distanceFromBottom()).toBeGreaterThan(80);
    t.update(conversation([...history, message("txn:a", "me", "mine", "sending")]));
    expect(t.scrollTo).toHaveBeenCalledTimes(1);
    expect(t.distanceFromBottom()).toBe(0);
    expect(t.view.container.querySelector(".new-messages-pill")).toBeNull();
  });

  it("follows each message of a rapid burst without smooth animation", () => {
    const t = setup(conversation(history));
    t.scrollUserTo(0);
    let messages = history;
    for (let i = 0; i < 12; i++) {
      messages = [...messages, message(`txn:r${i}`, "me", `rapid ${i}`, "sending")];
      t.update(conversation(messages));
      expect(t.distanceFromBottom()).toBe(0);
    }
    expect(t.scrollTo).toHaveBeenCalledTimes(12);
    for (const [options] of t.scrollTo.mock.calls) expect(options.behavior).toBe("instant");
  });

  it("does not move the reader when someone else writes while they read history, and offers the pill", () => {
    const t = setup(conversation(history));
    t.scrollUserTo(0);
    t.update(conversation([...history, message("$in", "them", "incoming")]));
    expect(t.scrollTo).not.toHaveBeenCalled();
    expect(t.scroller.scrollTop).toBe(0);
    expect(t.view.container.querySelector(".new-messages-pill")?.textContent).toContain("New message");
    // Their own send from there still goes to the bottom and clears the pill.
    t.update(conversation([...history, message("$in", "them", "incoming"), message("txn:b", "me", "reply", "sending")]));
    expect(t.distanceFromBottom()).toBe(0);
    expect(t.view.container.querySelector(".new-messages-pill")).toBeNull();
  });

  it("keeps following at the bottom when an incoming message lands above a still-sending echo", () => {
    const pendingTail = [...history, message("txn:c", "me", "mine", "sending")];
    const t = setup(conversation(pendingTail));
    t.scrollUserTo(t.scroller.scrollHeight - VIEWPORT);
    // A confirmed peer message is ordered before the unsent echo: same last id, one more message.
    t.update(conversation([...history, message("$peer", "them", "peer"), message("txn:c", "me", "mine", "sending")]));
    expect(t.scrollTo).toHaveBeenCalledTimes(1);
    expect(t.distanceFromBottom()).toBe(0);
  });

  it("does not scroll again when the local echo is acknowledged", () => {
    const t = setup(conversation(history));
    const echo = message("txn:d", "me", "mine", "sending");
    t.update(conversation([...history, echo]));
    expect(t.scrollTo).toHaveBeenCalledTimes(1);
    const acked: Message = { ...echo, delivery: "sent", matrix: { ...echo.matrix!, eventId: "$d:localhost" } };
    t.update(conversation([...history, acked]));
    t.update(conversation([...history, { ...acked, delivery: "read" }]));
    expect(t.scrollTo).toHaveBeenCalledTimes(1);
    expect(t.view.container.querySelector(".new-messages-pill")).toBeNull();
  });

  it("still scrolls after React StrictMode's development remount cancelled the first frame", () => {
    const t = setup(conversation(history), true);
    t.scrollUserTo(0);
    t.update(conversation([...history, message("txn:e", "me", "mine", "sending")]));
    expect(t.scrollTo).toHaveBeenCalled();
    expect(t.distanceFromBottom()).toBe(0);
  });
});
