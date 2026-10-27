import type { Conversation, Message } from "../types";

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

function message(
  id: string,
  sender: Message["sender"],
  text: string,
  minutes: number,
  extras: Partial<Message> = {},
): Message {
  return {
    id,
    sender,
    text,
    sentAt: minutesAgo(minutes),
    delivery: sender === "me" ? "read" : "sent",
    ...extras,
  };
}

export function getDemoConversations(): Conversation[] {
  const ariMessages = [
    message("ari-1", "them", "Hey Maya! How was the studio visit?", 162),
    message("ari-2", "me", "So lovely. I got way too many ideas for the new board.", 158),
    message("ari-3", "them", "That sounds like the best kind of afternoon ✨", 155, {
      reaction: { emoji: "✨", count: 2 },
    }),
    message("ari-4", "them", "I saved a few things for us to look at.", 3, {
      attachment: {
        name: "Sunday at the studio",
        kind: "image",
        url: "/demo-landscape.svg",
        mimeType: "image/svg+xml",
        size: 1_800_000,
        demoOnly: true,
      },
    }),
    message("ari-5", "me", "This light is perfect. Adding it to the moodboard.", 1, {
      replyTo: { sender: "Ari", text: "I saved a few things for us to look at." },
    }),
  ];

  return [
    {
      id: "ari",
      name: "Ari Parker",
      username: "ari.parker",
      initials: "AP",
      accent: 1,
      isOnline: true,
      lastMessage: "This light is perfect. Adding it to the moodboard.",
      updatedAt: minutesAgo(1),
      unreadCount: 0,
      messages: ariMessages,
      bio: "Creative director · usually collecting color palettes",
      isDemo: true,
    },
    {
      id: "thea",
      name: "Thea Morgan",
      username: "thea.m",
      initials: "TM",
      accent: 2,
      isOnline: true,
      lastMessage: "Voice message · 0:18",
      updatedAt: minutesAgo(12),
      unreadCount: 2,
      messages: [
        message("thea-1", "them", "Are we still on for coffee tomorrow?", 125),
        message("thea-2", "me", "Absolutely. There’s a new place by the park!", 117),
        message("thea-3", "them", "Voice message · 0:18", 12, {
          attachment: {
            name: "Voice message",
            kind: "file",
            mimeType: "audio/mpeg",
            size: 320_000,
            demoOnly: true,
          },
        }),
      ],
      bio: "Here for the little moments ☀️",
      isDemo: true,
    },
    {
      id: "noah",
      name: "Noah Williams",
      username: "noah.w",
      initials: "NW",
      accent: 3,
      isOnline: false,
      lastMessage: "You: The notes are in the shared folder",
      updatedAt: minutesAgo(48),
      unreadCount: 0,
      messages: [
        message("noah-1", "them", "Can you send over the notes from the call?", 95),
        message("noah-2", "me", "The notes are in the shared folder", 48),
      ],
      bio: "Product-minded, people-first.",
      isDemo: true,
    },
    {
      id: "leo",
      name: "Leo Fischer",
      username: "leo.fischer",
      initials: "LF",
      accent: 5,
      isOnline: false,
      lastMessage: "Thanks again! 🙌",
      updatedAt: minutesAgo(1_440),
      unreadCount: 0,
      messages: [
        message("leo-1", "me", "I sent the PDF over. Let me know if it opens.", 1_500, {
          attachment: {
            name: "Project overview.pdf",
            kind: "file",
            mimeType: "application/pdf",
            size: 2_400_000,
            demoOnly: true,
          },
        }),
        message("leo-2", "them", "Thanks again! 🙌", 1_440),
      ],
      bio: "Building things with a little more care.",
      isDemo: true,
    },
  ];
}

export function getDemoUserId(): string {
  return "demo-user";
}
