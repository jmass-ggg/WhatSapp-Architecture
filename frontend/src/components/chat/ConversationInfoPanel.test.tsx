import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Conversation } from "../../types";
import { ConversationInfoPanel } from "./ConversationInfoPanel";

afterEach(cleanup);

const contact = {
  id: "!d:localhost", name: "Maya Thompson", username: "maya", initials: "MT", accent: 0, presence: "online",
  jobTitle: "Product Designer", department: "Design", about: "Designs things.", roomId: "!d:localhost",
} as Conversation;

const empty = { images: [], files: [], links: [] };

const setup = (over: Partial<Parameters<typeof ConversationInfoPanel>[0]> = {}) => {
  const props = {
    conversation: contact, matrixSession: null, shared: empty, starred: [], members: [], isFavorite: false,
    canTag: true, canLoadOlder: false, loadingOlder: false, onLoadOlder: vi.fn(), onToggleFavorite: vi.fn(),
    onSearch: vi.fn(), onOpenMessage: vi.fn(), onNotify: vi.fn(), onClose: vi.fn(), ...over,
  };
  render(<ConversationInfoPanel {...props} />);
  return props;
};

it("shows only real profile data and confirmed online status", () => {
  setup();
  expect(screen.getByText("Product Designer")).toBeTruthy();
  expect(screen.getByText("@maya")).toBeTruthy();
  expect(screen.getByText("Design")).toBeTruthy();
  expect(screen.getByText("Designs things.")).toBeTruthy();
  expect(screen.getByText("Online")).toBeTruthy();
  cleanup();
  setup({ conversation: { ...contact, presence: "unknown", jobTitle: undefined, about: undefined } });
  expect(screen.queryByText("Online")).toBeNull();
  expect(screen.getByText("This contact has not added a bio.")).toBeTruthy();
});

it("shows honest empty states instead of fabricated counts", () => {
  setup();
  expect(screen.getByText("No shared media in loaded history.")).toBeTruthy();
  expect(screen.getByText("No files or links in loaded history.")).toBeTruthy();
  expect(screen.getByText("No starred messages in this conversation.")).toBeTruthy();
});

it("lists real files and links with safe external link attributes", () => {
  setup({
    shared: {
      images: [],
      files: [{ eventId: "$f", attachment: { name: "Brief.pdf", kind: "file", mimeType: "application/pdf", size: 1_200_000, mediaUri: "mxc://s/f" } }],
      links: [{ url: "https://design.example.com/", eventId: "$l" }],
    },
  });
  expect(screen.getByText("Brief.pdf")).toBeTruthy();
  expect(screen.getByText("PDF · 1.2 MB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download Brief.pdf" })).toBeTruthy();
  const link = screen.getByRole("link", { name: "Open https://design.example.com/" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

it("opens the image viewer from a thumbnail and closes it with Escape without closing the panel", () => {
  const props = setup({
    shared: { images: [{ eventId: "$i", attachment: { name: "board.png", kind: "image", url: "blob:board" } }], files: [], links: [] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open image board.png" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("closes with the button and with Escape", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("wires search and favorite actions, and hides favorite for contacts without a room", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
  expect(props.onSearch).toHaveBeenCalled();
  expect(props.onToggleFavorite).toHaveBeenCalled();
  cleanup();
  setup({ canTag: false });
  expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
});

it("opens a starred message and labels unloaded ones honestly", () => {
  const props = setup({ starred: [{ eventId: "$a", text: "Remember this", senderName: "Maya" }, { eventId: "$b" }] });
  fireEvent.click(screen.getByText("Remember this"));
  expect(props.onOpenMessage).toHaveBeenCalledWith("$a");
  expect(screen.getByText("Open to load this message")).toBeTruthy();
});

it("shows group members with roles and the real member count", () => {
  setup({
    conversation: { ...contact, isGroup: true, name: "Design Team", presence: undefined },
    members: [
      { userId: "@o", name: "Owner", role: "admin" },
      { userId: "@m", name: "Mia", role: "member" },
    ],
    topic: "All things design",
  });
  expect(screen.getByText("2 members")).toBeTruthy();
  expect(screen.getByText("All things design")).toBeTruthy();
  expect(screen.getByText("Admin")).toBeTruthy();
  expect(within(screen.getByLabelText("Group information")).queryByText("Online")).toBeNull();
});
