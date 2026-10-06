/**
 * Types mirroring the swagger contract (`GET /v1/openapi.json`,
 * source file `api/openapi/v1.yaml`).
 * Hand-written on purpose for v0.1: the surface is tiny (health/whoami)
 * and this keeps runtime dependencies at zero. `scripts/contract-check.mjs`
 * guarantees these stay in sync with the live document; jobs/projects
 * schemas land with the next iteration.
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
