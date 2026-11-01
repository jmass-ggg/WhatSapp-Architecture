import type { Attachment, Message } from "../../types";

export interface SharedAttachment {
  eventId: string;
  attachment: Attachment;
  sentAt?: Date;
  senderName?: string;
}

export interface SharedLink {
  url: string;
  eventId: string;
  sentAt?: Date;
}

export interface SharedContent {
  images: SharedAttachment[];
  files: SharedAttachment[];
  links: SharedLink[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Extracts http(s) URLs from text, trimming trailing sentence punctuation. */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[).,;:!?\]]+$/, "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") found.push(parsed.toString());
    } catch {
      /* not a valid URL; ignore */
    }
  }
  return found;
}

/** Builds shared media, files and links from messages already loaded for a room (newest first). */
export function extractSharedContent(messages: Message[]): SharedContent {
  const images: SharedAttachment[] = [];
  const files: SharedAttachment[] = [];
  const links: SharedLink[] = [];
  const seenLinks = new Set<string>();

  for (const message of [...messages].reverse()) {
    const eventId = message.matrix?.eventId;
    if (!eventId || message.delivery === "failed" || message.delivery === "cancelled") continue;
    if (message.attachment) {
      const item = { eventId, attachment: message.attachment, sentAt: message.sentAt, senderName: message.senderName };
      (message.attachment.kind === "image" ? images : files).push(item);
    }
    for (const url of extractUrls(message.text)) {
      if (seenLinks.has(url)) continue;
      seenLinks.add(url);
      links.push({ url, eventId, sentAt: message.sentAt });
    }
  }
  return { images, files, links };
}
