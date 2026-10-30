import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinnedMessageBanner, type PinnedMessageSummary } from "./PinnedMessageBanner";

afterEach(cleanup);

describe("PinnedMessageBanner", () => {
  const messages: PinnedMessageSummary[] = [
    {
      eventId: "$one",
      sender: "Kelly Boyle",
      preview: "Hello, please check this message.",
      sentAt: new Date("2026-10-30T15:52:00.000Z"),
    },
    {
      eventId: "$two",
      sender: "You",
      preview: "Second pinned message",
      sentAt: new Date("2026-10-30T16:02:00.000Z"),
    },
  ];

  it("shows friendly sender, preview and original event time with navigation", () => {
    const onJump = vi.fn();
    const onSelectIndex = vi.fn();
    render(
      <PinnedMessageBanner
        messages={messages}
        activeIndex={0}
        onSelectIndex={onSelectIndex}
        onJump={onJump}
        canUnpin={false}
        onUnpin={vi.fn()}
      />,
    );

    expect(screen.getByText("Kelly Boyle")).toBeTruthy();
    expect(screen.getByText("Hello, please check this message.")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Jump to pinned message from Kelly Boyle/i }));
    expect(onJump).toHaveBeenCalledWith("$one");
    fireEvent.click(screen.getByRole("button", { name: "Next pinned message" }));
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it("offers unpin only when permitted and handles unavailable messages", () => {
    const onUnpin = vi.fn();
    const unavailable = {
      eventId: "$gone",
      sender: "Original message",
      preview: "This pinned message is unavailable.",
      unavailable: true,
    };
    const view = render(
      <PinnedMessageBanner
        messages={[unavailable]}
        activeIndex={0}
        onSelectIndex={vi.fn()}
        onJump={vi.fn()}
        canUnpin={false}
        onUnpin={onUnpin}
      />,
    );
    expect(screen.queryByRole("button", { name: /Unpin message/ })).toBeNull();
    expect(screen.getByText("This pinned message is unavailable.")).toBeTruthy();

    view.rerender(
      <PinnedMessageBanner
        messages={[unavailable]}
        activeIndex={0}
        onSelectIndex={vi.fn()}
        onJump={vi.fn()}
        canUnpin
        onUnpin={onUnpin}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpin message from Original message" }));
    expect(onUnpin).toHaveBeenCalledWith("$gone");
  });
});
