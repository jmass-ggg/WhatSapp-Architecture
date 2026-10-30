import {
  Clock3,
  Dumbbell,
  Film,
  Flag,
  Hand,
  Heart,
  Leaf,
  Lightbulb,
  Plane,
  Search,
  Smile,
  Sticker,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  EMOJI_BY_CATEGORY,
  EMOJI_BY_CHARACTER,
  EMOJI_CATEGORIES,
  EMOJI_DATA,
  RECENT_EMOJI_STORAGE_KEY,
  type EmojiCategoryId,
  type EmojiItem,
} from "./emojiData";

interface EmojiPickerProps {
  open: boolean;
  disabled?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

const CATEGORY_TABS: {
  id: EmojiCategoryId;
  label: string;
  Icon: LucideIcon;
}[] = [
  { id: "recent", label: "Recently Used", Icon: Clock3 },
  { id: "smileys", label: "Smileys & Emotions", Icon: Smile },
  { id: "people", label: "People & Gestures", Icon: Hand },
  { id: "animals", label: "Animals & Nature", Icon: Leaf },
  { id: "food", label: "Food & Drinks", Icon: Utensils },
  { id: "travel", label: "Travel & Places", Icon: Plane },
  { id: "activities", label: "Activities", Icon: Dumbbell },
  { id: "objects", label: "Objects", Icon: Lightbulb },
  { id: "symbols", label: "Symbols", Icon: Heart },
  { id: "flags", label: "Flags", Icon: Flag },
];

const SEARCHABLE_EMOJIS = [
  ...new Map(EMOJI_DATA.map((item) => [item.emoji, item])).values(),
].map((item) => ({
  item,
  text: `${item.name} ${item.keywords}`.toLowerCase(),
}));

const EmojiButton = memo(function EmojiButton({
  item,
  index,
  disabled,
  onSelect,
  onGridKeyDown,
}: {
  item: EmojiItem;
  index: number;
  disabled: boolean;
  onSelect: (emoji: string) => void;
  onGridKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className="emoji-picker-emoji"
      type="button"
      data-emoji-index={index}
      aria-label={`Insert ${item.name}`}
      title={item.name}
      tabIndex={index === 0 ? 0 : -1}
      disabled={disabled}
      onKeyDown={onGridKeyDown}
      onClick={() => onSelect(item.emoji)}
    >
      {item.emoji}
    </button>
  );
});

function readRecentEmojis(): string[] {
  try {
    const saved = window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter(
        (emoji): emoji is string =>
          typeof emoji === "string" && EMOJI_BY_CHARACTER.has(emoji),
      )
      .filter((emoji) => {
        if (seen.has(emoji)) return false;
        seen.add(emoji);
        return true;
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function EmojiPicker({
  open,
  disabled = false,
  anchorRef,
  onClose,
  onSelect,
}: EmojiPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sectionsRef = useRef<Partial<Record<EmojiCategoryId, HTMLElement | null>>>({});
  const navigationTargetRef = useRef<EmojiCategoryId | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] =
    useState<EmojiCategoryId>("recent");
  const [recent, setRecent] = useState<string[]>(readRecentEmojis);
  const recentRef = useRef(recent);
  const onSelectRef = useRef(onSelect);
  const [isMobile, setIsMobile] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const recentItems = useMemo(
    () =>
      recent
        .map((emoji) => EMOJI_BY_CHARACTER.get(emoji))
        .filter((item): item is EmojiItem => item !== undefined),
    [recent],
  );
  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return SEARCHABLE_EMOJIS.filter(({ text }) => text.includes(query)).map(
      ({ item }) => item,
    );
  }, [search]);

  const updatePosition = useCallback(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;

    const mobile = window.innerWidth <= 640;
    setIsMobile(mobile);
    if (mobile) {
      setPosition({ left: 0, top: 0 });
      return;
    }

    const trigger = anchor.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const panelWidth = panelBounds.width || Math.min(520, window.innerWidth - 16);
    const panelHeight = panelBounds.height || Math.min(540, window.innerHeight - 16);
    const left = Math.min(
      Math.max(8, trigger.left),
      Math.max(8, window.innerWidth - panelWidth - 8),
    );
    const topAbove = trigger.top - panelHeight - 8;
    const top =
      topAbove >= 8
        ? topAbove
        : Math.min(trigger.bottom + 8, window.innerHeight - panelHeight - 8);
    setPosition({ left, top: Math.max(8, top) });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    searchRef.current?.focus();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !panelRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchorRef.current?.querySelector("button")?.focus();
        return;
      }
      if (event.key !== "Tab" || !isMobile || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]',
      );
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorRef, isMobile, onClose, open]);

  useLayoutEffect(() => {
    if (search || !navigationTargetRef.current) return;
    const target = navigationTargetRef.current;
    navigationTargetRef.current = null;
    sectionsRef.current[target]?.scrollIntoView?.({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }, [search]);

  const selectEmoji = useCallback((emoji: string) => {
    const next = [emoji, ...recentRef.current.filter((item) => item !== emoji)].slice(0, 20);
    recentRef.current = next;
    setRecent(next);
    try {
      window.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Recent emoji history is a convenience and may be unavailable in private mode.
    }
    onSelectRef.current(emoji);
  }, []);

  const navigateToCategory = useCallback(
    (category: EmojiCategoryId) => {
      setActiveCategory(category);
      if (search) {
        navigationTargetRef.current = category;
        setSearch("");
        return;
      }
      sectionsRef.current[category]?.scrollIntoView?.({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    },
    [search],
  );

  const updateActiveCategory = useCallback(() => {
    const body = bodyRef.current;
    if (!body || search) return;
    const bodyTop = body.getBoundingClientRect().top;
    const threshold = bodyTop + 56;
    let active: EmojiCategoryId = "recent";
    for (const tab of CATEGORY_TABS) {
      const section = sectionsRef.current[tab.id];
      if (section && section.getBoundingClientRect().top <= threshold) {
        active = tab.id;
      }
    }
    setActiveCategory(active);
  }, [search]);

  const handleGridKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const keyOffsets: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -(window.innerWidth <= 380 ? 7 : window.innerWidth <= 640 ? 8 : 11),
        ArrowDown: window.innerWidth <= 380 ? 7 : window.innerWidth <= 640 ? 8 : 11,
      };
      const grid = event.currentTarget.closest(".emoji-picker-grid");
      const gridSize = Number(grid?.getAttribute("data-grid-size")) || 0;
      if (event.key === "Home") {
        event.preventDefault();
        grid
          ?.querySelector<HTMLButtonElement>("[data-emoji-index='0']")
          ?.focus();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        grid
          ?.querySelector<HTMLButtonElement>(
            `[data-emoji-index='${gridSize - 1}']`,
          )
          ?.focus();
        return;
      }
      const offset = keyOffsets[event.key];
      if (offset === undefined) return;
      event.preventDefault();
      const currentIndex = Number(event.currentTarget.dataset.emojiIndex);
      const nextIndex = Math.max(
        0,
        Math.min(
          gridSize - 1,
          currentIndex + offset,
        ),
      );
      grid
        ?.querySelector<HTMLButtonElement>(
          `[data-emoji-index='${nextIndex}']`,
        )
        ?.focus();
    },
    [],
  );

  const handleCategoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, category: EmojiCategoryId) => {
      const currentIndex = CATEGORY_TABS.findIndex((tab) => tab.id === category);
      let nextIndex: number;
      if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % CATEGORY_TABS.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + CATEGORY_TABS.length) % CATEGORY_TABS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = CATEGORY_TABS.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const nextCategory = CATEGORY_TABS[nextIndex].id;
      navigateToCategory(nextCategory);
      panelRef.current
        ?.querySelector<HTMLButtonElement>(
          `[aria-controls='emoji-section-${nextCategory}']`,
        )
        ?.focus();
    },
    [navigateToCategory],
  );

  const renderGrid = (items: EmojiItem[]) => (
    <div
      className="emoji-picker-grid"
      data-grid-size={items.length}
      role="group"
    >
      {items.map((item, index) => (
        <EmojiButton
          key={`${item.emoji}-${index}`}
          item={item}
          index={index}
          disabled={disabled}
          onSelect={selectEmoji}
          onGridKeyDown={handleGridKeyDown}
        />
      ))}
    </div>
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={`emoji-picker-layer${isMobile ? " is-mobile" : ""}`}>
      {isMobile && (
        <button
          className="emoji-picker-backdrop"
          type="button"
          aria-label="Close emoji picker"
          onClick={onClose}
        />
      )}
      <div
        className={`emoji-picker${isMobile ? " is-mobile" : ""}`}
        ref={panelRef}
        id="emoji-picker-dialog"
        role="dialog"
        aria-label="Emoji picker"
        aria-modal={isMobile || undefined}
        style={isMobile ? undefined : { left: position.left, top: position.top }}
      >
        <div className="emoji-picker-category-nav" role="tablist" aria-label="Emoji categories">
          {CATEGORY_TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`emoji-picker-category${activeCategory === id ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={activeCategory === id}
              aria-controls={search ? undefined : `emoji-section-${id}`}
              tabIndex={activeCategory === id ? 0 : -1}
              title={label}
              onKeyDown={(event) => handleCategoryKeyDown(event, id)}
              onClick={() => navigateToCategory(id)}
            >
              <Icon size={19} aria-hidden="true" />
            </button>
          ))}
        </div>

        <label className="emoji-picker-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search emoji"
            aria-label="Search emoji"
          />
          {search && (
            <button
              className="emoji-picker-clear"
              type="button"
              aria-label="Clear emoji search"
              onClick={() => setSearch("")}
            >
              <X size={16} />
            </button>
          )}
        </label>

        <div
          className="emoji-picker-body"
          ref={bodyRef}
          onScroll={updateActiveCategory}
          role="region"
          aria-label={search ? "Emoji search results" : "Emoji categories"}
          tabIndex={-1}
        >
          {search ? (
            <section className="emoji-picker-section" aria-label="Search results">
              <h2>Search results</h2>
              {searchResults.length > 0 ? (
                renderGrid(searchResults)
              ) : (
                <div className="emoji-picker-empty" role="status">
                  <span aria-hidden="true">🔎</span>
                  <p>No emoji found for “{search}”</p>
                  <button type="button" onClick={() => setSearch("")}>
                    Clear search
                  </button>
                </div>
              )}
            </section>
          ) : (
            <>
              <section
                className="emoji-picker-section"
                id="emoji-section-recent"
                aria-label="Recently Used emojis"
                ref={(element) => {
                  sectionsRef.current.recent = element;
                }}
              >
                <h2>Recently Used</h2>
                {recentItems.length > 0 ? (
                  renderGrid(recentItems)
                ) : (
                  <div className="emoji-picker-empty is-compact">
                    <span aria-hidden="true">⌛</span>
                    <p>Your recently used emoji will appear here</p>
                  </div>
                )}
              </section>
              {EMOJI_CATEGORIES.map(({ id, label }) => (
                <section
                  key={id}
                  className="emoji-picker-section"
                  id={`emoji-section-${id}`}
                  aria-label={`${label} emojis`}
                  ref={(element) => {
                    sectionsRef.current[id] = element;
                  }}
                >
                  <h2>{label}</h2>
                  {renderGrid(EMOJI_BY_CATEGORY.get(id) ?? [])}
                </section>
              ))}
            </>
          )}
        </div>

        <div className="emoji-picker-footer" role="tablist" aria-label="Picker type">
          <button
            className="emoji-picker-footer-tab is-active"
            type="button"
            role="tab"
            aria-selected="true"
            aria-label="Emoji"
          >
            <Smile size={18} aria-hidden="true" />
            <span>Emoji</span>
          </button>
          <button
            className="emoji-picker-footer-tab is-unavailable"
            type="button"
            role="tab"
            aria-label="GIF, coming soon"
            title="GIF support is coming soon"
            disabled
          >
            <Film size={18} aria-hidden="true" />
            <span>GIF</span>
            <small>Soon</small>
          </button>
          <button
            className="emoji-picker-footer-tab is-unavailable"
            type="button"
            role="tab"
            aria-label="Stickers, coming soon"
            title="Sticker support is coming soon"
            disabled
          >
            <Sticker size={18} aria-hidden="true" />
            <span>Stickers</span>
            <small>Soon</small>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
