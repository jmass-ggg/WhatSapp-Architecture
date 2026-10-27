const DEFAULT_API_URL = "http://localhost:8000/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (typeof item === "object" && item !== null && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return String(item);
        })
        .join(". ");
    }
  }
  return fallback;
}

export class ApiClient {
  readonly baseUrl: string;
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private onTokenChange: ((token: string | null) => void) | null = null;
  private onSessionExpired: (() => void) | null = null;

  constructor(baseUrl = import.meta.env.VITE_API_URL || DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
    this.onTokenChange?.(token);
  }

  setCallbacks(callbacks: {
    onTokenChange: (token: string | null) => void;
    onSessionExpired: () => void;
  }): void {
    this.onTokenChange = callbacks.onTokenChange;
    this.onSessionExpired = callbacks.onSessionExpired;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.fetchAndRead<T>(path, init, true);
  }

  private async fetchAndRead<T>(
    path: string,
    init: RequestInit,
    allowRefresh: boolean,
  ): Promise<T> {
    const response = await this.fetch(path, init, allowRefresh);
    return this.readResponse<T>(response);
  }

  private async fetch(
    path: string,
    init: RequestInit,
    allowRefresh: boolean,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });

    if (
      allowRefresh &&
      response.status === 401 &&
      this.accessToken &&
      path !== "/auth/refresh"
    ) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) return this.fetch(path, init, false);
      this.setAccessToken(null);
      this.onSessionExpired?.();
    }
    return response;
  }

  private async readResponse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    if (!response.ok) {
      throw new ApiError(
        apiMessage(payload, `Request failed with status ${response.status}`),
        response.status,
      );
    }
    return payload as T;
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const response = await fetch(`${this.baseUrl}/auth/refresh`, {
            method: "POST",
            credentials: "include",
          });
          if (!response.ok) return false;
          const payload = (await response.json()) as { access_token?: unknown };
          if (typeof payload.access_token !== "string") return false;
          this.setAccessToken(payload.access_token);
          return true;
        } catch {
          return false;
        } finally {
          this.refreshPromise = null;
        }
      })();
    }
    return this.refreshPromise;
  }
}
