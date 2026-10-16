import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MichelangeloClient } from "../src/client.js";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(url as string, init as RequestInit)) as typeof fetch;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function authed(fetchFn: typeof fetch): MichelangeloClient {
  const client = new MichelangeloClient({ fetchFn });
  client.auth.setSession({ access_token: "t" });
  return client;
}

describe("users (new)", () => {
  it("updateMe PATCHes /me with the JSON body", async () => {
    let seen: { url: string; method?: string; body: unknown } | null = null;
    const fetchFn = stubFetch(async (url, init) => {
      seen = { url, method: init?.method, body: JSON.parse(String(init?.body)) };
      return json({ user_id: "u", username: "jack" });
    });
    const out = await authed(fetchFn).updateMe({ username: "jack" });
    assert.equal(out.username, "jack");
    assert.ok(seen!.url.endsWith("/v1/me"));
    assert.equal(seen!.method, "PATCH");
    assert.deepEqual(seen!.body, { username: "jack" });
  });

  it("deleteMe resolves void on 204", async () => {
    let method = "";
    const fetchFn = stubFetch((url, init) => {
      method = init?.method ?? "";
      assert.ok(String(url).endsWith("/v1/me"));
      return new Response(null, { status: 204 });
    });
    const out = await authed(fetchFn).deleteMe();
    assert.equal(out, undefined);
    assert.equal(method, "DELETE");
  });

  it("uploadMyAvatar sends multipart without a JSON Content-Type", async () => {
    let seen: { body: unknown; contentType: string | null } | null = null;
    const fetchFn = stubFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      seen = { body: init?.body, contentType: headers.get("content-type") };
      assert.ok(init?.body instanceof FormData);
      assert.equal((init?.body as FormData).get("file") instanceof Blob, true);
      return json({ avatar_url: "https://cdn/x.png" }, 201);
    });
    const out = await authed(fetchFn).uploadMyAvatar(new Blob(["x"], { type: "image/png" }));
    assert.equal(out.avatar_url, "https://cdn/x.png");
    assert.equal(seen!.contentType, null);
    assert.ok(seen!.body instanceof FormData);
  });

  it("uploadMyAvatar passes through a prebuilt RN-style FormData", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "image/png" }));
    const fetchFn = stubFetch((_url, init) => {
      assert.equal(init?.body, form);
      return json({ avatar_url: "https://cdn/y.png" }, 201);
    });
    const out = await authed(fetchFn).uploadMyAvatar(form);
    assert.equal(out.avatar_url, "https://cdn/y.png");
  });

  it("getPublicProfile GETs /users/{userId}", async () => {
    const userId = "00000000-0000-4000-8000-000000000001";
    let seenUrl = "";
    const fetchFn = stubFetch((url, init) => {
      seenUrl = String(url);
      assert.equal(init?.method ?? "GET", "GET");
      return json({ id: userId, username: "jack", avatar_url: null, is_supporter: false });
    });
    const out = await authed(fetchFn).getPublicProfile(userId);
    assert.equal(out.id, userId);
    assert.equal(out.username, "jack");
    assert.ok(seenUrl.endsWith(`/v1/users/${userId}`), seenUrl);
  });
});

describe("jobs (new)", () => {
  it("createJob is prompt-only (push tokens moved to registered tables)", async () => {
    let body: unknown = null;
    const fetchFn = stubFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ id: "j-2", type: "prompt", status: "queued", created_at: "x" }, 202);
    });
    const job = await authed(fetchFn).createJob({
      type: "prompt",
      input: { prompt: "hi" },
      supabase_project_ref: "ref",
    });
    assert.equal(job.type, "prompt");
    assert.deepEqual(body, {
      type: "prompt",
      input: { prompt: "hi" },
      supabase_project_ref: "ref",
    });
  });

  it("pushProjectToGithub POSTs /projects/{id}/pushes (sync, no polling)", async () => {
    let seen = "";
    const fetchFn = stubFetch((url, init) => {
      seen = String(url);
      assert.equal(init?.method, "POST");
      return json({ pushed: true, commit_sha: "abc123", message: null }, 201);
    });
    const out = await authed(fetchFn).pushProjectToGithub(12);
    assert.equal(out.pushed, true);
    assert.equal(out.commit_sha, "abc123");
    assert.ok(seen.endsWith("/v1/projects/12/pushes"), seen);
  });

  it("uploadJobAttachments sends files + idempotency_key as multipart", async () => {
    const fetchFn = stubFetch((_url, init) => {
      const form = init?.body as FormData;
      assert.ok(form instanceof FormData);
      assert.equal(form.get("idempotency_key"), "00000000-0000-4000-8000-000000000000");
      assert.equal((form.getAll("files") as Blob[]).length, 2);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("content-type"), null);
      return json({ idempotency_key: "00000000-0000-4000-8000-000000000000", attachments: [] }, 201);
    });
    const out = await authed(fetchFn).uploadJobAttachments({
      files: [new Blob(["a"], { type: "image/png" }), new Blob(["b"], { type: "image/jpeg" })],
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(out.attachments.length, 0);
  });
});

describe("projects (new)", () => {
  it("createProject / updateProject / deleteProject", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") return json({ id: 1, name: "a", created_at: "x" }, 201);
      if (init?.method === "PATCH") return json({ id: 1, name: "b", created_at: "x" });
      return new Response(null, { status: 204 });
    });
    const client = authed(fetchFn);
    const created = await client.createProject({ name: "a" });
    assert.equal(created.id, 1);
    const updated = await client.updateProject(1, { name: "b" });
    assert.equal(updated.name, "b");
    assert.equal(await client.deleteProject(1), undefined);
    assert.deepEqual(calls, [
      "POST https://api.michelangelo.land/v1/projects",
      "PATCH https://api.michelangelo.land/v1/projects/1",
      "DELETE https://api.michelangelo.land/v1/projects/1",
    ]);
  });

  it("listProjectFiles encodes ?type and saveProjectFiles PUTs the body", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url, init) => {
      if (init?.method === "PUT") {
        assert.deepEqual(JSON.parse(String(init.body)), { files: [{ path: "A", contents: "b" }] });
        return json({ data: [{ path: "A", contents: "b" }] });
      }
      seenUrl = url;
      return json({ data: [] });
    });
    const client = authed(fetchFn);
    await client.listProjectFiles(12, { type: "CODE" });
    assert.ok(seenUrl.endsWith("/v1/projects/12/files?type=CODE"), seenUrl);
    const saved = await client.saveProjectFiles(12, { files: [{ path: "A", contents: "b" }] });
    assert.equal(saved.data.length, 1);
  });

  it("icon / reshare / preview-errors / drain / supabase-link", async () => {
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith("/icon")) {
        assert.equal(init?.method, "POST");
        return json({ icon_url: "https://cdn/i.png" });
      }
      if (u.endsWith("/reshares")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { platform: "x" });
        return json({ project_id: 12, reshared_by_user_id: "u", platform: "x" }, 201);
      }
      if (u.endsWith("/preview-errors") && (init?.method ?? "GET") === "GET") {
        assert.ok(!u.includes("consume"), u);
        return json({ data: [{ id: "e1", message: "boom" }] });
      }
      if (u.endsWith("/preview-errors") && init?.method === "DELETE") {
        return json({ deleted_count: 2 });
      }
      assert.ok(u.endsWith("/supabase-link"), u);
      return json({ project_id: 12, supabase_project_ref: "ref" });
    });
    const client = authed(fetchFn);
    assert.equal((await client.generateProjectIcon(12)).icon_url, "https://cdn/i.png");
    assert.deepEqual(await client.reshareProject(12, { platform: "x" }), {
      project_id: 12,
      reshared_by_user_id: "u",
      platform: "x",
    });
    assert.equal((await client.listPreviewErrors(12)).data[0]?.id, "e1");
    assert.equal((await client.drainPreviewErrors(12)).deleted_count, 2);
    assert.equal((await client.getProjectSupabaseLink(12)).supabase_project_ref, "ref");
  });

  it("listPreviewErrors({ consume: true }) lists then drains (legacy shim)", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "DELETE") return json({ deleted_count: 1 });
      return json({ data: [{ id: "e1", message: "boom" }] });
    });
    const page = await authed(fetchFn).listPreviewErrors(12, { consume: true });
    assert.equal(page.data[0]?.id, "e1");
    assert.deepEqual(calls, [
      "GET https://api.michelangelo.land/v1/projects/12/preview-errors",
      "DELETE https://api.michelangelo.land/v1/projects/12/preview-errors",
    ]);
  });
});

describe("projects search + moderation", () => {
  it("listProjects encodes limit/cursor/visibility/q and listAll chains q", async () => {
    let seenUrl = "";
    const single = stubFetch((url) => {
      seenUrl = url;
      return json({ data: [], next_cursor: null });
    });
    await authed(single).listProjects({ limit: 5, visibility: "all", q: "timer", cursor: "c0" });
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("q"), "timer");
    assert.equal(u.searchParams.get("visibility"), "all");
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(u.searchParams.get("cursor"), "c0");

    const pages = [
      { data: [{ id: 1, name: "a", created_at: "x" }], next_cursor: "c" },
      { data: [{ id: 2, name: "b", created_at: "x" }], next_cursor: null },
    ];
    const paged = stubFetch(() => json(pages.shift()));
    const all = await authed(paged).listAllProjects({ visibility: "all", q: "timer" });
    assert.deepEqual(all.map((p) => p.id), [1, 2]);
  });

  it("listExploreProjects shim delegates to /projects with visibility=all", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = String(url);
      return json({ data: [], next_cursor: null });
    });
    await authed(fetchFn).listExploreProjects({ q: "timer" });
    const u = new URL(seenUrl);
    assert.ok(u.pathname.endsWith("/v1/projects"), seenUrl);
    assert.equal(u.searchParams.get("visibility"), "all");
    assert.equal(u.searchParams.get("q"), "timer");
  });

  it("createReport POSTs /reports and blockUser POSTs /blocks", async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push(String(url));
      assert.equal(init?.method, "POST");
      return json({ ok: true }, 201);
    });
    const client = authed(fetchFn);
    await client.createReport({ reported_project_id: 1, reason: "spam" });
    await client.blockUser({ blocked_id: "00000000-0000-4000-8000-000000000000" });
    assert.ok(seen[0]!.endsWith("/v1/reports"));
    assert.ok(seen[1]!.endsWith("/v1/blocks"));
  });
});

describe("github + supabase integrations", () => {
  it("github token/installations/repositories/link", async () => {
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith("/github/token")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { code: "c" });
        return json({ access_token: "ghu_x" });
      }
      if (u.endsWith("/github/installations")) return json({ data: [{ id: 7 }] });
      if (u.endsWith("/github/repositories") && (init?.method ?? "GET") === "GET") {
        return json({ data: [] });
      }
      assert.deepEqual(JSON.parse(String(init?.body)), { project_id: 1, github_installation_id: 7 });
      return json({ project_id: 1, github_installation_id: 7 }, 201);
    });
    const client = authed(fetchFn);
    assert.equal((await client.exchangeGithubToken({ code: "c" })).access_token, "ghu_x");
    assert.equal((await client.listGithubInstallations()).data[0]?.id, 7);
    assert.deepEqual((await client.listGithubRepositories()).data, []);
    assert.equal((await client.linkGithubRepository({ project_id: 1, github_installation_id: 7 })).project_id, 1);
  });

  it("supabase authorizations/projects/link/connection", async () => {
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith("/integrations/supabase/authorizations")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { code_challenge: "ch" });
        return json({ authorize_url: "https://x/auth", return_url: "michelangelo://supabase-connected" });
      }
      if (u.endsWith("/integrations/supabase/projects")) return json({ projects: [] });
      if (u.endsWith("/integrations/supabase/links")) {
        assert.equal(init?.method, "POST");
        return json({ project_id: 1, ref: "ref" }, 201);
      }
      assert.ok(u.endsWith("/integrations/supabase/connection"), u);
      return json({ connected: false });
    });
    const client = authed(fetchFn);
    const auth = await client.createSupabaseAuthorization({ code_challenge: "ch" });
    assert.ok(auth.authorize_url.startsWith("https://"));
    // deprecated alias delegates to the renamed endpoint
    const legacy = await client.startSupabaseOAuth({ code_challenge: "ch" });
    assert.ok(legacy.authorize_url.startsWith("https://"));
    assert.deepEqual(await client.listSupabaseProjects(), { projects: [] });
    assert.deepEqual(await client.linkSupabaseProject({ project_id: 1, supabase_ref: "ref" }), {
      project_id: 1,
      ref: "ref",
    });
    assert.equal((await client.getSupabaseConnection()).connected, false);
  });
});

describe("wallets + usage", () => {
  it("getMyWallet and listMyTransactions paginate", async () => {
    const fetchFn = stubFetch((url) => {
      const u = String(url);
      if (u.endsWith("/wallets/me")) {
        return json({
          balance: 1010,
          currency: "eur",
          balance_eur: "10.10",
          display_balance: "10,10 €",
        });
      }
      if (u.includes("/wallets/me/transactions")) {
        const parsed = new URL(u);
        if (parsed.searchParams.get("cursor") === "c1") {
          return json({ data: [{ id: "t2", metadata: { display_cost: "1,05 €" } }], next_cursor: null });
        }
        return json({ data: [{ id: "t1", metadata: { display_cost: "0,50 €" } }], next_cursor: "c1" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const client = authed(fetchFn);
    const wallet = await client.getMyWallet();
    assert.equal(wallet.balance, 1010);
    assert.equal(wallet.display_balance, "10,10 €");
    assert.equal(wallet.balance_eur, "10.10");
    const page = await client.listMyTransactions({ limit: 1 });
    assert.equal(page.data[0]?.id, "t1");
    assert.equal((page.data[0]?.metadata as Record<string, unknown>)?.display_cost, "0,50 €");
    const all = await client.listAllMyTransactions({ limit: 1 });
    assert.deepEqual(all.map((t) => t.id), ["t1", "t2"]);
  });

  it("usage summary/contributions/insights encode query", async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch((url) => {
      seen.push(String(url));
      const u = String(url);
      if (u.includes("/usage/summary")) return json({ run_count: 3 });
      if (u.includes("/usage/contributions")) return json({ data: [] });
      return json({ lines_of_code: 1 });
    });
    const client = authed(fetchFn);
    assert.equal((await client.getUsageSummary({ period: "month" })).run_count, 3);
    assert.deepEqual((await client.getUsageContributions({ start_date: "2026-01-01T00:00:00Z" })).data, []);
    assert.equal((await client.getUsageInsights()).lines_of_code, 1);
    assert.ok(seen[0]!.includes("period=month"), seen[0]);
    assert.ok(seen[1]!.includes("start_date="), seen[1]);
    assert.ok(seen[2]!.includes("timezone=UTC"), seen[2]);
  });
});

describe("notifications + push tokens", () => {
  it("list/getUnread/markRead/register/remove", async () => {
    let deleteUrl = "";
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/notifications?limit=20")) return json({ data: [{ id: "n1" }], next_cursor: null });
      if (u.endsWith("/notifications/unread-count")) return json({ unread_count: 2 });
      if (u.includes("/notifications/") && method === "PATCH") {
        assert.deepEqual(JSON.parse(String(init?.body)), { is_read: true });
        return json({ id: "n1", is_read: true });
      }
      if (u.endsWith("/push-tokens") && method === "POST") {
        assert.deepEqual(JSON.parse(String(init?.body)), { token: "ExponentPushToken[x]", device_type: "ios" });
        return json({ token: "ExponentPushToken[x]", device_type: "ios" }, 201);
      }
      if (u.includes("/push-tokens/") && method === "DELETE") {
        deleteUrl = u;
        assert.equal(init?.body, undefined);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${u}`);
    });
    const client = authed(fetchFn);
    assert.equal((await client.listNotifications()).data[0]?.id, "n1");
    assert.equal((await client.getUnreadCount()).unread_count, 2);
    assert.equal((await client.markNotificationRead("n1")).is_read, true);
    const reg = await client.registerPushToken({ token: "ExponentPushToken[x]", device_type: "ios" });
    assert.equal(reg.token, "ExponentPushToken[x]");
    assert.equal(await client.removePushToken("ExponentPushToken[x]"), undefined);
    assert.ok(deleteUrl.endsWith("/push-tokens/ExponentPushToken%5Bx%5D"), deleteUrl);
    // object form as well
    await client.removePushToken({ token: "ExponentPushToken[y]" });
    assert.ok(deleteUrl.endsWith("/push-tokens/ExponentPushToken%5By%5D"), deleteUrl);
  });

  it("markAllNotificationsRead PATCHes /notifications with { is_read: true }", async () => {
    let seen: { url: string; method?: string; body: unknown } | null = null;
    const fetchFn = stubFetch((url, init) => {
      seen = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
      return json({ updated_count: 7 });
    });
    const out = await authed(fetchFn).markAllNotificationsRead();
    assert.equal(out.updated_count, 7);
    assert.ok(seen!.url.endsWith("/v1/notifications"));
    assert.equal(seen!.method, "PATCH");
    assert.deepEqual(seen!.body, { is_read: true });
  });
});

describe("github + supabase unlink", () => {
  it("saveGithubInstallation POSTs /github/installations", async () => {
    let body: unknown = null;
    const fetchFn = stubFetch((url, init) => {
      assert.ok(String(url).endsWith("/v1/github/installations"));
      assert.equal(init?.method, "POST");
      body = JSON.parse(String(init?.body));
      return json({ id: 11, login: "octo" }, 201);
    });
    const out = await authed(fetchFn).saveGithubInstallation({ id: 11, ghu: "ghu_x", login: "octo" });
    assert.equal(out.login, "octo");
    assert.deepEqual(body, { id: 11, ghu: "ghu_x", login: "octo" });
  });

  it("unlinkGithubRepository DELETEs /github/repositories/{id} and resolves void on 204", async () => {
    let seen = "";
    const fetchFn = stubFetch((url, init) => {
      seen = String(url);
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    });
    assert.equal(await authed(fetchFn).unlinkGithubRepository(12), undefined);
    assert.ok(seen.endsWith("/v1/github/repositories/12"), seen);
  });

  it("unlinkSupabaseProject DELETEs /integrations/supabase/links/{id} and resolves void on 204", async () => {
    let seen = "";
    const fetchFn = stubFetch((url, init) => {
      seen = String(url);
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    });
    assert.equal(await authed(fetchFn).unlinkSupabaseProject(7), undefined);
    assert.ok(seen.endsWith("/v1/integrations/supabase/links/7"), seen);
  });
});

describe("prompt suggestions", () => {
  it("listPromptSuggestions encodes limit/mode/locale/category/shuffle", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = String(url);
      return json({ data: [{ id: "expense-tracker-it", prompt: "build an expense tracker", mode: "create", locale: "it", category: "finance" }] });
    });
    const page = await authed(fetchFn).listPromptSuggestions({ mode: "create", locale: "it", category: "finance", limit: 20 });
    assert.equal(page.data[0]?.id, "expense-tracker-it");
    assert.equal(page.data[0]?.mode, "create");
    const u = new URL(seenUrl);
    assert.ok(u.pathname.endsWith("/v1/prompt-suggestions"), seenUrl);
    assert.equal(u.searchParams.get("limit"), "20");
    assert.equal(u.searchParams.get("mode"), "create");
    assert.equal(u.searchParams.get("locale"), "it");
    assert.equal(u.searchParams.get("category"), "finance");
    assert.equal(u.searchParams.get("shuffle"), null);
  });

  it("listPromptSuggestions supports dice mode (shuffle + limit=1)", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = String(url);
      return json({ data: [{ id: "timer-en", prompt: "build a timer app", mode: "create", locale: "en", category: "productivity" }] });
    });
    const page = await authed(fetchFn).listPromptSuggestions({ shuffle: true, limit: 1 });
    assert.equal(page.data.length, 1);
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("shuffle"), "true");
    assert.equal(u.searchParams.get("limit"), "1");
    assert.equal(u.searchParams.get("mode"), null);
  });

  it("listPromptSuggestions filters edit ideas", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch((url) => {
      seenUrl = String(url);
      return json({ data: [{ id: "add-auth-en", prompt: "add login to this app", mode: "edit", locale: "en", category: "auth" }] });
    });
    const page = await authed(fetchFn).listPromptSuggestions({ mode: "edit", limit: 20 });
    assert.equal(page.data[0]?.mode, "edit");
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("mode"), "edit");
  });
});

describe("live activity tokens", () => {
  it("list/register/remove live-activity tokens", async () => {
    let deleteUrl = "";
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/live-activity/tokens") && method === "GET") {
        return json({ data: [{ push_to_start_token: "pts-x", is_active: true }] });
      }
      if (u.endsWith("/live-activity/tokens") && method === "POST") {
        assert.deepEqual(JSON.parse(String(init?.body)), { push_to_start_token: "pts-x" });
        return json({ push_to_start_token: "pts-x", is_active: true }, 201);
      }
      if (u.includes("/live-activity/tokens/") && method === "DELETE") {
        deleteUrl = u;
        assert.equal(init?.body, undefined);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${u}`);
    });
    const client = authed(fetchFn);
    assert.equal((await client.listLiveActivityTokens()).data[0]?.push_to_start_token, "pts-x");
    const reg = await client.registerLiveActivityToken({ push_to_start_token: "pts-x" });
    assert.equal(reg.push_to_start_token, "pts-x");
    assert.equal(await client.removeLiveActivityToken("pts-x"), undefined);
    assert.ok(deleteUrl.endsWith("/live-activity/tokens/pts-x"), deleteUrl);
    // object form as well
    await client.removeLiveActivityToken({ token: "pts-y" });
    assert.ok(deleteUrl.endsWith("/live-activity/tokens/pts-y"), deleteUrl);
  });

  it("register/remove live-activity update tokens", async () => {
    let deleteUrl = "";
    const jobId = "22222222-2222-4222-8222-222222222222";
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/live-activity/update-tokens") && method === "POST") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          job_id: jobId,
          update_token: "upd-x",
          activity_id: "act-1",
        });
        return json({ job_id: jobId, update_token: "upd-x", activity_id: "act-1" }, 201);
      }
      if (u.includes("/live-activity/update-tokens/") && method === "DELETE") {
        deleteUrl = u;
        assert.equal(init?.body, undefined);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${u}`);
    });
    const client = authed(fetchFn);
    const reg = await client.registerLiveActivityUpdateToken({
      job_id: jobId,
      update_token: "upd-x",
      activity_id: "act-1",
    });
    assert.equal(reg.job_id, jobId);
    assert.equal(reg.update_token, "upd-x");
    assert.equal(await client.removeLiveActivityUpdateToken(jobId), undefined);
    assert.ok(deleteUrl.endsWith(`/live-activity/update-tokens/${jobId}`), deleteUrl);
    // object form as well
    await client.removeLiveActivityUpdateToken({ job_id: jobId });
    assert.ok(deleteUrl.endsWith(`/live-activity/update-tokens/${jobId}`), deleteUrl);
  });
});
