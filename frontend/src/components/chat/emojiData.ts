import emojiMartData from "@emoji-mart/data/sets/15/native.json";
import type { EmojiMartData } from "@emoji-mart/data";

export type EmojiCategoryId =
  | "recent"
  | "smileys"
  | "people"
  | "animals"
  | "food"
  | "travel"
  | "activities"
  | "objects"
  | "symbols"
  | "flags";

export interface EmojiItem {
  emoji: string;
  name: string;
  keywords: string;
  category: Exclude<EmojiCategoryId, "recent">;
}

const data = emojiMartData as EmojiMartData;
const peopleIds = data.categories.find(({ id }) => id === "people")?.emojis ?? [];
const firstHandIndex = peopleIds.indexOf("wave");
const firstAnimalFaceIndex = peopleIds.indexOf("smiley_cat");
const firstSymbolIndex = peopleIds.indexOf("love_letter");
const skinToneNames = [
  "light skin tone",
  "medium-light skin tone",
  "medium skin tone",
  "medium-dark skin tone",
  "dark skin tone",
];

export const EMOJI_CATEGORIES: {
  id: Exclude<EmojiCategoryId, "recent">;
  label: string;
}[] = [
  { id: "smileys", label: "Smileys & Emotions" },
  { id: "people", label: "People & Gestures" },
  { id: "animals", label: "Animals & Nature" },
  { id: "food", label: "Food & Drinks" },
  { id: "travel", label: "Travel & Places" },
  { id: "activities", label: "Activities" },
  { id: "objects", label: "Objects" },
  { id: "symbols", label: "Symbols" },
  { id: "flags", label: "Flags" },
];

function getPickerCategory(sourceCategory: string, id: string): EmojiItem["category"] {
  if (sourceCategory !== "people") {
    const mappedCategory: Record<string, EmojiItem["category"]> = {
      nature: "animals",
      foods: "food",
      activity: "activities",
      places: "travel",
      objects: "objects",
      symbols: "symbols",
      flags: "flags",
    };
    return mappedCategory[sourceCategory] ?? "objects";
  }

  const index = peopleIds.indexOf(id);
  if (index < firstHandIndex) return "smileys";
  if (id === "robot_face") return "objects";
  if (index >= firstAnimalFaceIndex && index < firstSymbolIndex) return "animals";
  if (index >= firstSymbolIndex) return "symbols";
  return "people";
}

export const EMOJI_DATA: EmojiItem[] = data.categories.flatMap(
  ({ id: sourceCategory, emojis }) =>
    emojis.flatMap((id) => {
      const emoji = data.emojis[id];
      if (!emoji) return [];
      const category = getPickerCategory(sourceCategory, id);
      return emoji.skins.map((skin, skinIndex) => ({
        emoji: skin.native,
        name:
          skinIndex === 0
            ? emoji.name
            : `${emoji.name}, ${skinToneNames[skinIndex - 1] ?? "skin tone"}`,
        keywords: [...emoji.keywords, ...(skinIndex > 0 ? [skinToneNames[skinIndex - 1]] : [])]
          .filter(Boolean)
          .join(" "),
        category,
      }));
    }),
);

export const EMOJI_BY_CATEGORY = new Map(
  EMOJI_CATEGORIES.map(({ id }) => [
    id,
    EMOJI_DATA.filter((item) => item.category === id),
  ]),
);

export const EMOJI_BY_CHARACTER = new Map(
  EMOJI_DATA.map((item) => [item.emoji, item]),
);

export const RECENT_EMOJI_STORAGE_KEY = "recruitable-chat:recent-emojis:v1";
