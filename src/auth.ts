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
import type { PersistedSession, SessionLock, SessionStorage } from "./storage.js";
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
  /**
   * Opt-in persistence. Without it tokens stay in memory (the safe default).
   * When provided, `setSession`/`exchangeCode`/`refresh` save rotated tokens
   * and `logout` clears them — storage failures never break auth.
   */
  storage?: SessionStorage;
  /**
   * Opt-in cross-tab mutex (e.g. Web Locks API). When provided, `refresh()`
   * runs read→adopt→rotate→save inside one `request()` callback.
   */
  lock?: SessionLock;
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
 * Tokens live **in memory** by default — the SDK never touches localStorage,
 * disk or keychain unless a `storage` adapter is injected (opt-in). Tokens
 * are persisted only on rotation (`setSession`/`exchangeCode`/`refresh`);
 * `restoreSession()` adopts a stored session at cold start without
 * re-saving it. `client.request()` reads the token from here on every call.
 */
export class AuthManager {
  private readonly authBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pkceCrypto?: PkceCrypto;
  private readonly storage?: SessionStorage;
  private readonly lock?: SessionLock;
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
  /** Serializes storage writes so a fast rotation never lands before a slower one. */
  private storageWrite: Promise<void> = Promise.resolve();
  /** Count of in-flight async storage operations (sync adapters stay at 0). */
  private storagePending = 0;
  /** True only while an *async* storage operation is in flight. */
  private storageBusy = false;
  /** Invalidates queued writes when the user logs out mid-rotation. */
  private storageEpoch = 0;

  constructor(options: AuthManagerOptions = {}) {
    this.authBaseUrl = (options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.pkceCrypto = options.pkceCrypto;
    this.storage = options.storage;
    this.lock = options.lock;
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

  /**
   * Inject a session obtained elsewhere (e.g. restored refresh flow).
   * When `storage` is configured, changed tokens are persisted
   * fire-and-forget — storage errors never fail the auth transition.
   */
  setSession(input: SetSessionInput): Session {
    const previous = this.session;
    const next = this.applySession(input);
    this.persistIfChanged(previous, next);
    return next;
  }

  /**
   * Cold-start helper: adopt a persisted session into memory and return it.
   * Emits `SIGNED_IN` when the SDK was anonymous. Never re-saves the loaded
   * tokens, so storage listeners cannot loop. Resolves `null` when no
   * storage is configured, the store is empty, or `load()` throws.
   */
  async restoreSession(): Promise<Session | null> {
    const storage = this.storage;
    if (!storage) return null;
    let persisted: PersistedSession | null;
    try {
      persisted = await storage.load();
    } catch {
      return null;
    }
    if (!persisted?.accessToken) return null;
    // An expired access token is still recoverable via refresh; without a
    // refresh token the stored session is definitively dead.
    if (
      typeof persisted.expiresAt === "number" &&
      persisted.expiresAt <= Date.now() &&
      !persisted.refreshToken
    ) {
      return null;
    }

    const previous = this.session;
    if (
      previous &&
      previous.accessToken === persisted.accessToken &&
      previous.refreshToken === persisted.refreshToken
    ) {
      return this.getSession();
    }

    this.session = {
      accessToken: persisted.accessToken,
      refreshToken: persisted.refreshToken,
      expiresAt: persisted.expiresAt,
      clientId: persisted.clientId,
    };
    if (persisted.clientId) this.clientId = persisted.clientId;
    const next = this.getSession() as Session;
    this.emit(previous ? "TOKEN_REFRESHED" : "SIGNED_IN", next);
    return next;
  }

  /** Back to anonymous — drops the in-memory token and clears storage (best-effort). */
  logout(): void {
    const hadSession = this.session !== null;
    this.session = null;
    this.lastRefreshFailure = null;
    const storage = this.storage;
    if (storage) {
      this.storageEpoch += 1;
      this.enqueueClear(storage);
    }
    if (hadSession) this.emit("SIGNED_OUT", null);
  }

  private applySession(input: SetSessionInput): Session {
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

  private persistIfChanged(previous: Session | null, next: Session): void {
    if (!this.storage) return;
    if (
      previous &&
      previous.accessToken === next.accessToken &&
      previous.refreshToken === next.refreshToken
    ) {
      return;
    }
    this.saveToStorage(next);
  }

  private saveToStorage(session: Session): void {
    const storage = this.storage;
    if (!storage) return;
    const persisted = toPersistedSession(session);
    const epoch = this.storageEpoch;
    if (!this.storageBusy) {
      const pending = this.performSave(storage, persisted, epoch);
      if (pending) this.startPending(pending);
      return;
    }
    void this.enqueueStorage(async () => {
      const pending = this.performSave(storage, persisted, epoch);
      if (pending) await pending;
    });
  }

  private async saveToStorageNow(session: Session): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const persisted = toPersistedSession(session);
    const epoch = this.storageEpoch;
    await this.enqueueStorage(async () => {
      const pending = this.performSave(storage, persisted, epoch);
      if (pending) await pending;
    });
  }

  private enqueueStorage(run: () => Promise<void> | null): Promise<void> {
    this.storagePending += 1;
    this.storageBusy = true;
    const tracked = this.storageWrite
      .then(async () => {
        const pending = run();
        if (pending) await pending;
      })
      .catch(() => {})
      .then(() => {
        this.storagePending -= 1;
        if (this.storagePending === 0) this.storageBusy = false;
      });
    this.storageWrite = tracked;
    return tracked;
  }

  /** Track an already-started async operation without adding a queue hop. */
  private startPending(pending: Promise<void>): void {
    this.storagePending += 1;
    this.storageBusy = true;
    this.storageWrite = pending
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        this.storagePending -= 1;
        if (this.storagePending === 0) this.storageBusy = false;
      });
  }

  private enqueueClear(storage: SessionStorage): void {
    if (!this.storageBusy) {
      const pending = this.performClear(storage);
      if (pending) this.startPending(pending);
      return;
    }
    void this.enqueueStorage(async () => {
      const pending = this.performClear(storage);
      if (pending) await pending;
    });
  }

  private performSave(
    storage: SessionStorage,
    persisted: PersistedSession,
    epoch: number,
  ): Promise<void> | null {
    // A logout landed while this write was queued: never resurrect tokens.
    if (epoch !== this.storageEpoch) return null;
    try {
      const result = storage.save(persisted);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Best-effort: persistence must never break authentication.
    }
    return null;
  }

  private performClear(storage: SessionStorage): Promise<void> | null {
    try {
      const result = storage.clear();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Best-effort: a broken storage adapter must not block logout.
    }
    return null;
  }

  /**
   * Read the shared store inside the refresh lock and adopt a *newer*
   * refresh token written by another tab. Returns true when memory changed.
   * Does not emit or re-save: the rotation that follows emits/saves.
   */
  private async adoptStoredSession(): Promise<boolean> {
    const storage = this.storage;
    if (!storage) return false;
    let persisted: PersistedSession | null;
    try {
      persisted = await storage.load();
    } catch {
      return false;
    }
    const current = this.session;
    if (!persisted?.accessToken || !persisted.refreshToken) return false;
    if (persisted.refreshToken === current?.refreshToken) return false;

    this.session = {
      accessToken: persisted.accessToken,
      refreshToken: persisted.refreshToken,
      expiresAt: persisted.expiresAt,
      clientId: persisted.clientId,
    };
    if (persisted.clientId) this.clientId = persisted.clientId;
    return true;
  }

  /**
   * Subscribe to in-memory auth events (`SIGNED_IN` on null → session,
   * `TOKEN_REFRESHED` on rotation, `SIGNED_OUT` on logout). Persistence is
   * opt-in via the injected `storage` adapter; without one the SDK never
   * touches disk/keychain/localStorage. The listener shape mirrors the
   * Supabase handle so UI layers can sync React state without polling
   * `getSession()`. Returns a Supabase-style subscription handle.
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
   *
   * With a `lock`, the whole rotation runs inside `lock.request(...)`:
   * re-read storage, adopt a newer refresh token written by another tab,
   * rotate, then wait for the save before releasing the lock. A
   * `token_failed` rotation (another tab won the race) adopts storage again
   * and retries exactly once. Without a lock, only in-process single-flight
   * plus persistence applies.
   */
  async refresh(): Promise<Session> {
    const inFlight = this.refreshPromise;
    if (inFlight) return inFlight;
    const started = this.lock ? this.refreshWithLock(this.lock) : this.refreshWithoutLock();
    this.refreshPromise = started;
    try {
      const session = await started;
      this.lastRefreshFailure = null;
      return session;
    } catch (err) {
      const failedToken = this.session?.refreshToken;
      if (failedToken) this.lastRefreshFailure = { refreshToken: failedToken, at: Date.now() };
      throw err;
    } finally {
      if (this.refreshPromise === started) this.refreshPromise = null;
    }
  }

  private throwIfCoolingDown(currentToken: string | undefined): void {
    const cooled = this.lastRefreshFailure;
    if (
      currentToken &&
      cooled &&
      cooled.refreshToken === currentToken &&
      Date.now() - cooled.at < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      throw new MichelangeloAuthError("refresh: cooling down after recent failure", "cooldown");
    }
  }

  private refreshWithoutLock(): Promise<Session> {
    this.throwIfCoolingDown(this.session?.refreshToken);
    return this.doRefresh(false);
  }

  private refreshWithLock(lock: SessionLock): Promise<Session> {
    return lock.request(async () => {
      await this.adoptStoredSession();
      // Cooldown is checked *after* adopting storage: a token rotated by a
      // sibling tab must not be blocked by a failure on the stale one.
      this.throwIfCoolingDown(this.session?.refreshToken);
      try {
        return await this.doRefresh(true);
      } catch (err) {
        if (err instanceof MichelangeloAuthError && err.causeCode === "token_failed") {
          // Retry only when another tab actually persisted a newer pair.
          // Retrying with the same consumed token would just hammer /token.
          if (await this.adoptStoredSession()) return this.doRefresh(true);
        }
        throw err;
      }
    });
  }

  /**
   * @param awaitPersist Wait for the storage write before resolving — used
   * inside the cross-tab lock so another tab never reads a stale token.
   */
  private async doRefresh(awaitPersist: boolean): Promise<Session> {
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
    const previous = this.session;
    const next = this.applySession({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? refreshToken,
      expires_in: token.expires_in,
    });
    if (awaitPersist) await this.saveToStorageNow(next);
    else this.persistIfChanged(previous, next);
    return next;
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

function toPersistedSession(session: Session): PersistedSession {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    clientId: session.clientId,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<void>).then === "function"
  );
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
