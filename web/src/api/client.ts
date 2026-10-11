import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];
export type User = Schemas["User"];
export type Device = Schemas["Device"];
export type Heartbeat = Schemas["Heartbeat"];
export type Command = Schemas["Command"];
export type LogEntry = Schemas["LogEntry"];
export type Firmware = Schemas["Firmware"];
export type OtaJob = Schemas["OtaJob"];
export type OtaTask = Schemas["OtaTask"];
export type Enrollment = Schemas["Enrollment"];
export type NewEnrollment = Schemas["NewEnrollment"];

const TOKEN_KEY = "soulcloud.token";

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode: session lasts until reload */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

/** Fired when the server rejects the session; the auth context signs out. */
export const SESSION_EXPIRED = "soulcloud:session-expired";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toApiError(error: unknown, response: Response): ApiError {
  const body = (error ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
  return new ApiError(
    response.status,
    body.error?.code ?? "http_error",
    body.error?.message ?? `${response.status} ${response.statusText}`,
    body.error?.details,
  );
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = tokenStore.get();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ response, request }) {
    if (response.status === 401 && !new URL(request.url).pathname.startsWith("/v1/auth/")) {
      tokenStore.clear();
      window.dispatchEvent(new Event(SESSION_EXPIRED));
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: window.location.origin });
api.use(auth);

/** Resolves an openapi-fetch call to its data, throwing ApiError on failure. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw toApiError(error, response);
  return data as T;
}

/** fetch() with the session token, for multipart uploads, downloads and streams. */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    if (response.status === 401) {
      tokenStore.clear();
      window.dispatchEvent(new Event(SESSION_EXPIRED));
    }
    throw toApiError(body, response);
  }
  return response;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
