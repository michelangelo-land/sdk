/**
 * Types mirroring the swagger contract (`GET /v1/openapi.json`,
 * vendored at `openapi/openapi.json`).
 * Hand-written on purpose: the surface is small and this keeps runtime
 * dependencies at zero. `scripts/contract-check.mjs` guarantees these stay in
 * sync with the live document.
 * Not covered on purpose: `getOpenApiDocument`/`getDocs` (meta endpoints),
 * `handleBillingWebhook` (Stripe-signed server hook) and
 * `handleGithubWebhook` (HMAC-signed server hook) — not client concerns.
 */

// --- GET /health → operationId `getHealth` (security: [], no auth) ---
export interface HealthResponse {
  ok: true;
}

// --- GET /whoami → operationId `getWhoami`, schema `#/components/schemas/Whoami` ---
export interface RateLimitSnapshot {
  limit?: number;
  remaining?: number;
  reset_at?: string;
}

export interface Whoami {
  user_id: string;
  client_id: string;
  scopes?: string[];
  rate_limit?: RateLimitSnapshot;
}

// --- jobs → `createJob`/`getJob`, schemas `CreatePromptJobRequest`/`CreateGithubPushJobRequest`/`Job` ---

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobTier = "light" | "full";

export interface JobInput {
  prompt: string;
  /** Vendor-neutral tier; server-enriched from prompt evaluation when absent. */
  model?: JobTier;
  /** Generated app name (first generation only, snake_case); server-enriched when absent. */
  app_name?: string | null;
  /**
   * Alias of `app_name` for runner compat (v9 enqueue shape, per swagger
   * `#/components/schemas/CreatePromptJobRequest`). Prefer `app_name`.
   */
  project_name?: string | null;
  /**
   * True when the server created the project in this request (first
   * generation with `project_id` omitted). Server-set — never send it.
   */
  is_first_generation?: boolean;
  /**
   * @deprecated Use `app_name` (snake_case, per swagger
   * `#/components/schemas/CreatePromptJobRequest`). Kept for backwards
   * compatibility — the server ignores unknown keys.
   */
  appName?: string | null;
}

export interface JobAttachmentRef {
  /** Storage path in the job-attachments bucket (from `uploadJobAttachments`). */
  path: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  kind?: string;
}

export interface CreatePromptJobRequest {
  type: "prompt";
  /** Numeric project id; omit for first generation. */
  project_id?: number;
  input: JobInput & Record<string, unknown>;
  /** Manifest entries from `POST /jobs/attachments`. */
  attachments?: JobAttachmentRef[];
  /** Linked Supabase ref for the runner (stored in `input.supabase_project_ref`). */
  supabase_project_ref?: string;
  /** Client-generated uuid; replay with the same key returns the existing job. */
  idempotency_key?: string;
}

/**
 * @deprecated `expo_push_token`, `live_activity_token` and `live_activity_user`
 * were removed from `POST /jobs` — push routing now uses the registered
 * token tables (`POST /push-tokens`, `POST /live-activity/tokens`).
 * Register once at launch instead of passing per job; the server ignores
 * these keys if still sent. Kept so existing call-sites still compile.
 */
export interface DeprecatedJobPushFields {
  /** @deprecated Removed from the API — use `registerPushToken()` instead. */
  expo_push_token?: string;
  /** @deprecated Removed from the API — use `registerLiveActivityToken()` instead. */
  live_activity_token?: string;
  /** @deprecated Removed from the API — use `registerLiveActivityToken()` instead. */
  live_activity_user?: string;
}

export interface CreateGithubPushJobRequest {
  /** Push the project to its linked GitHub repo via the github-actions edge. */
  type: "github-push";
  project_id: number;
  idempotency_key?: string;
}

/**
 * @deprecated The API no longer accepts `type: "github-push"` via `POST /jobs`
 * (the swagger `CreateGithubPushJobRequest` schema was removed — pushes are now
 * a synchronous `POST /projects/{projectId}/pushes`, see
 * `client.pushProjectToGithub`). Kept so existing imports still compile.
 */
export type DeprecatedGithubPushJobRequest = CreateGithubPushJobRequest;

/**
 * `POST /jobs` body — prompt-only since the `github-push` job variant was
 * removed from the swagger (use `POST /projects/{projectId}/pushes` instead).
 */
export type CreateJobRequest = CreatePromptJobRequest;

export interface AttachmentsManifest {
  idempotency_key: string;
  attachments: JobAttachmentRef[];
}

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  /** Numeric project id. Always set for `type: "prompt"` (auto-created on first generation); nullable only for legacy rows. */
  project_id?: number | null;
  result?: Record<string, unknown>;
  error?: ApiErrorBody;
  created_at: string;
  updated_at?: string;
}

export interface WaitForJobOptions {
  /** Give up after this long (default 10 min). */
  timeoutMs?: number;
  /** First poll delay (default 2000, per swagger "2s → 30s max"). */
  minDelayMs?: number;
  /** Poll delay cap (default 30000). Doubles every attempt in between. */
  maxDelayMs?: number;
  /** Abort polling early. */
  signal?: AbortSignal;
  /** Called with every snapshot, including the first. */
  onProgress?: (job: Job) => void;
}

// --- prompt suggestions → `listPromptSuggestions`, schema `PromptSuggestion` ---

export type PromptSuggestionLocale = "it" | "en";

export type PromptSuggestionMode = "create" | "edit";

export interface PromptSuggestion {
  /** Stable slug (e.g. expense-tracker-it). */
  id: string;
  /** Ready-to-send prompt (valid `type: "prompt"` input for `POST /jobs`). */
  prompt: string;
  /** Use case: `create` starts a new app (no `project_id`), `edit` modifies the current app. */
  mode: PromptSuggestionMode;
  locale: PromptSuggestionLocale;
  /** Single lowercase word (e.g. finance, health, travel). */
  category: string;
}

export interface PromptSuggestionsPage {
  data: PromptSuggestion[];
}

export interface ListPromptSuggestionsOptions {
  /** Page size (default 20, max 100). Small static list: plain limit, no cursor. */
  limit?: number;
  /** Filter by use case: `create` = new app ideas, `edit` = modify-current-app ideas. Omit for both. */
  mode?: PromptSuggestionMode;
  /** Filter by language (omit for both `it` + `en`). */
  locale?: PromptSuggestionLocale;
  /** Filter by category (e.g. finance, health, travel). */
  category?: string;
  /** Randomize server-side (dice button). Default false. */
  shuffle?: boolean;
}

// --- projects → `listProjects`/`createProject`/`getProject`/`updateProject`/`deleteProject`, schemas `Project`/`ProjectPage` ---

export type ProjectVisibility = "mine" | "all";

export interface Project {
  id: number;
  name: string;
  /** Owner id (needed by feed/user screens to fetch the author profile). */
  user_id?: string | null;
  /** Community visibility (preview/feed only show shared projects). */
  shared?: boolean;
  icon_url?: string;
  /** Embedded author profile (username, avatar_url) via `projects_user_id_fkey`. */
  author?: ProjectAuthor | null;
  created_at: string;
  updated_at?: string;
}

/** `author` embed on `Project` — `{ username, avatar_url }`. */
export interface ProjectAuthor {
  username?: string | null;
  avatar_url?: string | null;
}

export interface ProjectPage {
  data: Project[];
  next_cursor?: string | null;
}

export interface ListProjectsOptions {
  limit?: number;
  cursor?: string;
  /** `mine` (default): caller's own projects. `all`: plus public/shared. */
  visibility?: ProjectVisibility;
  /** Full-text query via RPC match_project (RLS still applies). */
  q?: string;
}

export interface ListAllProjectsOptions extends Omit<ListProjectsOptions, "cursor"> {
  /** Page size for the underlying calls (default 100). */
  limit?: number;
  /** Safety cap on pages fetched (default 50). */
  maxPages?: number;
}

export interface CreateProjectRequest {
  name: string;
  shared?: boolean;
}

export interface UpdateProjectRequest {
  name?: string;
  shared?: boolean;
}

export interface ProjectFile {
  path: string;
  contents: string;
  type?: string;
  updated_at?: string;
}

export interface ProjectFileInput {
  path: string;
  contents: string;
  type?: string;
}

export interface ProjectFilesPage {
  data: ProjectFile[];
}

export interface ListProjectFilesOptions {
  /** e.g. `CODE` — same view as `use-project-files.ts`. */
  type?: string;
}

export interface SaveFilesRequest {
  files: ProjectFileInput[];
}

export interface ReshareRequest {
  platform: string;
  share_metadata?: Record<string, unknown>;
}

/** `POST /projects/{id}/reshares` — recorded row (201). */
export interface ProjectReshare {
  project_id: number;
  reshared_by_user_id: string;
  platform: string;
  share_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Idempotent replay marker — duplicate insert returns 200 `{ deduped: true }`. */
export interface Deduped {
  deduped: true;
}

/**
 * `POST /projects/{id}/reshares` — recorded row (201) or `{ deduped: true }`
 * (200 on duplicate project+user+platform).
 */
export type ReshareResponse = ProjectReshare | Deduped;

/** `POST /projects/{id}/icon` — proxied generate-project-icon edge result. */
export interface ProjectIconResult {
  icon_url?: string;
  [key: string]: unknown;
}

/** `POST /projects/{id}/icon` — proxied generate-project-icon edge result. */
export type GenerateIconResponse = ProjectIconResult;

export interface PreviewError {
  id?: string;
  message?: string;
  stack?: string | null;
  created_at?: string;
}

export interface PreviewErrorsPage {
  data: PreviewError[];
}

export interface ListPreviewErrorsOptions {
  /**
   * @deprecated The `?consume=true` query was removed from
   * `GET /projects/{id}/preview-errors` (pure read now). Pass `consume: true`
   * to emulate the old behaviour: list, then `drainPreviewErrors()`, then
   * return the listed rows. Prefer calling `listPreviewErrors()` +
   * `drainPreviewErrors()` explicitly.
   */
  consume?: boolean;
}

/** `DELETE /projects/{id}/preview-errors` — drain result. */
export interface DrainPreviewErrorsResponse {
  deleted_count: number;
}

// --- community search now lives on `GET /projects?q=` (the standalone ---
// --- `GET /explore/projects` endpoint was removed from the swagger) ---

/**
 * @deprecated `GET /explore/projects` was removed from the API — search now
 * lives on `GET /projects` (`visibility: "all"` + `q`). Kept so existing
 * imports still compile; use `ListProjectsOptions` instead.
 */
export type ListExploreProjectsOptions = Pick<ListProjectsOptions, "limit" | "cursor" | "q">;

// --- moderation → `createReport`/`blockUser` ---

export interface CreateReportRequest {
  reported_project_id?: number;
  reported_user_id?: string;
  reason?: string;
}

/** `POST /reports` — recorded row (201). */
export interface Report {
  id?: string;
  reporter_id: string;
  reported_project_id?: number;
  reported_user_id?: string;
  reason?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** `POST /reports` — recorded row. */
export type ReportResponse = Report;

export interface CreateBlockRequest {
  blocked_id: string;
}

/** `POST /blocks` — blocked row (201). */
export interface Block {
  blocker_id: string;
  blocked_id: string;
  created_at?: string;
  [key: string]: unknown;
}

/**
 * `POST /blocks` — blocked row (201) or `{ deduped: true }`
 * (200 on duplicate).
 */
export type BlockResponse = Block | Deduped;

// --- github → installations / repositories / token exchange ---

export interface GithubInstallation {
  id?: number;
  login?: string | null;
  avatar?: string | null;
  name?: string | null;
}

export interface GithubInstallationsPage {
  data: GithubInstallation[];
}

/** `POST /github/installations` — store installation after OAuth (upsert on `id`). */
export interface SaveGithubInstallationRequest {
  /** GitHub App installation id (upserted on conflict `id`). */
  id: number;
  /** User OAuth token (write-only, stored server-side, never returned). */
  ghu: string;
  login?: string;
  avatar?: string | null;
  name?: string | null;
}

export interface GithubRepository {
  project_id?: number;
  github_installation_id?: number;
  github_repository_name?: string;
  github_last_sync?: string;
}

export interface GithubRepositoriesPage {
  data: GithubRepository[];
}

export interface LinkGithubRepositoryRequest {
  project_id: number;
  github_installation_id: number;
  /** Defaults to `michelangelo-{project_id}` (app convention) when omitted. */
  github_repository_name?: string;
}

export interface ExchangeGithubTokenRequest {
  code: string;
  redirect_uri?: string;
}

export interface ExchangeGithubTokenResponse {
  access_token: string;
}

/**
 * `POST /projects/{projectId}/pushes` — synchronous push of a GitHub-linked
 * project (Snack bundle → GitHub). Short integration action, not a queued job.
 */
export interface GithubPushResult {
  pushed: boolean;
  /** Commit SHA created on GitHub (null when nothing pushed). */
  commit_sha?: string | null;
  message?: string | null;
}

// --- integrations/supabase → OAuth login / projects / links / connection ---

export interface CreateSupabaseAuthorizationRequest {
  code_challenge: string;
  code_verifier?: string;
}

export interface CreateSupabaseAuthorizationResponse {
  authorize_url: string;
  return_url: string;
}

/**
 * @deprecated `POST /integrations/supabase/login` was renamed to
 * `POST /integrations/supabase/authorizations` in the swagger
 * (`createSupabaseAuthorization`). Kept so existing imports still compile.
 */
export type StartSupabaseOAuthRequest = CreateSupabaseAuthorizationRequest;

/**
 * @deprecated Alias of `CreateSupabaseAuthorizationResponse` (endpoint rename).
 */
export type StartSupabaseOAuthResponse = CreateSupabaseAuthorizationResponse;

/** `GET /integrations/supabase/projects` — edge-proxied projects + organizations. */
export interface SupabaseProjectsResult {
  projects: Record<string, unknown>[];
  organizations?: Record<string, unknown>[];
  [key: string]: unknown;
}

/** `GET /integrations/supabase/projects` — edge-proxied `{projects, organizations}`. */
export type SupabaseProjectsResponse = SupabaseProjectsResult;

export interface SupabaseProjectLink {
  project_id?: number;
  supabase_project_ref?: string;
  supabase_project_name?: string;
  api_url?: string;
}

export interface LinkSupabaseProjectRequest {
  project_id: number;
  supabase_ref: string;
}

/** `POST /integrations/supabase/links` — linked row + edge result. */
export interface SupabaseLinkResult {
  project_id: number;
  ref?: string;
  name?: string;
  [key: string]: unknown;
}

/** `POST /integrations/supabase/links` — proxied edge result (upserted link). */
export type LinkSupabaseProjectResponse = SupabaseLinkResult;

export interface SupabaseConnection {
  connected: boolean;
  supabase_user_id?: string | null;
  supabase_username?: string | null;
}

// --- billing → `createBillingCheckout`, schemas `CreateBillingCheckout*` ---
// (`handleBillingWebhook` intentionally skipped — Stripe-signed server hook.)

export interface CreateBillingCheckoutRequest {
  /** Whole euros to charge, 1..1000 (1 EUR = 100 credits, 1 credit = 1 EUR-cent). */
  amount_eur: number;
  success_url?: string;
  cancel_url?: string;
}

export interface BillingCheckout {
  /** Stripe Checkout Session id (`cs_*`). */
  session_id: string;
  /** Open this URL in a browser to collect payment. */
  checkout_url: string;
  /** Charged amount in euro cents. */
  amount_cents: number;
  /** Credits the wallet receives once paid (1 EUR = 100 credits). */
  credits: number;
  currency: "eur";
}

// --- wallets → `getMyWallet`/`listMyTransactions` ---
// Unit is EUR-cent credits: 1 credit = 1 EUR-cent, 1 EUR = 100 credits.
// Single balance — bonus grants (`reason: "bonus"`, e.g. gifts) credit the
// same `balance` like a top-up, there is no separate bonus column.
// Money math never uses floats — render `display_balance` verbatim
// (preformatted server-side, it-IT EUR).

export interface Wallet {
  /** Credit balance in EUR-cent credits. */
  balance: number;
  currency: "eur";
  /** Balance as decimal EUR string with 2 decimals (no float), e.g. "10.10". */
  balance_eur: string;
  /** Preformatted balance for direct rendering (it-IT), e.g. "10,10 €". */
  display_balance: string;
}

export type WalletTransactionReason =
  | "bonus"
  | "topup"
  | "spend"
  | "refund"
  | "migration"
  | "adjustment";

export interface WalletTransaction {
  id?: string;
  delta?: number;
  reason?: WalletTransactionReason;
  credits?: number | null;
  product_id?: string | null;
  created_at?: string;
  /**
   * Spend rows carry `run_id`, `job_id`, `project_id`, `app_name` (snapshot),
   * `is_first_generation` (create vs edit), `model`, `provider`; top-up rows
   * carry `stripe_session_id` + `amount_eur` (per swagger
   * `#/components/schemas/WalletTransaction`).
   */
  metadata?: Record<string, unknown>;
  /**
   * Spend rows only — absolute cost as decimal EUR string with 2 decimals
   * ("1.05"), enriched server-side from `abs(delta)`. Null/absent on
   * non-spend rows.
   */
  cost_eur?: string | null;
  /**
   * Spend rows only — preformatted cost for direct rendering (it-IT),
   * e.g. "1,05 €". Render verbatim. Null/absent on non-spend rows.
   */
  display_cost?: string | null;
}

export interface WalletTransactionsPage {
  data: WalletTransaction[];
  next_cursor?: string | null;
}

export interface ListTransactionsOptions {
  /** Filter by ledger reason (`spend` = expenses only). Omit for everything. */
  reason?: WalletTransactionReason;
  limit?: number;
  /** ISO timestamp cursor over created_at. */
  cursor?: string;
}

// --- usage → `getUsageSummary`/`getUsageContributions`/`getUsageInsights` ---

export type UsagePeriod = "month" | "week" | "all";

export interface UsageSummary {
  period_start?: string;
  period_end?: string;
  run_count?: number;
  generation_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  has_usage_data?: boolean;
}

export interface GetUsageSummaryOptions {
  period?: UsagePeriod;
  year?: number;
  month?: number;
}

export interface UsageContribution {
  day?: string;
  run_count?: number;
  total_tokens?: number;
}

export interface UsageContributionsPage {
  data: UsageContribution[];
}

export interface GetUsageContributionsOptions {
  start_date?: string;
  end_date?: string;
}

export interface UsageInsights {
  lines_of_code?: number;
  files_count?: number;
  current_streak?: number;
  best_streak?: number;
  best_month?: string;
  best_month_apps?: number;
  peak_hour?: number;
}

export interface GetUsageInsightsOptions {
  timezone?: string;
}

// --- users → `getMe`/`updateMe`/`deleteMe`/`uploadMyAvatar`/`getPublicProfile`, schema `Me` (sparse fieldsets) ---

export type MeField = "username" | "email" | "avatar_url";

export interface Me {
  user_id: string;
  username?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export interface UpdateMeRequest {
  username?: string;
  avatar_url?: string | null;
}

export interface AvatarUploadResponse {
  avatar_url: string;
}

// --- `GET /users/{userId}` → operationId `getPublicProfile`, schema `#/components/schemas/PublicProfile` ---

/** Public profile columns read by `screens/user` (feed hero). */
export interface PublicProfile {
  id: string;
  username?: string | null;
  avatar_url?: string | null;
  is_supporter?: boolean;
  created_at?: string;
  updated_at?: string;
}

// --- notifications → `listNotifications`/`getUnreadCount`/`markNotificationRead`/`markAllNotificationsRead` + push tokens ---

export interface NotificationSender {
  username?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

export interface Notification {
  id?: string;
  type?: string;
  entity_type?: string;
  entity_id?: number | null;
  metadata?: Record<string, unknown>;
  is_read?: boolean;
  created_at?: string;
  sender?: NotificationSender | null;
}

export interface NotificationsPage {
  data: Notification[];
  next_cursor?: string | null;
}

export interface ListNotificationsOptions {
  limit?: number;
  /** ISO timestamp cursor over created_at. */
  cursor?: string;
}

export interface UnreadCountResponse {
  unread_count: number;
}

export interface MarkNotificationReadRequest {
  is_read: true;
}

/** `PATCH /notifications` — bulk mark-all-as-read (`{ is_read: true }`). */
export interface MarkAllNotificationsReadRequest {
  is_read: true;
}

export interface MarkAllNotificationsReadResponse {
  updated_count: number;
}

export type DeviceType = "ios" | "android" | "web";

export interface RegisterPushTokenRequest {
  token: string;
  device_type?: DeviceType;
  locale?: string;
  time_zone?: string;
}

/** `POST /push-tokens` — registered row (upsert on conflict `token`). */
export interface PushToken {
  token: string;
  user_id?: string;
  device_type?: DeviceType;
  is_active?: boolean;
  last_used_at?: string;
  locale?: string;
  time_zone?: string;
  [key: string]: unknown;
}

/** `POST /push-tokens` — registered row. */
export type RegisterPushTokenResponse = PushToken;

export interface RemovePushTokenRequest {
  token: string;
}

// --- live-activity → `listLiveActivityTokens`/`registerLiveActivityToken`/`removeLiveActivityToken` ---

/** `live_activity_push_tokens` row (safe columns). */
export interface LiveActivityToken {
  id?: string;
  user_id?: string;
  push_to_start_token: string;
  activity_type?: string;
  is_active?: boolean;
  last_used_at?: string;
  [key: string]: unknown;
}

/** `GET /live-activity/tokens` — caller's active push-to-start tokens. */
export interface LiveActivityTokensPage {
  data: LiveActivityToken[];
}

/** `POST /live-activity/tokens` — upsert on conflict `push_to_start_token`. */
export interface RegisterLiveActivityTokenRequest {
  push_to_start_token: string;
  activity_type?: string;
}

/** `POST /live-activity/tokens` — registered row (201). */
export type RegisterLiveActivityTokenResponse = LiveActivityToken;

export interface RemoveLiveActivityTokenRequest {
  token: string;
}

// --- `#/components/schemas/Error` (401/400/404/429 bodies) ---
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// --- OAuth token endpoint (`POST {authBase}/oauth/token`, form-urlencoded) ---
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

// --- DCR (`POST {authBase}/oauth/clients/register`) ---
export interface RegisterClientInput {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: "none";
}

export interface RegisteredClient {
  client_id: string;
}

// --- In-memory session (never persisted by the SDK) ---
export interface Session {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
}

export interface SetSessionInput {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  client_id?: string;
}
