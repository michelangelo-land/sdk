import {
  AUTHORIZE_URL,
  DCR_URL,
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_SCOPES,
  TOKEN_URL,
} from "./config.js";
import { MichelangeloAuthError } from "./errors.js";
import { defaultFetch } from "./http.js";
import { generateCodeChallenge, generateCodeVerifier, generateState, type PkceCrypto } from "./pkce.js";
import type {
  RegisterClientInput,
  RegisteredClient,
  Session,
  SetSessionInput,
  TokenResponse,
} from "./types.js";

/**
 * Serial callers re-presenting a just-failed refresh token fail fast for
 * this long instead of hammering the token endpoint (mirrors
 * `REFRESH_FAILURE_COOLDOWN_MS` in @supabase/auth-js).
 */
const REFRESH_FAILURE_COOLDOWN_MS = 10_000;

export interface AuthManagerOptions {
  /** Defaults to https://auth.michelangelo.land/auth/v1 (from swagger `oauth2` scheme). */
  authBaseUrl?: string;
  /** Reuse a pre-registered OAuth client id — skips DCR. When omitted, call `registerClient()` first. */
  clientId?: string;
  fetchFn?: typeof fetch;
  /** PKCE backend — defaults to WebCrypto; inject the expo-crypto adapter on Hermes. */
  pkceCrypto?: PkceCrypto;
}

export interface BeginLoginInput {
  redirectUri: string;
  scopes?: string[];
  /** Override for tests; generated otherwise. */
  state?: string;
  /** Override for tests; generated otherwise. */
  codeVerifier?: string;
}

export interface BeginLoginResult {
  /** URL to open in the browser (consent screen). */
  url: string;
  /** Keep in memory and pass to `exchangeCode` with the returned `code`. */
  codeVerifier: string;
  state: string;
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export type AuthChangeEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED";

export interface AuthState {
  event: AuthChangeEvent;
  session: Session | null;
}

export type AuthChangeListener = (event: AuthChangeEvent, session: Session | null) => void;

/**
 * Dynamic authentication: the SDK is born **anonymous** (`isAuthenticated() === false`)
 * and becomes authenticated through `beginLogin()` + `exchangeCode()` (or the
 * `loginWithLoopback()` helper in `node-loopback.js`).
 *
 * Tokens live **only in memory** — the SDK never touches localStorage, disk or
 * keychain. `client.request()` reads the token from here on every call.
 */
export class AuthManager {
  private readonly authBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pkceCrypto?: PkceCrypto;
  private clientId?: string;
  private session: Session | null = null;
  private readonly listeners = new Set<AuthChangeListener>();
  /**
   * Single-flight guard for `refresh()`: refresh tokens are single-use
   * (the server invalidates the previous token on every rotation), so N
   * concurrent 401s — e.g. React Query refetching profile + balance +
   * notifications together after the access token expired — must share one
   * token call instead of racing the same refresh token (all but one would
   * lose with "already used" and drop to anonymous).
   *
   * This coalesces in-process concurrency only. Cross-tab (multi-tab web)
   * exclusion lives one layer up, where the shared storage lives — the app
   * serializes rotations with the Web Locks API and re-reads storage inside
   * the lock. Same split as @supabase/auth-js (`navigatorLock` on web,
   * process-local guard on React Native).
   */
  private refreshPromise: Promise<Session> | null = null;
  /**
   * Last refresh failure, keyed by the refresh token that failed. Serial
   * callers presenting the *same* token within `REFRESH_FAILURE_COOLDOWN_MS`
   * fail fast instead of hammering `/token` with a dead token; callers with
   * a *different* token (rotation picked up cross-tab, fresh `setSession`)
   * bypass it. Cleared on any success and on `logout()`. Same idea as
   * `REFRESH_FAILURE_COOLDOWN_MS` in @supabase/auth-js.
   */
  private lastRefreshFailure: { refreshToken: string; at: number } | null = null;

  constructor(options: AuthManagerOptions = {}) {
    this.authBaseUrl = (options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.pkceCrypto = options.pkceCrypto;
    this.clientId = options.clientId;
  }

  // --- state ---------------------------------------------------------------

  getClientId(): string | undefined {
    return this.clientId;
  }

  setClientId(clientId: string): void {
    this.clientId = clientId;
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  getAccessToken(): string | undefined {
    return this.session?.accessToken;
  }

  getSession(): Session | null {
    return this.session ? { ...this.session } : null;
  }

  /** Inject a session obtained elsewhere (e.g. restored refresh flow). */
  setSession(input: SetSessionInput): Session {
    if (!input.access_token) throw new MichelangeloAuthError("setSession: missing access_token");
    const hadSession = this.session !== null;
    this.session = {
      accessToken: input.access_token,
      refreshToken: input.refresh_token ?? this.session?.refreshToken,
      expiresAt:
        typeof input.expires_in === "number"
          ? Date.now() + input.expires_in * 1000
          : this.session?.expiresAt,
      clientId: input.client_id ?? this.clientId,
    };
    if (input.client_id) this.clientId = input.client_id;
    const next = this.getSession() as Session;
    this.emit(hadSession ? "TOKEN_REFRESHED" : "SIGNED_IN", next);
    return next;
  }

  /** Back to anonymous — drops the in-memory token. */
  logout(): void {
    const hadSession = this.session !== null;
    this.session = null;
    this.lastRefreshFailure = null;
    if (hadSession) this.emit("SIGNED_OUT", null);
  }

  /**
   * Subscribe to in-memory auth events (`SIGNED_IN` on null → session,
   * `TOKEN_REFRESHED` on rotation, `SIGNED_OUT` on logout). Storage-agnostic
   * by design: persistence and cross-tab sync stay in the app (SecureStore /
   * localStorage + Web Locks) — this only mirrors the Supabase listener
   * shape so UI layers can sync React state without polling `getSession()`.
   * Returns a Supabase-style subscription handle.
   */
  onAuthStateChange(listener: AuthChangeListener): {
    data: { subscription: { unsubscribe: () => void } };
  } {
    this.listeners.add(listener);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listeners.delete(listener);
          },
        },
      },
    };
  }

  private emit(event: AuthChangeEvent, session: Session | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event, session ? { ...session } : null);
      } catch {
        // Listener errors must never break auth state transitions.
      }
    }
  }

  /** `Authorization` header value for the current session, if any. */
  authHeader(): Record<string, string> {
    return this.session ? { Authorization: `Bearer ${this.session.accessToken}` } : {};
  }

  // --- DCR -------------------------------------------------------------------

  /** Register a public client (PKCE, no secret) — Dynamic Client Registration. */
  async registerClient(input: RegisterClientInput): Promise<RegisteredClient> {
    const body: RegisterClientInput = {
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      grant_types: input.grant_types ?? ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    };
    let res: Response;
    try {
      res = await this.fetchFn(this.dcrUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new MichelangeloAuthError(
        `registerClient: network error (${(err as Error).message})`,
        "network_error",
      );
    }
    if (!res.ok) {
      throw new MichelangeloAuthError(
        `registerClient failed: HTTP ${res.status} ${await safeBodyText(res)}`,
        "registration_failed",
      );
    }
    const data = (await res.json()) as RegisteredClient;
    if (!data.client_id) {
      throw new MichelangeloAuthError("registerClient: response has no client_id", "bad_response");
    }
    this.clientId = data.client_id;
    return data;
  }

  // --- login -------------------------------------------------------------------

  /**
   * Step 1 — build the consent URL. Open `url` in a browser; after approval
   * the auth server redirects to `redirectUri` with `?code=…`.
   */
  async beginLogin(input: BeginLoginInput): Promise<BeginLoginResult> {
    const clientId = this.clientId;
    if (!clientId) {
      throw new MichelangeloAuthError(
        "beginLogin: no client_id — call registerClient() or setClientId() first",
        "missing_client_id",
      );
    }
    const codeVerifier = input.codeVerifier ?? generateCodeVerifier(this.pkceCrypto);
    const challenge = await generateCodeChallenge(codeVerifier, this.pkceCrypto);
    const state = input.state ?? generateState(this.pkceCrypto);
    const scopes = input.scopes ?? [...DEFAULT_SCOPES];

    const url = new URL(this.authorizeUrl());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));

    return { url: url.toString(), codeVerifier, state };
  }

  /** Step 2 — trade the browser `code` for tokens; the session stays in memory. */
  async exchangeCode(input: ExchangeCodeInput): Promise<Session> {
    const clientId = this.clientId;
    if (!clientId) {
      throw new MichelangeloAuthError(
        "exchangeCode: no client_id — call registerClient() or setClientId() first",
        "missing_client_id",
      );
    }
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: clientId,
      code_verifier: input.codeVerifier,
    });
    const token = await this.tokenRequest(params);
    return this.setSession({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
      client_id: clientId,
    });
  }

  /**
   * Rotate the access token with the stored refresh token (kept in memory).
   * Concurrent callers share a single in-flight token request (single-flight)
   * — see `refreshPromise`. The in-flight promise is cleared on settle so a
   * later expiry triggers a fresh rotation. Serial callers re-presenting a
   * token that just failed fail fast within the cooldown window instead of
   * hammering the token endpoint.
   */
  async refresh(): Promise<Session> {
    const inFlight = this.refreshPromise;
    if (inFlight) return inFlight;
    const currentToken = this.session?.refreshToken;
    const cooled = this.lastRefreshFailure;
    if (
      currentToken &&
      cooled &&
      cooled.refreshToken === currentToken &&
      Date.now() - cooled.at < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      throw new MichelangeloAuthError("refresh: cooling down after recent failure", "cooldown");
    }
    const started = this.doRefresh();
    this.refreshPromise = started;
    try {
      const session = await started;
      this.lastRefreshFailure = null;
      return session;
    } catch (err) {
      if (currentToken) this.lastRefreshFailure = { refreshToken: currentToken, at: Date.now() };
      throw err;
    } finally {
      if (this.refreshPromise === started) this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<Session> {
    const refreshToken = this.session?.refreshToken;
    if (!refreshToken) {
      throw new MichelangeloAuthError("refresh: no refresh_token in memory", "missing_refresh_token");
    }
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (this.clientId) params.set("client_id", this.clientId);
    const token = await this.tokenRequest(params);
    return this.setSession({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? refreshToken,
      expires_in: token.expires_in,
    });
  }

  // --- internals ---------------------------------------------------------------

  private authorizeUrl(): string {
    return this.authBaseUrl === DEFAULT_AUTH_BASE_URL ? AUTHORIZE_URL : `${this.authBaseUrl}/oauth/authorize`;
  }

  private tokenUrl(): string {
    return this.authBaseUrl === DEFAULT_AUTH_BASE_URL ? TOKEN_URL : `${this.authBaseUrl}/oauth/token`;
  }

  private dcrUrl(): string {
    return this.authBaseUrl === DEFAULT_AUTH_BASE_URL ? DCR_URL : `${this.authBaseUrl}/oauth/clients/register`;
  }

  private async tokenRequest(params: URLSearchParams): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch (err) {
      throw new MichelangeloAuthError(
        `token request: network error (${(err as Error).message})`,
        "network_error",
      );
    }
    if (!res.ok) {
      throw new MichelangeloAuthError(
        `token request failed: HTTP ${res.status} ${await safeBodyText(res)}`,
        "token_failed",
      );
    }
    const data = (await res.json()) as TokenResponse;
    if (!data.access_token) {
      throw new MichelangeloAuthError("token request: response has no access_token", "bad_response");
    }
    return data;
  }
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
