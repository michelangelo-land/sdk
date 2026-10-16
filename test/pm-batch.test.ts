import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MichelangeloClient } from "../src/client.js";
import { MichelangeloApiError } from "../src/errors.js";
import { isAllowedAttachmentMime } from "../src/types.js";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(url as string, init as RequestInit)) as typeof fetch;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function authed(fetchFn: typeof fetch): MichelangeloClient {
  const client = new MichelangeloClient({ fetchFn });
  client.auth.setSession({ access_token: "t" });
  // setSession emits SIGNED_IN — drop listeners' side effects by clearing
  // (fresh client has none anyway; this just documents the emission point).
  return client;
}

describe("PM batch: jobs active + ETA + waitForJob retry", () => {
  it("getActiveJob GETs /jobs/active", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return json({ id: "j-1", type: "prompt", status: "queued", created_at: "x", estimated_duration_seconds: 120, queue_position: 0 });
    });
    const job = await authed(fetchFn).getActiveJob();
    assert.ok(seenUrl.endsWith("/v1/jobs/active"));
    assert.equal(job.id, "j-1");
    assert.equal(job.estimated_duration_seconds, 120);
  });

  it("waitForJob retries transient network errors with backoff", async () => {
    let calls = 0;
    const fetchFn = stubFetch(() => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      return json({ id: "j-1", type: "prompt", status: "succeeded", created_at: "x" });
    });
    const job = await authed(fetchFn).waitForJob("j-1", { minDelayMs: 1, maxDelayMs: 2 });
    assert.equal(job.status, "succeeded");
    assert.equal(calls, 3);
  });

  it("waitForJob retries 502 then succeeds", async () => {
    let calls = 0;
    const fetchFn = stubFetch(() => {
      calls += 1;
      if (calls === 1) return json({ code: "upstream_error", message: "bad gateway" }, 502);
      return json({ id: "j-1", type: "prompt", status: "succeeded", created_at: "x" });
    });
    const job = await authed(fetchFn).waitForJob("j-1", { minDelayMs: 1, maxDelayMs: 2 });
    assert.equal(job.status, "succeeded");
    assert.equal(calls, 2);
  });

  it("waitForJob surfaces after maxNetworkRetries", async () => {
    const fetchFn = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      authed(fetchFn).waitForJob("j-1", { minDelayMs: 1, maxDelayMs: 2, maxNetworkRetries: 2, timeoutMs: 1000 }),
      (err: unknown) => err instanceof MichelangeloApiError && err.isNetworkError(),
    );
  });

  it("waitForJob opt-out (retryNetworkErrors:false) throws immediately", async () => {
    let calls = 0;
    const fetchFn = stubFetch(() => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      authed(fetchFn).waitForJob("j-1", { minDelayMs: 1, retryNetworkErrors: false }),
      (err: unknown) => err instanceof MichelangeloApiError && err.isNetworkError(),
    );
    assert.equal(calls, 1);
  });
});

describe("PM batch: projects owner + wallet summary + github user", () => {
  it("listProjects forwards owner", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return json({ data: [], next_cursor: null });
    });
    await authed(fetchFn).listProjects({ owner: "00000000-0000-4000-8000-000000000001" });
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("owner"), "00000000-0000-4000-8000-000000000001");
  });

  it("getWalletSummary GETs /wallets/me/summary", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return json({ balance: 800, currency: "eur", balance_eur: "8.00", display_balance: "8,00 €", total_granted: 2500, total_used: 1700, total_granted_eur: "25.00", total_used_eur: "17.00", display_granted: "25,00 €", display_used: "17,00 €" });
    });
    const out = await authed(fetchFn).getWalletSummary();
    assert.ok(seenUrl.endsWith("/v1/wallets/me/summary"));
    assert.equal(out.total_granted, 2500);
    assert.equal(out.total_used, 1700);
  });

  it("getCreditBalance aliases getWalletSummary", async () => {
    const fetchFn = stubFetch(() =>
      json({ balance: 1, currency: "eur", balance_eur: "0.01", display_balance: "0,01 €", total_granted: 10, total_used: 9, total_granted_eur: "0.10", total_used_eur: "0.09", display_granted: "0,10 €", display_used: "0,09 €" }),
    );
    const out = await authed(fetchFn).getCreditBalance();
    assert.equal(out.total_granted, 10);
  });

  it("getGithubUser GETs /github/user", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return json({ login: "octo", avatar_url: "https://github.com/octo.png", name: "Octo" });
    });
    const out = await authed(fetchFn).getGithubUser();
    assert.ok(seenUrl.endsWith("/v1/github/user"));
    assert.equal(out.login, "octo");
  });

  it("discoverGithubInstallations POSTs /github/discover", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn = stubFetch(async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return json({ installations: [{ id: 42, app_slug: "michelangelo-land" }] });
    });
    const out = await authed(fetchFn).discoverGithubInstallations({ ghu: "ghu_fresh" });
    assert.ok(seen!.url.endsWith("/v1/github/discover"));
    assert.deepEqual(seen!.body, { ghu: "ghu_fresh" });
    assert.equal(out.installations[0]?.id, 42);
  });
});

describe("PM batch: normalized errors + attachment constants", () => {
  it("activeJobId() reads details.job_id on 409", () => {
    const err = new MichelangeloApiError({ status: 409, code: "job_already_active", message: "busy", details: { job_id: "j-9" } });
    assert.equal(err.isJobAlreadyActive(), true);
    assert.equal(err.activeJobId(), "j-9");
  });

  it("isUsernameTaken / isNotConnected / isNetworkError / isRetryable", () => {
    assert.equal(new MichelangeloApiError({ status: 409, code: "username_taken", message: "x" }).isUsernameTaken(), true);
    assert.equal(new MichelangeloApiError({ status: 404, code: "not_connected", message: "x" }).isNotConnected(), true);
    assert.equal(new MichelangeloApiError({ status: 0, code: "network_error", message: "x" }).isNetworkError(), true);
    assert.equal(new MichelangeloApiError({ status: 0, code: "network_error", message: "x" }).isRetryable(), true);
    assert.equal(new MichelangeloApiError({ status: 502, code: "upstream_error", message: "x" }).isRetryable(), true);
    assert.equal(new MichelangeloApiError({ status: 400, code: "invalid_prompt", message: "x" }).isRetryable(), false);
  });

  it("attachment constants + mime guard", () => {
    assert.equal(isAllowedAttachmentMime("image/png"), true);
    assert.equal(isAllowedAttachmentMime("image/gif"), false);
  });
});

describe("PM batch: onAuthStateChange", () => {
  it("emits SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT with supabase-style handle", async () => {
    const client = new MichelangeloClient({ fetchFn: stubFetch(() => json({})) });
    const events: string[] = [];
    const sub = client.auth.onAuthStateChange((event) => events.push(event));
    client.auth.setSession({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    client.auth.setSession({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    client.auth.logout();
    client.auth.logout();
    assert.deepEqual(events, ["SIGNED_IN", "TOKEN_REFRESHED", "SIGNED_OUT"]);
    sub.data.subscription.unsubscribe();
    client.auth.setSession({ access_token: "b", expires_in: 60 });
    assert.deepEqual(events, ["SIGNED_IN", "TOKEN_REFRESHED", "SIGNED_OUT"]);
  });
});
