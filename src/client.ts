import { AuthManager } from "./auth.js";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { MichelangeloApiError } from "./errors.js";
import { defaultFetch } from "./http.js";
import type { PkceCrypto } from "./pkce.js";
import type {
  BillingCheckout,
  CreateBillingCheckoutRequest,
  CreateJobRequest,
  HealthResponse,
  Job,
  JobStatus,
  ListAllProjectsOptions,
  ListProjectsOptions,
  Me,
  MeField,
  Project,
  ProjectPage,
  WaitForJobOptions,
  Whoami,
} from "./types.js";

export interface MichelangeloClientOptions {
  /** Defaults to https://api.michelangelo.land/v1 (swagger `servers[0]`). */
  baseUrl?: string;
  authBaseUrl?: string;
  /** Reuse a pre-registered OAuth client id; otherwise the client starts anonymous. */
  clientId?: string;
  fetchFn?: typeof fetch;
  /** PKCE backend forwarded to `auth` — inject the expo-crypto adapter on Hermes. */
  pkceCrypto?: PkceCrypto;
  /**
   * Refresh the access token and retry once when a call fails with 401
   * (default true). Requires a refresh token in memory; on refresh failure
   * the session is dropped (back to anonymous) and the 401 surfaces.
   */
  autoRefresh?: boolean;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for the public endpoints (`GET /health`). Default true. */
  authenticated?: boolean;
}

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

/**
 * Typed client over the swagger contract. Born **anonymous**: public routes
 * work immediately, protected routes throw a 401-shaped `MichelangeloApiError`
 * until `auth` holds a session (see `AuthManager`).
 *
 * Every request injects `Authorization: Bearer <token>` from memory when
 * a session exists — no per-call token plumbing. On 401 the client refreshes
 * the token and retries once (disable with `autoRefresh: false`).
 */
export class MichelangeloClient {
  readonly auth: AuthManager;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly autoRefresh: boolean;

  constructor(options: MichelangeloClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.autoRefresh = options.autoRefresh ?? true;
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
    try {
      return await this.doRequest<T>(path, options);
    } catch (err) {
      if (
        this.autoRefresh &&
        options.authenticated !== false &&
        err instanceof MichelangeloApiError &&
        err.isUnauthorized() &&
        this.auth.getSession()?.refreshToken
      ) {
        try {
          await this.auth.refresh();
        } catch {
          // Refresh token dead too — drop to anonymous and surface the 401.
          this.auth.logout();
          throw err;
        }
        return this.doRequest<T>(path, options);
      }
      throw err;
    }
  }

  private async doRequest<T>(path: string, options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
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
    } catch (err) {
      throw new MichelangeloApiError({
        status: 0,
        code: "network_error",
        message: `request failed: ${(err as Error).message}`,
      });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      throw new MichelangeloApiError({
        status: res.status,
        code: httpCodeToErrorCode(res.status),
        message: `HTTP ${res.status} ${path} (non-JSON body)`,
      });
    }
    if (!res.ok) {
      const body = (data ?? {}) as Partial<{
        code: unknown;
        message: unknown;
        details: unknown;
      }>;
      throw new MichelangeloApiError({
        status: res.status,
        code: typeof body.code === "string" ? body.code : httpCodeToErrorCode(res.status),
        message: typeof body.message === "string" ? body.message : `HTTP ${res.status} ${path}`,
        details:
          typeof body.details === "object" && body.details !== null
            ? (body.details as Record<string, unknown>)
            : undefined,
        retryAfter: parseRetryAfter(res.headers.get("Retry-After")),
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

  /**
   * `GET /me` — current user profile with sparse fieldsets. Pass `fields`
   * to fetch only what you need (`email` is free — straight from the JWT);
   * omit for the full profile. Unknown names → 400 `invalid_fields`.
   */
  me(fields?: MeField[] | string): Promise<Me> {
    const list = Array.isArray(fields) ? fields.join(",") : fields;
    const query = list !== undefined ? `?fields=${encodeURIComponent(list)}` : "";
    return this.request<Me>(`/me${query}`);
  }

  /**
   * `POST /jobs` — creates the row (`status: queued`) and returns it
   * immediately (HTTP 202). Poll `getJob` / `waitForJob` for progress.
   */
  createJob(input: CreateJobRequest): Promise<Job> {
    return this.request<Job>("/jobs", { method: "POST", body: input });
  }

  /** `GET /jobs/{jobId}` — job snapshot for polling. */
  getJob(jobId: string): Promise<Job> {
    return this.request<Job>(`/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * Poll `getJob` until a terminal status (`succeeded`/`failed`/`canceled`)
   * and return the final snapshot — the call never waits server-side.
   * Backoff doubles from `minDelayMs` (default 2s) to `maxDelayMs`
   * (default 30s), per the swagger polling note. Resolves on any terminal
   * status: check `job.status` (and `job.error`) yourself.
   */
  async waitForJob(jobId: string, options: WaitForJobOptions = {}): Promise<Job> {
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const minDelayMs = options.minDelayMs ?? 2000;
    const maxDelayMs = options.maxDelayMs ?? 30000;
    const deadline = Date.now() + timeoutMs;
    let delay = minDelayMs;
    for (;;) {
      const job = await this.getJob(jobId);
      options.onProgress?.(job);
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
      if (Date.now() + delay > deadline) {
        throw new MichelangeloApiError({
          status: 0,
          code: "job_timeout",
          message: `waitForJob timed out after ${timeoutMs}ms (last status: ${job.status})`,
        });
      }
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  /**
   * `GET /projects` — page of projects (`mine` by default, `all` for the
   * community view). `next_cursor` feeds the next call's `cursor`.
   */
  listProjects(options: ListProjectsOptions = {}): Promise<ProjectPage> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 20));
    params.set("visibility", options.visibility ?? "mine");
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.request<ProjectPage>(`/projects?${params.toString()}`);
  }

  /**
   * Fetch every page (`next_cursor` chaining) into one array.
   * Stops after `maxPages` (default 50) to guard against a stuck cursor.
   */
  async listAllProjects(options: ListAllProjectsOptions = {}): Promise<Project[]> {
    const limit = options.limit ?? 100;
    const maxPages = options.maxPages ?? 50;
    const all: Project[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listProjects({
        limit,
        visibility: options.visibility,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      all.push(...res.data);
      if (!res.next_cursor) return all;
      cursor = res.next_cursor;
    }
    throw new MichelangeloApiError({
      status: 0,
      code: "too_many_pages",
      message: `listAllProjects stopped after ${maxPages} pages`,
    });
  }

  /** `GET /projects/{projectId}` — a single project (RLS applies). */
  getProject(projectId: number): Promise<Project> {
    return this.request<Project>(`/projects/${encodeURIComponent(String(projectId))}`);
  }

  /**
   * `POST /billing/checkouts` — Stripe Checkout Session for wallet top-up
   * (HTTP 201, 1 EUR = 1 credit). Open `checkout_url` in a browser/webview;
   * crediting happens via the Stripe webhook once paid.
   */
  createBillingCheckout(input: CreateBillingCheckoutRequest): Promise<BillingCheckout> {
    return this.request<BillingCheckout>("/billing/checkouts", { method: "POST", body: input });
  }
}

function httpCodeToErrorCode(status: number): string {
  if (status === 401) return "invalid_token";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "http_error";
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new MichelangeloApiError({ status: 0, code: "job_aborted", message: "waitForJob aborted" }),
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new MichelangeloApiError({ status: 0, code: "job_aborted", message: "waitForJob aborted" }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
