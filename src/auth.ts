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
    return this.getSession() as Session;
  }

  /** Back to anonymous — drops the in-memory token. */
  logout(): void {
    this.session = null;
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
      grant_types: input.grant_types ?? ["authorization_code"],
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

  /** Rotate the access token with the stored refresh token (kept in memory). */
  async refresh(): Promise<Session> {
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
