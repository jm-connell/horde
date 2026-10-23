import { connectivity } from "../offline/connectivity";

/** One entry of a 422 response's `fields`: where the problem is and what it is. */
export interface ApiErrorField {
  loc: (string | number)[];
  msg: string;
}

/**
 * Every error response has the same body (see backend/app/errors.py):
 * `{detail, code, fields?, extra?}`. `message` is `detail`; branch on `code`.
 */
export class ApiError extends Error {
  code?: string;
  status: number;
  fields?: ApiErrorField[];
  extra?: Record<string, unknown>;
  /** Response headers, for the few errors that carry data there (a partial bulk delete). */
  headers?: Headers;

  constructor(
    message: string,
    extra?: {
      code?: string;
      status?: number;
      fields?: ApiErrorField[];
      extra?: Record<string, unknown>;
      headers?: Headers;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.code = extra?.code;
    this.status = extra?.status ?? 0;
    this.fields = extra?.fields;
    this.extra = extra?.extra;
    this.headers = extra?.headers;
  }

  /** Stable failure kind of a link-reading error (`extra.error_kind`). */
  get errorKind(): string | undefined {
    const kind = this.extra?.error_kind;
    return typeof kind === "string" ? kind : undefined;
  }
}

/** Thrown without touching the network while the app is in offline mode. */
export function offlineError(): ApiError {
  return new ApiError("You're offline", { code: "offline", status: 0 });
}

export function isOfflineError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "offline";
}

/** fetch() rejected (no response at all), as opposed to an HTTP error. */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || isOfflineError(err);
}

/**
 * Every state-changing request must carry this header: the server refuses
 * mutations without it (app/security.py). A custom header forces a CORS
 * preflight, which no route grants, so other websites cannot send one.
 */
export const CSRF_HEADER = "X-Horde-Request";

/** Add the CSRF header to a non-GET request init. Safe methods pass through. */
export function withCsrf(init?: RequestInit): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return init;
  const headers = new Headers(init?.headers);
  headers.set(CSRF_HEADER, "1");
  return { ...init, headers };
}

/** Fired when the server says the session is gone (401). AuthProvider listens. */
export const AUTH_REQUIRED_EVENT = "horde:auth-required";
/** Fired on any 403; the detail is a user-facing sentence. */
export const PERMISSION_DENIED_EVENT = "horde:permission-denied";

function notifyAuthFailure(
  status: number,
  code: string | undefined,
  message: string
): void {
  if (status === 401 && code === "auth_required") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  } else if (status === 403) {
    // Every 403 envelope (permission_denied, admin_required, csrf_rejected, ...)
    // carries a user-facing `detail`; show it instead of failing silently.
    window.dispatchEvent(
      new CustomEvent(PERMISSION_DENIED_EVENT, {
        detail: message || "Not allowed",
      })
    );
  }
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Build the ApiError for a non-2xx response, notifying auth listeners. */
export async function apiErrorFrom(resp: Response): Promise<ApiError> {
  let message = resp.statusText;
  let code: string | undefined;
  let fields: ApiErrorField[] | undefined;
  let extra: Record<string, unknown> | undefined;
  try {
    const body = await resp.json();
    if (typeof body.detail === "string") message = body.detail;
    if (typeof body.code === "string") code = body.code;
    if (Array.isArray(body.fields)) fields = body.fields;
    if (typeof body.extra === "object" && body.extra !== null)
      extra = body.extra;
  } catch {
    // non-JSON error body; keep status text
  }
  notifyAuthFailure(resp.status, code, message);
  return new ApiError(message, {
    status: resp.status,
    code,
    fields,
    extra,
    headers: resp.headers,
  });
}

/** Send a request; a non-2xx reply throws its ApiError. */
export async function send(url: string, init?: RequestInit): Promise<Response> {
  // Offline mode: fail fast instead of hanging on a dead/slow connection.
  if (connectivity.offlineMode) throw offlineError();
  let resp: Response;
  const t0 = performance.now();
  try {
    resp = await fetch(url, withCsrf(init));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    connectivity.reportRequest(performance.now() - t0, true);
    throw err;
  }
  connectivity.reportRequest(performance.now() - t0, false);
  if (!resp.ok) throw await apiErrorFrom(resp);
  return resp;
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await send(url, init);
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** Options every read accepts so React Query can cancel it. */
export interface ReadOptions {
  signal?: AbortSignal;
}

/** Options for a server-sent-events chat turn. */
export interface ChatStreamOptions {
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
}

/** POST a JSON body and parse the `data:` lines of the SSE reply. */
export async function postEventStream(
  url: string,
  body: unknown,
  opts: ChatStreamOptions
): Promise<void> {
  const resp = await fetch(
    url,
    withCsrf({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  );
  if (!resp.ok) throw await apiErrorFrom(resp);
  if (!resp.body) {
    throw new Error("No response body");
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          opts.onEvent(JSON.parse(payload) as Record<string, unknown>);
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}

/** One page of a cursor-paginated list; `next_cursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  /** Present only when the request asked for `include_total`. */
  total?: number | null;
}

/** Rows asked for per request; the server caps it at 500. */
export const PAGE_SIZE = 500;

/**
 * Walk a cursor-paginated list to its end. `onPage` sees everything fetched so
 * far after each page that is not the last, so a screen can paint the first page
 * while the rest loads in the background.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  onPage?: (soFar: T[]) => void
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.next_cursor;
    if (cursor && onPage) onPage([...all]);
  } while (cursor);
  return all;
}
