/**
 * Types mirroring the swagger contract (`GET /v1/openapi.json`,
 * source file `api/openapi/v1.yaml`).
 * Hand-written on purpose: the surface is small and this keeps runtime
 * dependencies at zero. `scripts/contract-check.mjs` guarantees these stay in
 * sync with the live document.
 * Not covered on purpose: `getOpenApiDocument`/`getDocs` (meta endpoints)
 * and `handleBillingWebhook` (server-to-server, Stripe-signed — not a client
 * concern).
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

// --- jobs → `createJob`/`getJob`, schemas `CreateJobRequest`/`Job` ---

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobTier = "light" | "full";

export interface JobInput {
  prompt: string;
  /** Vendor-neutral tier; server-enriched from prompt evaluation when absent. */
  model?: JobTier;
  /** Generated app name (first generation only); server-enriched when absent. */
  appName?: string | null;
}

export interface CreateJobRequest {
  type: "prompt";
  /** Numeric project id; omit for first generation. */
  project_id?: number;
  input: JobInput & Record<string, unknown>;
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

// --- projects → `listProjects`/`getProject`, schemas `Project`/`ProjectPage` ---

export type ProjectVisibility = "mine" | "all";

export interface Project {
  id: number;
  name: string;
  description?: string;
  icon_url?: string;
  created_at: string;
  updated_at?: string;
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

// --- users → `getMe`, schema `Me` (sparse fieldsets) ---

export type MeField = "username" | "email" | "avatar_url";

export interface Me {
  user_id: string;
  username?: string | null;
  email?: string | null;
  avatar_url?: string | null;
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
