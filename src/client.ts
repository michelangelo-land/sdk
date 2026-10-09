import { AuthManager } from "./auth.js";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { MichelangeloApiError } from "./errors.js";
import { defaultFetch } from "./http.js";
import type { PkceCrypto } from "./pkce.js";
import type {
  AttachmentsManifest,
  AvatarUploadResponse,
  BillingCheckout,
  BlockResponse,
  CreateBillingCheckoutRequest,
  CreateBlockRequest,
  CreateJobRequest,
  CreateProjectRequest,
  CreateReportRequest,
  ExchangeGithubTokenRequest,
  ExchangeGithubTokenResponse,
  GenerateIconResponse,
  GetUsageContributionsOptions,
  GetUsageInsightsOptions,
  GetUsageSummaryOptions,
  GithubInstallation,
  GithubInstallationsPage,
  GithubRepositoriesPage,
  GithubRepository,
  HealthResponse,
  Job,
  JobStatus,
  LinkGithubRepositoryRequest,
  LinkSupabaseProjectRequest,
  LinkSupabaseProjectResponse,
  ListAllProjectsOptions,
  ListExploreProjectsOptions,
  ListNotificationsOptions,
  ListProjectFilesOptions,
  ListProjectsOptions,
  ListTransactionsOptions,
  MarkAllNotificationsReadRequest,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadRequest,
  Me,
  MeField,
  Notification,
  NotificationsPage,
  PreviewErrorsPage,
  ListPreviewErrorsOptions,
  Project,
  ProjectFilesPage,
  ProjectPage,
  PublicProfile,
  RegisterPushTokenRequest,
  RegisterPushTokenResponse,
  RemovePushTokenRequest,
  ReportResponse,
  ReshareRequest,
  ReshareResponse,
  SaveFilesRequest,
  SaveGithubInstallationRequest,
  StartSupabaseOAuthRequest,
  StartSupabaseOAuthResponse,
  SupabaseConnection,
  SupabaseProjectLink,
  SupabaseProjectsResponse,
  UnreadCountResponse,
  UpdateMeRequest,
  UpdateProjectRequest,
  UsageContributionsPage,
  UsageInsights,
  UsageSummary,
  Wallet,
  WalletTransactionsPage,
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
  /** Multipart payload — when set, `body` is ignored and no JSON Content-Type is sent. */
  formData?: FormData;
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
    const isForm = options.formData !== undefined;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(!isForm && options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.authenticated === false ? {} : this.auth.authHeader()),
      ...(options.headers ?? {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: isForm
          ? (options.formData as FormData)
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
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
   * `PATCH /me` — update username / avatar_url. Duplicate username →
   * 409 `username_taken`.
   */
  updateMe(input: UpdateMeRequest): Promise<Me> {
    return this.request<Me>("/me", { method: "PATCH", body: input });
  }

  /**
   * `DELETE /me` — delete account and data (proxies the delete-account edge).
   * Resolves void on HTTP 204.
   */
  async deleteMe(): Promise<void> {
    await this.request<void>("/me", { method: "DELETE" });
  }

  /**
   * `POST /me/avatar` — upload an avatar file (multipart `file`, png/jpeg/webp
   * max 5MB) → public URL. Pass a ready-made `FormData` (required on React
   * Native, where the file is `{ uri, name, type }`) or a `Blob`/`File`.
   */
  uploadMyAvatar(file: FormData | Blob): Promise<AvatarUploadResponse> {
    return this.request<AvatarUploadResponse>("/me/avatar", {
      method: "POST",
      formData: toAvatarFormData(file),
    });
  }

  /**
   * `GET /users/{userId}` — public profile by id (`id, username, avatar_url,
   * is_supporter, created_at, updated_at`). Any authenticated caller can read
   * any profile (explore feed / preview / user screens). Pairs with the
   * `author` embed on `Project`.
   */
  getPublicProfile(userId: string): Promise<PublicProfile> {
    return this.request<PublicProfile>(`/users/${encodeURIComponent(userId)}`);
  }

  /**
   * `POST /jobs` — creates the row (`status: queued`) and returns it
   * immediately (HTTP 202; 200 on idempotent replay). Poll `getJob` /
   * `waitForJob` for progress. `type: "prompt"` for generations,
   * `type: "github-push"` to push a linked project to GitHub.
   * 402 `insufficient_credits` when the overdraft floor is reached — top up
   * via `createBillingCheckout`. Small overdraft is allowed: a user with
   * 1 cent still runs and goes negative, the next top-up absorbs the red.
   */
  createJob(input: CreateJobRequest): Promise<Job> {
    return this.request<Job>("/jobs", { method: "POST", body: input });
  }

  /**
   * `POST /jobs/attachments` — upload up to 3 prompt images (multipart,
   * png/jpeg/webp max 5MB each) → manifest to pass as `attachments` in
   * `POST /jobs` (`type=prompt`). Pass a ready-made `FormData` (required on
   * React Native) or `{ files, filenames?, idempotencyKey }`.
   */
  uploadJobAttachments(
    input: FormData | { files: Blob[]; filenames?: string[]; idempotencyKey?: string },
  ): Promise<AttachmentsManifest> {
    return this.request<AttachmentsManifest>("/jobs/attachments", {
      method: "POST",
      formData: toAttachmentsFormData(input),
    });
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

  /** `POST /projects` — create a project (HTTP 201). */
  createProject(input: CreateProjectRequest): Promise<Project> {
    return this.request<Project>("/projects", { method: "POST", body: input });
  }

  /** `GET /projects/{projectId}` — a single project (RLS applies). */
  getProject(projectId: number): Promise<Project> {
    return this.request<Project>(`/projects/${encodeURIComponent(String(projectId))}`);
  }

  /** `PATCH /projects/{projectId}` — rename / share / set icon (owner only). */
  updateProject(projectId: number, input: UpdateProjectRequest): Promise<Project> {
    return this.request<Project>(`/projects/${encodeURIComponent(String(projectId))}`, {
      method: "PATCH",
      body: input,
    });
  }

  /**
   * `DELETE /projects/{projectId}` — delete a project. Resolves void on
   * HTTP 204.
   */
  async deleteProject(projectId: number): Promise<void> {
    await this.request<void>(`/projects/${encodeURIComponent(String(projectId))}`, {
      method: "DELETE",
    });
  }

  /**
   * `GET /projects/{projectId}/files` — files of a project. Pass
   * `{ type: "CODE" }` for the same view as `use-project-files.ts`.
   */
  listProjectFiles(projectId: number, options: ListProjectFilesOptions = {}): Promise<ProjectFilesPage> {
    const query = options.type !== undefined ? `?type=${encodeURIComponent(options.type)}` : "";
    return this.request<ProjectFilesPage>(
      `/projects/${encodeURIComponent(String(projectId))}/files${query}`,
    );
  }

  /** `PUT /projects/{projectId}/files` — save files (per-file upsert). */
  saveProjectFiles(projectId: number, input: SaveFilesRequest): Promise<ProjectFilesPage> {
    return this.request<ProjectFilesPage>(
      `/projects/${encodeURIComponent(String(projectId))}/files`,
      { method: "PUT", body: input },
    );
  }

  /**
   * `POST /projects/{projectId}/icon` — generate + assign icon (proxies the
   * generate-project-icon edge).
   */
  generateProjectIcon(projectId: number): Promise<GenerateIconResponse> {
    return this.request<GenerateIconResponse>(
      `/projects/${encodeURIComponent(String(projectId))}/icon`,
      { method: "POST", body: {} },
    );
  }

  /**
   * `POST /projects/{projectId}/reshare` — republish / share. Duplicate
   * (same project+user+platform) → 200 with `deduped:true`.
   */
  reshareProject(projectId: number, input: ReshareRequest): Promise<ReshareResponse> {
    return this.request<ReshareResponse>(
      `/projects/${encodeURIComponent(String(projectId))}/reshare`,
      { method: "POST", body: input },
    );
  }

  /**
   * `GET /projects/{projectId}/preview-errors` — preview errors (max 10,
   * oldest first). Pass `{ consume: true }` to also delete the returned rows.
   */
  listPreviewErrors(
    projectId: number,
    options: ListPreviewErrorsOptions = {},
  ): Promise<PreviewErrorsPage> {
    const query = options.consume === true ? "?consume=true" : "";
    return this.request<PreviewErrorsPage>(
      `/projects/${encodeURIComponent(String(projectId))}/preview-errors${query}`,
    );
  }

  /**
   * `GET /projects/{projectId}/supabase-link` — Supabase link of one project
   * (safe columns only, never `anon_key`). 404 when no link exists.
   */
  getProjectSupabaseLink(projectId: number): Promise<SupabaseProjectLink> {
    return this.request<SupabaseProjectLink>(
      `/projects/${encodeURIComponent(String(projectId))}/supabase-link`,
    );
  }

  /**
   * `GET /explore/projects` — community discover feed (`shared=true` ordered
   * by `updated_at` desc). Optional `q` runs full-text search via RPC
   * `match_project`.
   */
  listExploreProjects(options: ListExploreProjectsOptions = {}): Promise<ProjectPage> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 20));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    if (options.q !== undefined) params.set("q", options.q);
    return this.request<ProjectPage>(`/explore/projects?${params.toString()}`);
  }

  /**
   * Fetch every explore page (`next_cursor` chaining) into one array.
   * Stops after `maxPages` (default 50) to guard against a stuck cursor.
   */
  async listAllExploreProjects(
    options: ListExploreProjectsOptions & { maxPages?: number } = {},
  ): Promise<Project[]> {
    const limit = options.limit ?? 100;
    const maxPages = options.maxPages ?? 50;
    const all: Project[] = [];
    let cursor: string | undefined = options.cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listExploreProjects({
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(options.q !== undefined ? { q: options.q } : {}),
      });
      all.push(...res.data);
      if (!res.next_cursor) return all;
      cursor = res.next_cursor;
    }
    throw new MichelangeloApiError({
      status: 0,
      code: "too_many_pages",
      message: `listAllExploreProjects stopped after ${maxPages} pages`,
    });
  }

  /** `POST /reports` — report content (at least one target required). */
  createReport(input: CreateReportRequest): Promise<ReportResponse> {
    return this.request<ReportResponse>("/reports", { method: "POST", body: input });
  }

  /**
   * `POST /blocks` — block a user. Duplicate → 200 `deduped:true`;
   * blocking yourself → 400.
   */
  blockUser(input: CreateBlockRequest): Promise<BlockResponse> {
    return this.request<BlockResponse>("/blocks", { method: "POST", body: input });
  }

  /**
   * `POST /github/token` — trade an OAuth `code` for a GitHub user token.
   * The client secret never leaves the server (edge-proxied).
   */
  exchangeGithubToken(input: ExchangeGithubTokenRequest): Promise<ExchangeGithubTokenResponse> {
    return this.request<ExchangeGithubTokenResponse>("/github/token", {
      method: "POST",
      body: input,
    });
  }

  /** `GET /github/installations` — GitHub App installations (safe columns only). */
  listGithubInstallations(): Promise<GithubInstallationsPage> {
    return this.request<GithubInstallationsPage>("/github/installations");
  }

  /** `POST /github/installations` — store installation after OAuth (upsert on `id`). */
  saveGithubInstallation(input: SaveGithubInstallationRequest): Promise<GithubInstallation> {
    return this.request<GithubInstallation>("/github/installations", {
      method: "POST",
      body: input,
    });
  }

  /** `GET /github/repositories` — repos linked by the user. */
  listGithubRepositories(): Promise<GithubRepositoriesPage> {
    return this.request<GithubRepositoriesPage>("/github/repositories");
  }

  /** `POST /github/repositories` — save the selected repo (upsert). */
  linkGithubRepository(input: LinkGithubRepositoryRequest): Promise<GithubRepository> {
    return this.request<GithubRepository>("/github/repositories", { method: "POST", body: input });
  }

  /**
   * `DELETE /github/repositories?project_id=` — unlink repo from a project.
   * Idempotent; resolves void on HTTP 204.
   */
  async unlinkGithubRepository(projectId: number): Promise<void> {
    const query = new URLSearchParams({ project_id: String(projectId) }).toString();
    await this.request<void>(`/github/repositories?${query}`, { method: "DELETE" });
  }

  /**
   * `POST /integrations/supabase/login` — start Supabase-account OAuth.
   * Open `authorize_url` via `openAuthSessionAsync`; the edge deep-links back
   * to `michelangelo://supabase-connected` (tokens stay server-side).
   */
  startSupabaseOAuth(input: StartSupabaseOAuthRequest): Promise<StartSupabaseOAuthResponse> {
    return this.request<StartSupabaseOAuthResponse>("/integrations/supabase/login", {
      method: "POST",
      body: input,
    });
  }

  /**
   * `GET /integrations/supabase/projects` — user's Supabase projects
   * (edge-proxied). 404 `not_connected` when the account is not linked.
   */
  listSupabaseProjects(): Promise<SupabaseProjectsResponse> {
    return this.request<SupabaseProjectsResponse>("/integrations/supabase/projects");
  }

  /** `POST /integrations/supabase/links` — link app ↔ Supabase ref. */
  linkSupabaseProject(input: LinkSupabaseProjectRequest): Promise<LinkSupabaseProjectResponse> {
    return this.request<LinkSupabaseProjectResponse>("/integrations/supabase/links", {
      method: "POST",
      body: input,
    });
  }

  /**
   * `DELETE /integrations/supabase/links?project_id=` — unlink app ↔ Supabase ref.
   * Idempotent; resolves void on HTTP 204.
   */
  async unlinkSupabaseProject(projectId: number): Promise<void> {
    const query = new URLSearchParams({ project_id: String(projectId) }).toString();
    await this.request<void>(`/integrations/supabase/links?${query}`, { method: "DELETE" });
  }

  /** `GET /integrations/supabase/connection` — connection state (safe columns). */
  getSupabaseConnection(): Promise<SupabaseConnection> {
    return this.request<SupabaseConnection>("/integrations/supabase/connection");
  }

  /**
   * `GET /wallets/me` — balance + bonus in EUR-cent credits
   * (1 credit = 1 EUR-cent). Expired bonus is reported as 0.
   * Render `display_balance` / `display_total` verbatim (preformatted
   * server-side, it-IT EUR) — never compute `balance / 100` yourself.
   */
  getMyWallet(): Promise<Wallet> {
    return this.request<Wallet>("/wallets/me");
  }

  /**
   * `GET /wallets/me/transactions` — top-up/spend history (cursor over created_at).
   * Every `spend` row carries `metadata` with `run_id`, `model`, `provider`,
   * `cost_eur` and preformatted `display_cost` — render `display_cost` verbatim.
   */
  listMyTransactions(options: ListTransactionsOptions = {}): Promise<WalletTransactionsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 20));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.request<WalletTransactionsPage>(`/wallets/me/transactions?${params.toString()}`);
  }

  /**
   * Fetch every transaction page (`next_cursor` chaining) into one array.
   * Stops after `maxPages` (default 50) to guard against a stuck cursor.
   */
  async listAllMyTransactions(
    options: ListTransactionsOptions & { maxPages?: number } = {},
  ): Promise<WalletTransactionsPage["data"]> {
    const limit = options.limit ?? 100;
    const maxPages = options.maxPages ?? 50;
    const all: WalletTransactionsPage["data"] = [];
    let cursor: string | undefined = options.cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listMyTransactions({
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      all.push(...res.data);
      if (!res.next_cursor) return all;
      cursor = res.next_cursor;
    }
    throw new MichelangeloApiError({
      status: 0,
      code: "too_many_pages",
      message: `listAllMyTransactions stopped after ${maxPages} pages`,
    });
  }

  /** `GET /usage/summary` — consumption summary (`month` + `all` mirror `context/usage.tsx`). */
  getUsageSummary(options: GetUsageSummaryOptions = {}): Promise<UsageSummary> {
    const params = new URLSearchParams();
    params.set("period", options.period ?? "month");
    if (options.year !== undefined) params.set("year", String(options.year));
    if (options.month !== undefined) params.set("month", String(options.month));
    return this.request<UsageSummary>(`/usage/summary?${params.toString()}`);
  }

  /** `GET /usage/contributions` — daily run/token counts. */
  getUsageContributions(
    options: GetUsageContributionsOptions = {},
  ): Promise<UsageContributionsPage> {
    const params = new URLSearchParams();
    if (options.start_date !== undefined) params.set("start_date", options.start_date);
    if (options.end_date !== undefined) params.set("end_date", options.end_date);
    const query = params.toString();
    return this.request<UsageContributionsPage>(`/usage/contributions${query ? `?${query}` : ""}`);
  }

  /** `GET /usage/insights` — streaks, totals, peak hour. */
  getUsageInsights(options: GetUsageInsightsOptions = {}): Promise<UsageInsights> {
    const query = `?timezone=${encodeURIComponent(options.timezone ?? "UTC")}`;
    return this.request<UsageInsights>(`/usage/insights${query}`);
  }

  /** `GET /notifications` — notifications, newest first (cursor over created_at). */
  listNotifications(options: ListNotificationsOptions = {}): Promise<NotificationsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 20));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.request<NotificationsPage>(`/notifications?${params.toString()}`);
  }

  /** `GET /notifications/unread-count` — badge count. */
  getUnreadCount(): Promise<UnreadCountResponse> {
    return this.request<UnreadCountResponse>("/notifications/unread-count");
  }

  /** `PATCH /notifications/{notificationId}` — mark read (`{ is_read: true }`). */
  markNotificationRead(
    notificationId: string,
    input: MarkNotificationReadRequest = { is_read: true },
  ): Promise<Notification> {
    return this.request<Notification>(`/notifications/${encodeURIComponent(notificationId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  /** `PATCH /notifications` — bulk mark-all-as-read (`{ is_read: true }`). */
  markAllNotificationsRead(
    input: MarkAllNotificationsReadRequest = { is_read: true },
  ): Promise<MarkAllNotificationsReadResponse> {
    return this.request<MarkAllNotificationsReadResponse>("/notifications", {
      method: "PATCH",
      body: input,
    });
  }

  /** `POST /push-tokens` — register an Expo token (upsert on conflict `token`). */
  registerPushToken(input: RegisterPushTokenRequest): Promise<RegisterPushTokenResponse> {
    return this.request<RegisterPushTokenResponse>("/push-tokens", { method: "POST", body: input });
  }

  /**
   * `DELETE /push-tokens` — remove a token (body `{ token }`, mirrors the
   * logout path). Resolves void on HTTP 204.
   */
  async removePushToken(input: RemovePushTokenRequest | string): Promise<void> {
    const body: RemovePushTokenRequest = typeof input === "string" ? { token: input } : input;
    await this.request<void>("/push-tokens", { method: "DELETE", body });
  }

  /**
   * `POST /billing/checkouts` — Stripe Checkout Session for wallet top-up
   * (HTTP 201, 1 EUR = 100 credits, 1 credit = 1 EUR-cent). Open `checkout_url`
   * in a browser/webview; crediting happens via the Stripe webhook once paid.
   */
  createBillingCheckout(input: CreateBillingCheckoutRequest): Promise<BillingCheckout> {
    return this.request<BillingCheckout>("/billing/checkouts", { method: "POST", body: input });
  }
}

function toAvatarFormData(file: FormData | Blob): FormData {
  if (file instanceof FormData) return file;
  const form = new FormData();
  appendFile(form, "file", file as Blob);
  return form;
}

function toAttachmentsFormData(
  input: FormData | { files: Blob[]; filenames?: string[]; idempotencyKey?: string },
): FormData {
  if (input instanceof FormData) return input;
  const { files, filenames, idempotencyKey } = input;
  const form = new FormData();
  if (idempotencyKey !== undefined) form.append("idempotency_key", idempotencyKey);
  files.forEach((file: Blob, i: number) => appendFile(form, "files", file, filenames?.[i]));
  return form;
}

function appendFile(form: FormData, field: string, file: Blob, filename?: string): void {
  // React Native's FormData takes `{ uri, name, type }` objects, which are
  // not `Blob`s — callers on RN must pass a prebuilt FormData instead.
  if (filename !== undefined) form.append(field, file, filename);
  else form.append(field, file);
}

function httpCodeToErrorCode(status: number): string {
  if (status === 401) return "invalid_token";
  if (status === 402) return "insufficient_credits";
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
