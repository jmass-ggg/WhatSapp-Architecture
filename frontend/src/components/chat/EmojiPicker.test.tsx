import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmojiPicker } from "./EmojiPicker";
import { EMOJI_DATA, RECENT_EMOJI_STORAGE_KEY } from "./emojiData";

function PickerHarness({ onSelect = vi.fn() }: { onSelect?: (emoji: string) => void }) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={anchorRef}>
        <button type="button" onClick={() => setOpen((current) => !current)}>
          Toggle emoji
        </button>
      </div>
      <EmojiPicker
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        onSelect={onSelect}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RECENT_EMOJI_STORAGE_KEY);
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
});

describe("EmojiPicker", () => {
  it("loads a full maintained catalog and moves through the emoji grid with arrow keys", () => {
    expect(EMOJI_DATA.length).toBeGreaterThan(2_000);
    render(<PickerHarness />);

    const search = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "happy" } });
    const firstEmoji = screen.getByRole("button", { name: "Insert Grinning Face" });
    const grid = firstEmoji.closest(".emoji-picker-grid");
    const secondEmoji = grid?.querySelector<HTMLButtonElement>(
      "[data-emoji-index='1']",
    );
    expect(secondEmoji).not.toBeNull();
    fireEvent.keyDown(firstEmoji, { key: "ArrowRight" });
    expect(document.activeElement).toBe(secondEmoji);
  });

  it("focuses search, filters by emoji names and keywords without regard to case, and clears search", () => {
    render(<PickerHarness />);

    const search = screen.getByRole("searchbox", { name: "Search emoji" });
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "HAPPY" } });
    expect(screen.getByRole("button", { name: "Insert Grinning Face" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insert Smiling Face with Smiling Eyes" })).not.toBeNull();

    fireEvent.change(search, { target: { value: "cry" } });
    expect(screen.getByRole("button", { name: "Insert Crying Face" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insert Loudly Crying Face" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insert Face Holding Back Tears" })).not.toBeNull();

    fireEvent.change(search, { target: { value: "love" } });
    expect(screen.getByRole("button", { name: "Insert Red Heart" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insert Smiling Face with Hearts" })).not.toBeNull();

    fireEvent.change(search, { target: { value: "no-such-emoji" } });
    expect(screen.getByRole("status").textContent).toContain("No emoji found");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("scrolls to a category and updates the active category while the grid scrolls", () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<PickerHarness />);

      const animalsTab = screen.getByRole("tab", { name: "Animals & Nature" });
      fireEvent.click(animalsTab);
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: "start" }),
      );
      expect(animalsTab.getAttribute("aria-selected")).toBe("true");

      const body = screen.getByRole("region", { name: "Emoji categories" });
      const sectionTopById: Record<string, number> = {
        "emoji-section-recent": -200,
        "emoji-section-smileys": -150,
        "emoji-section-people": -80,
        "emoji-section-animals": 20,
        "emoji-section-food": 500,
      };
      for (const section of document.querySelectorAll<HTMLElement>(".emoji-picker-section")) {
        const top = sectionTopById[section.id] ?? 900;
        vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
          top,
          bottom: top + 100,
          left: 0,
          right: 100,
          width: 100,
          height: 100,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect);
      }
      vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 400,
        left: 0,
        right: 520,
        width: 520,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
      fireEvent.scroll(body);
      expect(animalsTab.getAttribute("aria-selected")).toBe("true");
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("stores the latest distinct emoji and restores recent history after remounting", () => {
    const onSelect = vi.fn();
    const firstRender = render(<PickerHarness onSelect={onSelect} />);
    const search = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "fire" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert Fire" }));
    fireEvent.change(search, { target: { value: "happy" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert Grinning Face" }));

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? "[]")).toEqual(["😀", "🔥"]);
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();

    firstRender.unmount();
    render(<PickerHarness />);
    const recentSection = screen.getByRole("region", { name: "Emoji categories" })
      .querySelector("#emoji-section-recent");
    expect(recentSection?.querySelector(".emoji-picker-emoji")?.textContent).toBe("😀");
  });

  it("keeps no more than 20 recent emoji", () => {
    const uniqueEmoji = [...new Set(EMOJI_DATA.map(({ emoji }) => emoji))];
    const previous = uniqueEmoji.slice(0, 20);
    window.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(previous));
    render(<PickerHarness />);

    const search = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "fire" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert Fire" }));
    const recent = JSON.parse(
      window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? "[]",
    ) as string[];
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("🔥");
    expect(new Set(recent).size).toBe(20);
  });

  it("supports category keyboard navigation and skin-tone variants", () => {
    render(<PickerHarness />);
    const recentTab = screen.getByRole("tab", { name: "Recently Used" });
    fireEvent.keyDown(recentTab, { key: "ArrowRight" });
    const smileysTab = screen.getByRole("tab", { name: "Smileys & Emotions" });
    expect(document.activeElement).toBe(smileysTab);
    expect(smileysTab.getAttribute("aria-selected")).toBe("true");

    const search = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "light skin tone" } });
    expect(screen.getByRole("button", { name: "Insert Waving Hand, light skin tone" })).not.toBeNull();
  });

  it("closes on outside pointer and Escape, returning focus to the trigger on Escape", () => {
    render(<PickerHarness />);
    const trigger = screen.getByRole("button", { name: "Toggle emoji" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("uses a modal bottom sheet on narrow screens", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    render(<PickerHarness />);

    const dialog = screen.getByRole("dialog", { name: "Emoji picker" });
    expect(dialog.classList.contains("is-mobile")).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "Close emoji picker" })).not.toBeNull();

    screen.getByRole("button", { name: "Toggle emoji" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Recently Used" }),
    );
  });
});
