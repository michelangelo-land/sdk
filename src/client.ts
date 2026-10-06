import { AuthManager } from "./auth.js";
import type { PkceCrypto } from "./pkce.js";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { MichelangeloApiError } from "./errors.js";
import type { ApiErrorBody, HealthResponse, Whoami } from "./types.js";

export interface MichelangeloClientOptions {
  /** Defaults to https://api.michelangelo.land/v1 (swagger `servers[0]`). */
  baseUrl?: string;
  authBaseUrl?: string;
  /** Reuse a pre-registered OAuth client id; otherwise the client starts anonymous. */
  clientId?: string;
  fetchFn?: typeof fetch;
  /** PKCE backend forwarded to `auth` — inject the expo-crypto adapter on Hermes. */
  pkceCrypto?: PkceCrypto;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for the public endpoints (`GET /health`). Default true. */
  authenticated?: boolean;
}

/**
 * Typed client over the swagger contract. Born **anonymous**: public routes
 * work immediately, protected routes throw a 401-shaped `MichelangeloApiError`
 * until `auth` holds a session (see `AuthManager`).
 *
 * Every request injects `Authorization: Bearer <token>` from memory when
 * a session exists — no per-call token plumbing.
 */
export class MichelangeloClient {
  readonly auth: AuthManager;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: MichelangeloClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.auth = new AuthManager({
      authBaseUrl: options.authBaseUrl,
      clientId: options.clientId,
      fetchFn: this.fetchFn,
      pkceCrypto: options.pkceCrypto,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Low-level typed request against `{baseUrl}{path}`. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.authenticated === false ? {} : this.auth.authHeader()),
      ...(options.headers ?? {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (options.body !== undefined && !headers["Content-Type"]) {
        // `headers` is a plain object here, but keep the JSON default explicit.
      }
    } catch (err) {
      throw new MichelangeloApiError({
        status: 0,
        code: "network_error",
        message: `request failed: ${(err as Error).message}`,
      });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T & Partial<ApiErrorBody>) : (undefined as T);
    if (!res.ok) {
      const body = (data ?? {}) as Partial<ApiErrorBody>;
      throw new MichelangeloApiError({
        status: res.status,
        code: typeof body.code === "string" ? body.code : httpCodeToErrorCode(res.status),
        message:
          typeof body.message === "string" ? body.message : `HTTP ${res.status} ${path}`,
        details: typeof body.details === "object" ? body.details : undefined,
      });
    }
    return data as T;
  }

  // --- swagger-mapped methods --------------------------------------------------

  /** `GET /health` — liveness, no auth (`security: []`). Works while anonymous. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health", { authenticated: false });
  }

  /**
   * `GET /whoami` — identity behind the current token.
   * The cheapest way to check a login worked (200 = token valid).
   */
  whoami(): Promise<Whoami> {
    return this.request<Whoami>("/whoami");
  }
}

function httpCodeToErrorCode(status: number): string {
  if (status === 401) return "invalid_token";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "http_error";
}
