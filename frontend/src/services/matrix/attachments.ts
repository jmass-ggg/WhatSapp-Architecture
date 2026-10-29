import type { MatrixClient } from "matrix-js-sdk";
import { MsgType } from "matrix-js-sdk";

export const MAX_ATTACHMENT_BYTES = Number(import.meta.env.VITE_MAX_ATTACHMENT_BYTES) || 20 * 1024 * 1024;
const types: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const prefix = (bytes: Uint8Array, signature: number[]) => signature.every((byte, index) => bytes[index] === byte);

export async function validateAttachment(file: File): Promise<string> {
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is empty or exceeds the 20 MiB limit.");
  const ext = file.name.split(".").at(-1)?.toLowerCase() || "";
  const mime = types[ext];
  if (!mime || (file.type && file.type !== mime && !(ext === "csv" && file.type === "application/vnd.ms-excel"))) {
    throw new Error("Unsupported or suspicious attachment type.");
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const signatures: Record<string, number[]> = {
    jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47],
    pdf: [0x25, 0x50, 0x44, 0x46], docx: [0x50, 0x4b, 0x03, 0x04],
    xlsx: [0x50, 0x4b, 0x03, 0x04], pptx: [0x50, 0x4b, 0x03, 0x04],
    doc: [0xd0, 0xcf, 0x11, 0xe0], xls: [0xd0, 0xcf, 0x11, 0xe0], ppt: [0xd0, 0xcf, 0x11, 0xe0],
    webp: [0x52, 0x49, 0x46, 0x46],
  };
  if (signatures[ext] && !prefix(head, signatures[ext])) throw new Error("Attachment signature does not match its type.");
  if (ext === "webp" && !prefix(head.slice(8), [0x57, 0x45, 0x42, 0x50])) throw new Error("Invalid WebP attachment.");
  if (["txt", "csv"].includes(ext) && head.includes(0)) throw new Error("Text attachment contains binary data.");
  return mime;
}

export async function sendAttachment(
  client: MatrixClient, roomId: string, file: File, replyEventId?: string,
  progress?: (status: string) => void,
): Promise<void> {
  progress?.("Preparing file");
  const mime = await validateAttachment(file);
  progress?.("Uploading: 0%");
  const uploaded = await client.uploadContent(file, {
    type: mime,
    progressHandler: ({ loaded, total }) => progress?.(`Uploading: ${Math.min(100, Math.round(100 * loaded / (total || file.size)))}%`),
  });
  progress?.("Sending message");
  await client.sendMessage(roomId, {
    msgtype: mime.startsWith("image/") ? MsgType.Image : MsgType.File,
    body: file.name,
    info: { size: file.size, mimetype: mime },
    url: uploaded.content_uri,
    ...(replyEventId ? { "m.relates_to": { "m.in_reply_to": { event_id: replyEventId } } } : {}),
  });
  progress?.("Sent");
}
