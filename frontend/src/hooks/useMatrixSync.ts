import { useMatrixContext } from "../context/MatrixContext";

export function useMatrixSync() {
  const {
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
  } = useMatrixContext();

  return {
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
  };
}
