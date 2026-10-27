import type { DirectoryUser } from "../../types";
import { MATRIX_SERVER_NAME } from "./client";

export function matrixUserIdForAppUserId(userId: string): string {
  const localpart = `u_${userId.replaceAll("-", "").toLowerCase()}`;
  return `@${localpart}:${MATRIX_SERVER_NAME}`;
}

export function mappedMatrixUserId(user: DirectoryUser): string {
  return matrixUserIdForAppUserId(user.id);
}
