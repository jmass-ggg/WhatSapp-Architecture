import { useMatrixContext } from "../context/MatrixContext";

export function useMatrixClient() {
  const {
    client,
    session,
    status,
    initialSyncComplete,
    error,
    authenticationError,
  } = useMatrixContext();

  return {
    client,
    session,
    status,
    initialSyncComplete,
    error,
    authenticationError,
  };
}
