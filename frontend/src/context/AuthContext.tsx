import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { ApiClient } from "../services/api/client";
import type {
  AuthMode,
  LoginResponse,
  MatrixSession,
  UserProfile,
} from "../types";
import { stopManagedMatrixSession } from "../services/matrix/session";

interface LoginInput {
  login: string;
  password: string;
}

interface RegisterInput {
  email: string;
  username: string;
  password: string;
  display_name: string;
}

interface AuthContextValue {
  user: UserProfile | null;
  mode: AuthMode | null;
  matrixSession: MatrixSession | null;
  api: ApiClient;
  isAuthenticated: boolean;
  signIn: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<UserProfile>;
  signOut: () => Promise<void>;
  enterDemo: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const demoUser: UserProfile = {
  id: "demo-user",
  email: "maya@example.test",
  username: "maya",
  is_active: true,
  is_email_verified: true,
  role: "user",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  profile: {
    user_id: "demo-user",
    display_name: "Maya Chen",
    profile_picture_url: null,
    bio: "Good conversations make the day brighter.",
    job_title: "Product designer",
    department: "Design",
  },
};

export function AuthProvider({ children }: PropsWithChildren) {
  const apiRef = useRef<ApiClient | null>(null);
  if (apiRef.current === null) apiRef.current = new ApiClient();
  const api = apiRef.current;

  const [user, setUser] = useState<UserProfile | null>(null);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [matrixSession, setMatrixSession] = useState<MatrixSession | null>(null);
  const matrixSessionRef = useRef<MatrixSession | null>(null);
  matrixSessionRef.current = matrixSession;

  api.setCallbacks({
    onTokenChange: () => undefined,
    onSessionExpired: () => {
      stopManagedMatrixSession(matrixSessionRef.current);
      matrixSessionRef.current = null;
      setUser(null);
      setMode(null);
      setMatrixSession(null);
    },
  });

  const signIn = useCallback(
    async ({ login, password }: LoginInput) => {
      stopManagedMatrixSession(matrixSessionRef.current);
      matrixSessionRef.current = null;
      api.setAccessToken(null);
      const session = await api.request<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password }),
      });
      api.setAccessToken(session.access_token);
      const profile = await api.request<UserProfile>("/users/me");
      setUser(profile);
      matrixSessionRef.current = session.matrix;
      setMatrixSession(session.matrix);
      setMode("live");
    },
    [api],
  );

  const register = useCallback(
    (input: RegisterInput) =>
      api.request<UserProfile>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    [api],
  );

  const signOut = useCallback(async () => {
    const currentMode = mode;
    const currentMatrixSession = matrixSession;
    stopManagedMatrixSession(currentMatrixSession);
    try {
      if (currentMode === "live") {
        await api.request<void>("/auth/logout", {
          method: "POST",
          body: JSON.stringify({
            matrix_access_token: currentMatrixSession?.access_token ?? null,
          }),
        });
      }
    } finally {
      api.setAccessToken(null);
      matrixSessionRef.current = null;
      setUser(null);
      setMatrixSession(null);
      setMode(null);
    }
  }, [api, matrixSession, mode]);

  const enterDemo = useCallback(() => {
    stopManagedMatrixSession(matrixSessionRef.current);
    matrixSessionRef.current = null;
    api.setAccessToken(null);
    setMatrixSession(null);
    setUser(demoUser);
    setMode("demo");
  }, [api]);

  const value: AuthContextValue = {
    user,
    mode,
    matrixSession,
    api,
    isAuthenticated: user !== null,
    signIn,
    register,
    signOut,
    enterDemo,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
