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

export const MAX_VOICE_DURATION_MS = 120_000;
/** Preferred recorder formats, best first; the browser picks the first it supports. */
export const VOICE_RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
const VOICE_EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" };

export interface VoiceRecording { blob: Blob; mimeType: string; durationMs: number }
/** Per-recording state kept across retries so an uncertain send is never duplicated. */
export interface VoiceSendAttempt { txnId?: string; contentUri?: string }

export const baseMimeType = (type: string) => type.split(";")[0].trim().toLowerCase();

export async function validateVoiceRecording(recording: VoiceRecording): Promise<string> {
  const mime = baseMimeType(recording.mimeType || recording.blob.type);
  if (!VOICE_EXTENSIONS[mime]) throw new Error("This browser recorded an unsupported audio format.");
  if (!recording.blob.size) throw new Error("The recording is empty.");
  if (recording.blob.size > MAX_ATTACHMENT_BYTES) throw new Error("The recording exceeds the 20 MiB limit.");
  if (!Number.isFinite(recording.durationMs) || recording.durationMs <= 0 || recording.durationMs > MAX_VOICE_DURATION_MS + 1000) {
    throw new Error("The recording duration is invalid.");
  }
  const head = new Uint8Array(await recording.blob.slice(0, 12).arrayBuffer());
  const ok = mime === "audio/webm" ? prefix(head, [0x1a, 0x45, 0xdf, 0xa3])
    : mime === "audio/ogg" ? prefix(head, [0x4f, 0x67, 0x67, 0x53])
    : prefix(head.slice(4), [0x66, 0x74, 0x79, 0x70]);
  if (!ok) throw new Error("The recording data does not match its audio format.");
  return mime;
}

export async function sendVoiceMessage(
  client: MatrixClient, roomId: string, recording: VoiceRecording, replyEventId?: string,
  progress?: (status: string) => void, attempt: VoiceSendAttempt = {},
): Promise<void> {
  progress?.("Preparing audio");
  const mime = await validateVoiceRecording(recording);
  const size = recording.blob.size;
  if (!attempt.contentUri) {
    const file = new File([recording.blob], `voice-message.${VOICE_EXTENSIONS[mime]}`, { type: mime });
    progress?.("Uploading: 0%");
    const uploaded = await client.uploadContent(file, {
      type: mime,
      progressHandler: ({ loaded, total }) => progress?.(`Uploading: ${Math.min(100, Math.round(100 * loaded / (total || size)))}%`),
    });
    attempt.contentUri = uploaded.content_uri;
  }
  progress?.("Sending message");
  // A stable transaction id lets Synapse de-duplicate a retry whose first response was lost.
  attempt.txnId ??= `lumachat-voice-${globalThis.crypto.randomUUID()}`;
  await client.sendMessage(roomId, {
    msgtype: MsgType.Audio,
    body: "Voice message",
    url: attempt.contentUri,
    info: { mimetype: mime, size, duration: Math.round(recording.durationMs) },
    ...(replyEventId ? { "m.relates_to": { "m.in_reply_to": { event_id: replyEventId } } } : {}),
  }, attempt.txnId);
  progress?.("Sent");
}
