import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthManager } from "../src/auth.js";
import { MichelangeloClient } from "../src/client.js";
import type { PersistedSession, SessionLock, SessionStorage } from "../src/storage.js";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(url as string, init as RequestInit)) as typeof fetch;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

class MemoryStorage implements SessionStorage {
  data: PersistedSession | null = null;
  saves: PersistedSession[] = [];
  clears = 0;

  load(): PersistedSession | null {
    return this.data ? { ...this.data } : null;
  }

  save(session: PersistedSession): void {
    this.data = { ...session };
    this.saves.push({ ...session });
  }

  clear(): void {
    this.data = null;
    this.clears += 1;
  }
}

/** Minimal in-process mutex with the Web Locks `request()` shape. */
class TestLock implements SessionLock {
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.tail.then(callback, callback);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

describe("session persistence (opt-in)", () => {
  it("setSession persists changed tokens and client id", () => {
    const storage = new MemoryStorage();
    const auth = new AuthManager({ clientId: "c1", storage });
    auth.setSession({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600 });
    assert.equal(storage.saves.length, 1);
    assert.equal(storage.data?.accessToken, "tok-1");
    assert.equal(storage.data?.refreshToken, "ref-1");
    assert.equal(storage.data?.clientId, "c1");
    assert.equal(typeof storage.data?.expiresAt, "number");

    // Same tokens are a no-op (no storage loop).
    auth.setSession({ access_token: "tok-1", refresh_token: "ref-1" });
    assert.equal(storage.saves.length, 1);
  });

  it("exchangeCode persists the exchanged session", async () => {
    const storage = new MemoryStorage();
    const fetchFn = stubFetch(() =>
      json({ access_token: "tok-x", refresh_token: "ref-x", token_type: "Bearer", expires_in: 60 }),
    );
    const auth = new AuthManager({ clientId: "c1", fetchFn, storage });
    await auth.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:1/cb" });
    assert.equal(storage.data?.accessToken, "tok-x");
    assert.equal(storage.data?.refreshToken, "ref-x");
  });

  it("logout clears storage (best-effort)", () => {
    const storage = new MemoryStorage();
    const auth = new AuthManager({ clientId: "c1", storage });
    auth.setSession({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 60 });
    auth.logout();
    assert.equal(storage.data, null);
    assert.equal(storage.clears, 1);
    assert.equal(auth.isAuthenticated(), false);
  });

  it("restoreSession adopts stored tokens, emits SIGNED_IN and does not re-save", async () => {
    const storage = new MemoryStorage();
    storage.data = {
      accessToken: "tok-stored",
      refreshToken: "ref-stored",
      expiresAt: Date.now() + 60_000,
      clientId: "stored-client",
    };
    const auth = new AuthManager({ storage });
    const events: string[] = [];
    auth.onAuthStateChange((event) => events.push(event));

    const restored = await auth.restoreSession();
    assert.equal(restored?.accessToken, "tok-stored");
    assert.equal(auth.getAccessToken(), "tok-stored");
    assert.equal(auth.getClientId(), "stored-client");
    assert.deepEqual(events, ["SIGNED_IN"]);
    assert.equal(storage.saves.length, 0);

    // A second cold-start read with the same tokens is a no-op.
    await auth.restoreSession();
    assert.deepEqual(events, ["SIGNED_IN"]);
    assert.equal(storage.saves.length, 0);
  });

  it("restoreSession resolves null without storage or when load throws", async () => {
    const noStorage = new AuthManager();
    assert.equal(await noStorage.restoreSession(), null);

    const broken: SessionStorage = {
      load: () => {
        throw new Error("keychain locked");
      },
      save: () => {},
      clear: () => {},
    };
    const auth = new AuthManager({ storage: broken });
    assert.equal(await auth.restoreSession(), null);
    assert.equal(auth.isAuthenticated(), false);

    const expired = new MemoryStorage();
    expired.data = { accessToken: "tok-dead", expiresAt: Date.now() - 1000 };
    const expiredAuth = new AuthManager({ storage: expired });
    assert.equal(await expiredAuth.restoreSession(), null);
    assert.equal(expiredAuth.isAuthenticated(), false);
  });

  it("refresh inside a lock adopts a newer stored refresh token and persists the rotation", async () => {
    const storage = new MemoryStorage();
    const lock = new TestLock();
    const seenTokens: string[] = [];
    const fetchFn = stubFetch((_url, init) => {
      seenTokens.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      return json({ access_token: "tok-fresh", refresh_token: "ref-fresh", token_type: "Bearer", expires_in: 3600 });
    });
    const auth = new AuthManager({ clientId: "c1", fetchFn, storage, lock });
    auth.setSession({ access_token: "tok-old", refresh_token: "ref-old", expires_in: 0 });

    // Another tab rotated while this one was asleep.
    storage.data = {
      accessToken: "tok-other-tab",
      refreshToken: "ref-other-tab",
      expiresAt: Date.now() + 3600_000,
      clientId: "c1",
    };

    const session = await auth.refresh();
    assert.deepEqual(seenTokens, ["ref-other-tab"]);
    assert.equal(session.accessToken, "tok-fresh");
    assert.equal(storage.data?.refreshToken, "ref-fresh");
  });

  it("refresh retries once after token_failed, adopting the token written meanwhile", async () => {
    const storage = new MemoryStorage();
    const lock = new TestLock();
    const seenTokens: string[] = [];
    let calls = 0;
    const fetchFn = stubFetch((_url, init) => {
      calls += 1;
      seenTokens.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      if (calls === 1) {
        // A sibling tab rotates between our read and our request.
        storage.data = {
          accessToken: "tok-newer",
          refreshToken: "ref-newer",
          expiresAt: Date.now() + 3600_000,
          clientId: "c1",
        };
        return json({ code: "invalid_grant", message: "already used" }, 400);
      }
      return json({ access_token: "tok-retried", refresh_token: "ref-retried", token_type: "Bearer", expires_in: 3600 });
    });
    const auth = new AuthManager({ clientId: "c1", fetchFn, storage, lock });
    auth.setSession({ access_token: "tok-old", refresh_token: "ref-old", expires_in: 0 });
    storage.data = {
      accessToken: "tok-mid",
      refreshToken: "ref-mid",
      expiresAt: Date.now() + 3600_000,
      clientId: "c1",
    };

    const session = await auth.refresh();
    assert.equal(calls, 2);
    assert.deepEqual(seenTokens, ["ref-mid", "ref-newer"]);
    assert.equal(session.accessToken, "tok-retried");
    assert.equal(storage.data?.refreshToken, "ref-retried");
  });

  it("does not persist without a storage adapter", async () => {
    const fetchFn = stubFetch(() =>
      json({ access_token: "tok-1", refresh_token: "ref-1", token_type: "Bearer", expires_in: 60 }),
    );
    const auth = new AuthManager({ clientId: "c1", fetchFn });
    auth.setSession({ access_token: "tok-0", refresh_token: "ref-0", expires_in: 0 });
    await auth.refresh();
    assert.equal(auth.getAccessToken(), "tok-1");
    auth.logout();
    assert.equal(auth.isAuthenticated(), false);
  });

  it("MichelangeloClient forwards storage/lock to auth", async () => {
    const storage = new MemoryStorage();
    const lock = new TestLock();
    const fetchFn = stubFetch((_url, init) => {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token");
      assert.equal(token, "ref-1");
      return json({ access_token: "tok-2", refresh_token: "ref-2", token_type: "Bearer", expires_in: 3600 });
    });
    const client = new MichelangeloClient({ fetchFn, clientId: "c1", storage, lock });
    client.auth.setSession({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 0 });
    await client.auth.refresh();
    assert.equal(storage.data?.refreshToken, "ref-2");
  });
});
