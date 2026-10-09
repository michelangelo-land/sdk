import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MichelangeloClient } from "../src/client.js";
import { MichelangeloApiError } from "../src/errors.js";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(url as string, init as RequestInit)) as typeof fetch;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("jobs", () => {
  it("createJob POSTs the swagger body and returns the 202 row", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn = stubFetch(async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return json({ id: "j-1", type: "prompt", status: "queued", created_at: "2026-01-01T00:00:00Z" }, 202);
    });
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const job = await client.createJob({ type: "prompt", input: { prompt: "build a timer app" } });
    assert.equal(job.id, "j-1");
    assert.equal(job.status, "queued");
    assert.ok(seen!.url.endsWith("/v1/jobs"));
    assert.deepEqual(seen!.body, { type: "prompt", input: { prompt: "build a timer app" } });
  });

  it("waitForJob polls with backoff until a terminal status", async () => {
    const statuses = ["queued", "running", "succeeded"];
    const seen: string[] = [];
    const fetchFn = stubFetch((url) => {
      seen.push(url);
      const status = statuses.shift() ?? "succeeded";
      return json({ id: "j-1", type: "prompt", status, created_at: "x" });
    });
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const progress: string[] = [];
    const job = await client.waitForJob("j-1", {
      minDelayMs: 5,
      maxDelayMs: 10,
      onProgress: (j) => progress.push(j.status),
    });
    assert.equal(job.status, "succeeded");
    assert.deepEqual(progress, ["queued", "running", "succeeded"]);
    assert.equal(seen.length, 3);
  });

  it("waitForJob surfaces failed jobs instead of throwing", async () => {
    const fetchFn = stubFetch(() =>
      json({ id: "j-1", type: "prompt", status: "failed", error: { code: "e", message: "m" }, created_at: "x" }),
    );
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const job = await client.waitForJob("j-1", { minDelayMs: 1 });
    assert.equal(job.status, "failed");
    assert.equal(job.error?.code, "e");
  });

  it("waitForJob times out and aborts", async () => {
    const fetchFn = stubFetch(() =>
      json({ id: "j-1", type: "prompt", status: "running", created_at: "x" }),
    );
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    await assert.rejects(client.waitForJob("j-1", { timeoutMs: 25, minDelayMs: 5 }), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.code === "job_timeout");
      return true;
    });
    const ctl = new AbortController();
    const pending = client.waitForJob("j-1", { minDelayMs: 50, signal: ctl.signal });
    ctl.abort();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.code === "job_aborted");
      return true;
    });
  });
});

describe("projects", () => {
  it("listProjects encodes limit/visibility/cursor", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return json({ data: [], next_cursor: null });
    });
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    await client.listProjects({ limit: 5, visibility: "all", cursor: "2026-01-01T00:00:00Z" });
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(u.searchParams.get("visibility"), "all");
    assert.equal(u.searchParams.get("cursor"), "2026-01-01T00:00:00Z");
  });

  it("listAllProjects chains next_cursor and stops", async () => {
    const pages = [
      { data: [{ id: 1, name: "a", created_at: "3" }], next_cursor: "2" },
      { data: [{ id: 2, name: "b", created_at: "2" }], next_cursor: "1" },
      { data: [{ id: 3, name: "c", created_at: "1" }], next_cursor: null },
    ];
    const fetchFn = stubFetch(() => json(pages.shift()));
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const all = await client.listAllProjects();
    assert.deepEqual(all.map((p) => p.id), [1, 2, 3]);
  });

  it("listAllProjects guards against a stuck cursor", async () => {
    const fetchFn = stubFetch(() =>
      json({ data: [{ id: 1, name: "a", created_at: "x" }], next_cursor: "same" }),
    );
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    await assert.rejects(client.listAllProjects({ maxPages: 3 }), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.code === "too_many_pages");
      return true;
    });
  });
});

describe("billing", () => {
  it("createBillingCheckout returns the 201 session (1 EUR = 100 credits)", async () => {
    const fetchFn = stubFetch(() =>
      json(
        { session_id: "cs_1", checkout_url: "https://checkout/x", amount_cents: 2000, credits: 2000, currency: "eur" },
        201,
      ),
    );
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const co = await client.createBillingCheckout({ amount_eur: 20 });
    assert.equal(co.session_id, "cs_1");
    assert.equal(co.credits, 2000);
    assert.equal(co.amount_cents, 2000);
  });

  it("createJob surfaces 402 insufficient_credits", async () => {
    const fetchFn = stubFetch(() =>
      json({ code: "insufficient_credits", message: "top up" }, 402),
    );
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    await assert.rejects(client.createJob({ type: "prompt", input: { prompt: "x" } }), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.status === 402);
      assert.ok((err as MichelangeloApiError).isInsufficientCredits());
      assert.equal((err as MichelangeloApiError).code, "insufficient_credits");
      return true;
    });
  });
});

describe("users", () => {
  it("me() fetches the full profile, or a sparse fieldset", async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch((url) => {
      seen.push(url);
      return json({ user_id: "u", username: "jack", email: "j@x.io", avatar_url: null });
    });
    const client = new MichelangeloClient({ fetchFn });
    client.auth.setSession({ access_token: "t" });
    const full = await client.me();
    assert.equal(full.username, "jack");
    await client.me(["username", "email"]);
    assert.ok(seen[0]!.endsWith("/v1/me"), seen[0]);
    assert.ok(seen[1]!.endsWith("/v1/me?fields=username%2Cemail"), seen[1]);
  });
});

describe("auto-refresh on 401", () => {
  it("refreshes once and retries the original call", async () => {
    let whoamiCalls = 0;
    const fetchFn = stubFetch((url) => {
      if (String(url).endsWith("/oauth/token")) {
        return json({ access_token: "tok-2", refresh_token: "ref-2", token_type: "Bearer" });
      }
      whoamiCalls++;
      if (whoamiCalls === 1) return json({ code: "invalid_token", message: "expired" }, 401);
      return json({ user_id: "u", client_id: "c" });
    });
    const client = new MichelangeloClient({ fetchFn, clientId: "c" });
    client.auth.setSession({ access_token: "tok-1", refresh_token: "ref-1" });
    const me = await client.whoami();
    assert.equal(me.user_id, "u");
    assert.equal(client.auth.getAccessToken(), "tok-2");
    assert.equal(whoamiCalls, 2);
  });

  it("drops to anonymous when refresh fails, surfacing the 401", async () => {
    const fetchFn = stubFetch((url) => {
      if (String(url).endsWith("/oauth/token")) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ code: "invalid_token", message: "expired" }, 401);
    });
    const client = new MichelangeloClient({ fetchFn, clientId: "c" });
    client.auth.setSession({ access_token: "tok-1", refresh_token: "dead" });
    await assert.rejects(client.whoami(), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.status === 401);
      return true;
    });
    assert.equal(client.auth.isAuthenticated(), false);
  });

  it("does not retry without a refresh token or when disabled", async () => {
    const noRefresh = stubFetch(() => json({ code: "x", message: "y" }, 401));
    const c1 = new MichelangeloClient({ fetchFn: noRefresh });
    c1.auth.setSession({ access_token: "t" });
    await assert.rejects(c1.whoami(), MichelangeloApiError);

    let calls = 0;
    const disabled = stubFetch(() => {
      calls++;
      return json({ code: "x", message: "y" }, 401);
    });
    const c2 = new MichelangeloClient({ fetchFn: disabled, autoRefresh: false });
    c2.auth.setSession({ access_token: "t", refresh_token: "r" });
    await assert.rejects(c2.whoami(), MichelangeloApiError);
    assert.equal(calls, 1);
  });
});

describe("error mapping", () => {
  it("parses Retry-After on 429 and tolerates non-JSON bodies", async () => {
    const limited = stubFetch(() =>
      json({ code: "rate_limited", message: "slow down" }, 429, { "Retry-After": "7" }),
    );
    const c1 = new MichelangeloClient({ fetchFn: limited });
    c1.auth.setSession({ access_token: "t" });
    await assert.rejects(c1.whoami(), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError);
      assert.equal(err.retryAfter, 7);
      assert.ok(err.isRateLimited());
      return true;
    });

    const html = stubFetch(() => new Response("<html>oops</html>", { status: 502 }));
    const c2 = new MichelangeloClient({ fetchFn: html });
    c2.auth.setSession({ access_token: "t" });
    await assert.rejects(c2.whoami(), (err: unknown) => {
      assert.ok(err instanceof MichelangeloApiError && err.status === 502);
      return true;
    });
  });
});
