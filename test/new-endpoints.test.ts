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
});

describe("jobs (new)", () => {
  it("createJob supports the github-push variant", async () => {
    let body: unknown = null;
    const fetchFn = stubFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ id: "j-2", type: "github-push", status: "queued", created_at: "x" }, 202);
    });
    const job = await authed(fetchFn).createJob({ type: "github-push", project_id: 12 });
    assert.equal(job.type, "github-push");
    assert.deepEqual(body, { type: "github-push", project_id: 12 });
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

  it("icon / reshare / preview-errors / supabase-link", async () => {
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith("/icon")) {
        assert.equal(init?.method, "POST");
        return json({ icon_url: "https://cdn/i.png" });
      }
      if (u.endsWith("/reshare")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { platform: "x" });
        return json({ deduped: false }, 201);
      }
      if (u.includes("/preview-errors")) {
        assert.ok(u.endsWith("?consume=true"), u);
        return json({ data: [{ id: "e1", message: "boom" }] });
      }
      assert.ok(u.endsWith("/supabase-link"), u);
      return json({ project_id: 12, supabase_project_ref: "ref" });
    });
    const client = authed(fetchFn);
    assert.equal((await client.generateProjectIcon(12)).icon_url, "https://cdn/i.png");
    assert.deepEqual(await client.reshareProject(12, { platform: "x" }), { deduped: false });
    assert.equal((await client.listPreviewErrors(12, { consume: true })).data[0]?.id, "e1");
    assert.equal((await client.getProjectSupabaseLink(12)).supabase_project_ref, "ref");
  });
});

describe("explore + moderation", () => {
  it("listExploreProjects encodes limit/cursor/q and listAll chains", async () => {
    let seenUrl = "";
    const single = stubFetch((url) => {
      seenUrl = url;
      return json({ data: [], next_cursor: null });
    });
    await authed(single).listExploreProjects({ limit: 5, q: "timer", cursor: "c0" });
    const u = new URL(seenUrl);
    assert.equal(u.searchParams.get("q"), "timer");
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(u.searchParams.get("cursor"), "c0");

    const pages = [
      { data: [{ id: 1, name: "a", created_at: "x" }], next_cursor: "c" },
      { data: [{ id: 2, name: "b", created_at: "x" }], next_cursor: null },
    ];
    const paged = stubFetch(() => json(pages.shift()));
    const all = await authed(paged).listAllExploreProjects();
    assert.deepEqual(all.map((p) => p.id), [1, 2]);
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

  it("supabase login/projects/link/connection", async () => {
    const fetchFn = stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith("/integrations/supabase/login")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { code_challenge: "ch" });
        return json({ authorize_url: "https://x/auth", return_url: "michelangelo://supabase-connected" });
      }
      if (u.endsWith("/integrations/supabase/projects")) return json({ projects: [] });
      if (u.endsWith("/integrations/supabase/links")) {
        assert.equal(init?.method, "POST");
        return json({ linked: true }, 201);
      }
      assert.ok(u.endsWith("/integrations/supabase/connection"), u);
      return json({ connected: false });
    });
    const client = authed(fetchFn);
    const login = await client.startSupabaseOAuth({ code_challenge: "ch" });
    assert.ok(login.authorize_url.startsWith("https://"));
    assert.deepEqual(await client.listSupabaseProjects(), { projects: [] });
    assert.deepEqual(await client.linkSupabaseProject({ project_id: 1, supabase_ref: "ref" }), { linked: true });
    assert.equal((await client.getSupabaseConnection()).connected, false);
  });
});

describe("wallets + usage", () => {
  it("getMyWallet and listMyTransactions paginate", async () => {
    const fetchFn = stubFetch((url) => {
      const u = String(url);
      if (u.endsWith("/wallets/me")) return json({ balance: 10, bonus_balance: 0, total: 10 });
      if (u.includes("/wallets/me/transactions")) {
        const parsed = new URL(u);
        if (parsed.searchParams.get("cursor") === "c1") {
          return json({ data: [{ id: "t2" }], next_cursor: null });
        }
        return json({ data: [{ id: "t1" }], next_cursor: "c1" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const client = authed(fetchFn);
    assert.equal((await client.getMyWallet()).total, 10);
    const page = await client.listMyTransactions({ limit: 1 });
    assert.equal(page.data[0]?.id, "t1");
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
    let deleteBody: unknown = null;
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
        return json({ ok: true }, 201);
      }
      if (u.endsWith("/push-tokens") && method === "DELETE") {
        deleteBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${u}`);
    });
    const client = authed(fetchFn);
    assert.equal((await client.listNotifications()).data[0]?.id, "n1");
    assert.equal((await client.getUnreadCount()).unread_count, 2);
    assert.equal((await client.markNotificationRead("n1")).is_read, true);
    await client.registerPushToken({ token: "ExponentPushToken[x]", device_type: "ios" });
    assert.equal(await client.removePushToken("ExponentPushToken[x]"), undefined);
    assert.deepEqual(deleteBody, { token: "ExponentPushToken[x]" });
    // object form as well
    await client.removePushToken({ token: "ExponentPushToken[y]" });
    assert.deepEqual(deleteBody, { token: "ExponentPushToken[y]" });
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

  it("unlinkGithubRepository DELETEs with project_id and resolves void on 204", async () => {
    let seen = "";
    const fetchFn = stubFetch((url, init) => {
      seen = String(url);
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    });
    assert.equal(await authed(fetchFn).unlinkGithubRepository(12), undefined);
    assert.ok(seen.includes("/v1/github/repositories?"), seen);
    assert.ok(seen.includes("project_id=12"), seen);
  });

  it("unlinkSupabaseProject DELETEs with project_id and resolves void on 204", async () => {
    let seen = "";
    const fetchFn = stubFetch((url, init) => {
      seen = String(url);
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    });
    assert.equal(await authed(fetchFn).unlinkSupabaseProject(7), undefined);
    assert.ok(seen.includes("/v1/integrations/supabase/links?"), seen);
    assert.ok(seen.includes("project_id=7"), seen);
  });
});
