import { MATRIX_BASE_URL } from "./client";

export class MatrixMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixMediaError";
  }
}

export async function fetchMatrixMedia(
  token: string,
  mediaUri: string,
  maxBytes?: number,
): Promise<Blob> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mediaUri);
  if (!match) throw new MatrixMediaError("The Matrix media address is invalid.");

  const [, serverName, mediaId] = match;
  let response: Response;
  try {
    response = await fetch(
      `${MATRIX_BASE_URL}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    throw new MatrixMediaError("Synapse could not load this attachment.");
  }

  if (!response.ok) {
    throw new MatrixMediaError(
      `Synapse could not load this attachment (status ${response.status}).`,
    );
  }
  if (maxBytes && Number(response.headers.get("content-length")) > maxBytes) throw new MatrixMediaError("Attachment exceeds the download limit.");
  const blob = await response.blob();
  if (maxBytes && blob.size > maxBytes) throw new MatrixMediaError("Attachment exceeds the download limit.");
  return blob;
}
