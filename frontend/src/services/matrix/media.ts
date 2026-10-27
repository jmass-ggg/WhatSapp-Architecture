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
): Promise<Blob> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mediaUri);
  if (!match) throw new MatrixMediaError("The Matrix media address is invalid.");

  const [, serverName, mediaId] = match;
  let response: Response;
  try {
    response = await fetch(
      `${MATRIX_BASE_URL}/_matrix/media/v3/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`,
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
  return response.blob();
}
