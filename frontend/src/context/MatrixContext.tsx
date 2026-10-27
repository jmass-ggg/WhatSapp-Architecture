import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import type { MatrixClient } from "matrix-js-sdk";

import type { MatrixSession } from "../types";
import { useAuth } from "./AuthContext";
import { MatrixSessionError } from "../services/matrix/client";
import { matrixUserIdForAppUserId } from "../services/matrix/identity";
import {
  EMPTY_MATRIX_CONNECTION_SNAPSHOT,
  matrixClientRegistry,
  type MatrixClientLease,
  type MatrixConnectionSnapshot,
} from "../services/matrix/session";

export interface MatrixContextValue extends MatrixConnectionSnapshot {
  client: MatrixClient | null;
  session: MatrixSession | null;
}

const EMPTY_CONTEXT_VALUE: MatrixContextValue = {
  ...EMPTY_MATRIX_CONNECTION_SNAPSHOT,
  client: null,
  session: null,
};

const MatrixContext = createContext<MatrixContextValue | null>(null);

interface ActiveLease {
  session: MatrixSession;
  userId: string;
  lease: MatrixClientLease;
}

interface SessionFailure {
  session: MatrixSession;
  userId: string;
  message: string;
}

export function MatrixProvider({ children }: PropsWithChildren) {
  const { user, mode, matrixSession } = useAuth();
  const [activeLease, setActiveLease] = useState<ActiveLease | null>(null);
  const [sessionFailure, setSessionFailure] =
    useState<SessionFailure | null>(null);

  useEffect(() => {
    if (mode !== "live" || !user || !matrixSession) {
      setActiveLease(null);
      setSessionFailure(null);
      return;
    }

    let lease: MatrixClientLease;
    try {
      lease = matrixClientRegistry.acquire(
        matrixSession,
        matrixUserIdForAppUserId(user.id),
      );
      setSessionFailure(null);
      setActiveLease({
        session: matrixSession,
        userId: user.id,
        lease,
      });
    } catch (cause) {
      setActiveLease(null);
      setSessionFailure({
        session: matrixSession,
        userId: user.id,
        message:
          cause instanceof MatrixSessionError
            ? cause.message
            : "The Matrix session could not be initialized.",
      });
      return;
    }

    return () => {
      lease.release();
    };
  }, [matrixSession, mode, user]);

  const isCurrent =
    mode === "live" &&
    user !== null &&
    matrixSession !== null &&
    activeLease?.session === matrixSession &&
    activeLease.userId === user.id;
  const isFailedSession =
    mode === "live" &&
    user !== null &&
    matrixSession !== null &&
    sessionFailure?.session === matrixSession &&
    sessionFailure.userId === user.id;
  const manager = isCurrent ? activeLease.lease.manager : null;
  const subscribe = useMemo(
    () => manager?.subscribe ?? (() => () => undefined),
    [manager],
  );
  const getSnapshot = useMemo(
    () =>
      manager?.getSnapshot ?? (() => EMPTY_MATRIX_CONNECTION_SNAPSHOT),
    [manager],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_MATRIX_CONNECTION_SNAPSHOT,
  );

  const value = useMemo<MatrixContextValue>(
    () =>
      manager && isCurrent
        ? {
            ...snapshot,
            client: manager.client,
            session: matrixSession,
          }
        : isFailedSession
          ? {
              ...EMPTY_MATRIX_CONNECTION_SNAPSHOT,
              status: "error",
              error: sessionFailure.message,
              client: null,
              session: matrixSession,
            }
          : EMPTY_CONTEXT_VALUE,
    [isCurrent, isFailedSession, manager, matrixSession, sessionFailure, snapshot],
  );

  return (
    <MatrixContext.Provider value={value}>
      {children}
    </MatrixContext.Provider>
  );
}

export function useMatrixContext(): MatrixContextValue {
  const context = useContext(MatrixContext);
  if (!context) {
    throw new Error("useMatrixContext must be used within MatrixProvider");
  }
  return context;
}
