import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChannelAnnouncementCard } from "./ChannelAnnouncementCard";
import type { Announcement } from "../../types";

afterEach(cleanup);

const channel = { name: "Engineering Team", category: "engineering" as const, avatarUrl: null };
const announcement: Announcement = {
  id: "$a1", sender: "them", senderName: "Alice", title: "Sprint v2.4 is now live!", text: "We shipped.", delivery: "sent",
  sentAt: new Date("2026-11-03T11:20:00"),
  matrix: { eventId: "$a1", roomId: "!c:localhost", eventType: "m.room.message", senderId: "@a:localhost" },
  reactions: [{ key: "👍", count: 48, mine: true, myEventId: "$r" }, { key: "🎉", count: 16, mine: false }],
};

it("shows real reaction counts, highlights the user's own and toggles through the callback", () => {
  const onToggleReaction = vi.fn();
  render(<ChannelAnnouncementCard announcement={announcement} channel={channel} canReact onToggleReaction={onToggleReaction} />);
  expect(screen.getByText("Engineering Team")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Sprint v2.4 is now live!" })).toBeTruthy();
  const mine = screen.getByRole("button", { name: /👍 48, you reacted/ });
  expect(mine.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "🎉 16" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(mine);
  expect(onToggleReaction).toHaveBeenCalledWith(announcement, "👍");
  fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "React with ❤️" }));
  expect(onToggleReaction).toHaveBeenLastCalledWith(announcement, "❤️");
});

it("disables reactions for readers without permission and offers retry on failure", () => {
  const onRetry = vi.fn();
  render(
    <ChannelAnnouncementCard
      announcement={{ ...announcement, sender: "me", delivery: "failed", reactions: [] }}
      channel={channel}
      canReact={false}
      onRetry={onRetry}
    />,
  );
  expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
  expect(screen.getByText("Not published")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
  expect(onRetry).toHaveBeenCalled();
});
