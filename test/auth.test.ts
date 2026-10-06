import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthManager } from "../src/auth.js";
import { MichelangeloClient } from "../src/client.js";
import { MichelangeloApiError } from "../src/errors.js";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(url as string, init as RequestInit)) as typeof fetch;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("auth dynamic flow", () => {
  it("SDK is born anonymous", () => {
    const client = new MichelangeloClient();
    assert.equal(client.auth.isAuthenticated(), false);
    assert.equal(client.auth.getAccessToken(), undefined);
  });

  it("beginLogin requires a client id (DCR first)", async () => {
    const auth = new AuthManager();
    await assert.rejects(() => auth.beginLogin({ redirectUri: "http://127.0.0.1:1/callback" }), /no client_id/);
  });

  it("beginLogin builds a PKCE S256 authorize URL from the swagger endpoints", async () => {
    const auth = new AuthManager({ clientId: "test-client" });
    const { url, codeVerifier, state } = await auth.beginLogin({
      redirectUri: "http://127.0.0.1:9/callback",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      state: "fixed-state",
    });
    const u = new URL(url);
    assert.equal(
      `${u.origin}${u.pathname}`,
      "https://auth.michelangelo.land/auth/v1/oauth/authorize",
    );
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("client_id"), "test-client");
    assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:9/callback");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(u.searchParams.get("state"), "fixed-state");
    assert.equal(codeVerifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    assert.equal(state, "fixed-state");
  });

  it("exchangeCode stores the token in memory; logout returns to anonymous", async () => {
    const fetchFn = stubFetch((url) => {
      assert.ok(String(url).endsWith("/oauth/token"));
      return json({ access_token: "tok-1", refresh_token: "ref-1", token_type: "Bearer", expires_in: 3600 });
    });
    const auth = new AuthManager({ clientId: "c1", fetchFn });
    assert.equal(auth.isAuthenticated(), false);
    await auth.exchangeCode({ code: "code-1", codeVerifier: "verifier", redirectUri: "http://127.0.0.1:1/callback" });
    assert.equal(auth.isAuthenticated(), true);
    assert.equal(auth.getAccessToken(), "tok-1");
    auth.logout();
    assert.equal(auth.isAuthenticated(), false);
  });

  it("registerClient stores the DCR client id", async () => {
    const fetchFn = stubFetch((url) => {
      assert.ok(String(url).endsWith("/oauth/clients/register"));
      return json({ client_id: "new-client" });
    });
    const auth = new AuthManager({ fetchFn });
    await auth.registerClient({ client_name: "t", redirect_uris: ["http://127.0.0.1/callback"] });
    assert.equal(auth.getClientId(), "new-client");
  });
});

describe("client token injection", () => {
  it("applies the in-memory token to calls after login; 401 maps to invalid_token", async () => {
    let seenAuth: string | null = null;
    const fetchFn = stubFetch((url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/v1/whoami")) {
        seenAuth = headers.get("authorization");
        if (seenAuth === "Bearer tok-1") {
          return json({ user_id: "u-1", client_id: "c1", scopes: ["email"] });
        }
        return json({ code: "invalid_token", message: "nope" }, 401);
      }
      if (String(url).endsWith("/oauth/token")) {
        return json({ access_token: "tok-1", token_type: "Bearer" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new MichelangeloClient({ fetchFn, clientId: "c1" });

    await assert.rejects(client.whoami(), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "invalid_token");
      return true;
    });

    await client.auth.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:1/callback" });
    const me = await client.whoami();
    assert.equal(me.user_id, "u-1");
    assert.equal(seenAuth, "Bearer tok-1");
  });

  it("health works without a token (public endpoint)", async () => {
    const fetchFn = stubFetch((url) => {
      assert.ok(String(url).endsWith("/v1/health"));
      return json({ ok: true });
    });
    const client = new MichelangeloClient({ fetchFn });
    assert.deepEqual(await client.health(), { ok: true });
  });
});
