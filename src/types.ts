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
  /** Generated app name (first generation only); server-enriched when absent. */
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
  /** Expo push token notified on completion (stored in input). */
  expo_push_token?: string;
  /** Live Activity push token (stored in `input.live_activity_token`). */
  live_activity_token?: string;
  /** Live Activity user id (stored in `input.live_activity_user`). */
  live_activity_user?: string;
  /** Linked Supabase ref for the runner (stored in `input.supabase_project_ref`). */
  supabase_project_ref?: string;
  /** Client-generated uuid; replay with the same key returns the existing job. */
  idempotency_key?: string;
}

export interface CreateGithubPushJobRequest {
  /** Push the project to its linked GitHub repo via the github-actions edge. */
  type: "github-push";
  project_id: number;
  idempotency_key?: string;
}

/** `POST /jobs` body — `oneOf` with `type` discriminator. */
export type CreateJobRequest = CreatePromptJobRequest | CreateGithubPushJobRequest;

export interface AttachmentsManifest {
  idempotency_key: string;
  attachments: JobAttachmentRef[];
}

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  /** Numeric project id, nullable. */
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
  icon_url?: string | null;
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

/** `POST /projects/{id}/reshare` — free-form row (200 `{deduped:true}` on duplicate). */
export type ReshareResponse = Record<string, unknown>;

/** `POST /projects/{id}/icon` — proxied generate-project-icon edge result. */
export type GenerateIconResponse = Record<string, unknown>;

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
  /** Pass true to also delete the returned rows (what the app does after rendering). */
  consume?: boolean;
}

// --- explore → `listExploreProjects`, same `ProjectPage` shape ---

export interface ListExploreProjectsOptions {
  limit?: number;
  cursor?: string;
  /** Full-text query via RPC match_project. */
  q?: string;
}

// --- moderation → `createReport`/`blockUser` ---

export interface CreateReportRequest {
  reported_project_id?: number;
  reported_user_id?: string;
  reason?: string;
}

/** `POST /reports` — free-form `{...}` row. */
export type ReportResponse = Record<string, unknown>;

export interface CreateBlockRequest {
  blocked_id: string;
}

/** `POST /blocks` — free-form row (200 `deduped:true` on duplicate). */
export type BlockResponse = Record<string, unknown>;

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

// --- integrations/supabase → OAuth login / projects / links / connection ---

export interface StartSupabaseOAuthRequest {
  code_challenge: string;
  code_verifier?: string;
}

export interface StartSupabaseOAuthResponse {
  authorize_url: string;
  return_url: string;
}

/** `GET /integrations/supabase/projects` — edge-proxied `{projects, organizations}`. */
export type SupabaseProjectsResponse = Record<string, unknown>;

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

/** `POST /integrations/supabase/links` — proxied edge result (upserted link). */
export type LinkSupabaseProjectResponse = Record<string, unknown>;

export interface SupabaseConnection {
  connected: boolean;
  supabase_user_id?: string | null;
  supabase_username?: string | null;
}

// --- billing → `createBillingCheckout`, schemas `CreateBillingCheckout*` ---
// (`handleBillingWebhook` intentionally skipped — Stripe-signed server hook.)

export interface CreateBillingCheckoutRequest {
  /** Whole euros to charge, 1..1000 (1 EUR = 1 credit). */
  amount_eur: number;
  success_url?: string;
  cancel_url?: string;
}

export interface BillingCheckout {
  /** Stripe Checkout Session id (`cs_*`). */
  session_id: string;
  /** Open this URL in a browser to collect payment. */
  checkout_url: string;
  amount_cents: number;
  /** Credits the wallet receives once paid. */
  credits: number;
  currency: "eur";
}

// --- wallets → `getMyWallet`/`listMyTransactions` ---

export interface Wallet {
  balance: number;
  bonus_balance: number;
  bonus_expires_at?: string | null;
  total: number;
}

export interface WalletTransaction {
  id?: string;
  delta?: number;
  reason?: "bonus" | "topup" | "spend" | "refund" | "migration" | "adjustment";
  credits?: number | null;
  product_id?: string | null;
  created_at?: string;
}

export interface WalletTransactionsPage {
  data: WalletTransaction[];
  next_cursor?: string | null;
}

export interface ListTransactionsOptions {
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

/** `POST /push-tokens` — free-form upsert result. */
export type RegisterPushTokenResponse = Record<string, unknown>;

export interface RemovePushTokenRequest {
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
