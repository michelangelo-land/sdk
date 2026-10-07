# @michelangelo-land/sdk

Official Michelangelo SDK (TypeScript, zero runtime dependencies).

Meeting point with the API: **the swagger** — [`GET /v1/openapi.json`](https://api.michelangelo.land/v1/openapi.json) (vendored at `openapi/openapi.json`).
`src/config.ts`, `src/types.ts` and `src/client.ts` track it; `npm run contract` fails if they drift.
Interactive reference: [`GET /v1/docs`](https://api.michelangelo.land/v1/docs) (Scalar).

## Dynamic auth

The SDK is born **anonymous** and logs in via OAuth 2.1 + PKCE against
`auth.michelangelo.land`. Tokens live **only in memory** and are applied to
every subsequent call automatically.

```ts
import { MichelangeloClient } from "@michelangelo-land/sdk";

const client = new MichelangeloClient(); // anonymous
await client.health(); // public — works now

// 1. register once (DCR) — reuse the id via MICHELANGELO_CLIENT_ID afterwards
await client.auth.registerClient({
  client_name: "My App",
  redirect_uris: ["https://myapp.example.com/callback"],
});

// 2. browser step — open `url`, get back `?code=…` on your redirect_uri
const { url, codeVerifier } = await client.auth.beginLogin({
  redirectUri: "https://myapp.example.com/callback",
});

// 3. exchange — from here the token is in memory
await client.auth.exchangeCode({ code, codeVerifier, redirectUri });
await client.whoami(); // Authorization: Bearer … injected
client.auth.logout(); // back to anonymous
```

Node scripts can skip the manual steps:

```ts
import { loginWithLoopback } from "@michelangelo-land/sdk/node-loopback";
await loginWithLoopback(client); // ephemeral 127.0.0.1 server + browser + exchange
```

```bash
npm run example:node-login
```

## Endpoints (swagger → SDK)

| Tag | Swagger (`operationId`) | SDK | Auth |
|---|---|---|---|
| auth | `getHealth` `GET /health` | `client.health()` | none (anonymous OK) |
| auth | `getWhoami` `GET /whoami` | `client.whoami()` | Bearer required |
| users | `getMe` `GET /me` | `client.me(["username", "email"])` (sparse fieldsets) | Bearer required |
| users | `updateMe` `PATCH /me` | `client.updateMe({ username })` | Bearer required |
| users | `deleteMe` `DELETE /me` | `client.deleteMe()` → void (204) | Bearer required |
| users | `uploadMyAvatar` `POST /me/avatar` (multipart `file`) | `client.uploadMyAvatar(fileOrFormData)` → `{ avatar_url }` | Bearer required |
| users | `getPublicProfile` `GET /users/{userId}` | `client.getPublicProfile(userId)` → `{ id, username, avatar_url, is_supporter, … }` | Bearer required |
| jobs | `createJob` `POST /jobs` | `client.createJob()` → 202 row (200 on idempotent replay) | Bearer required |
| jobs | `uploadJobAttachments` `POST /jobs/attachments` (multipart, ≤3 images) | `client.uploadJobAttachments({ files, idempotencyKey })` or `FormData` | Bearer required |
| jobs | `getJob` `GET /jobs/{jobId}` | `client.getJob()` / `client.waitForJob()` | Bearer required |
| projects | `listProjects` `GET /projects` | `client.listProjects()` / `client.listAllProjects()` | Bearer required |
| projects | `createProject` `POST /projects` | `client.createProject({ name })` → 201 | Bearer required |
| projects | `getProject` `GET /projects/{id}` | `client.getProject()` | Bearer required |
| projects | `updateProject` `PATCH /projects/{id}` | `client.updateProject(id, { name, shared, icon_url })` | Bearer required |
| projects | `deleteProject` `DELETE /projects/{id}` | `client.deleteProject()` → void (204) | Bearer required |
| projects | `listProjectFiles` `GET /projects/{id}/files` | `client.listProjectFiles(id, { type: "CODE" })` | Bearer required |
| projects | `saveProjectFiles` `PUT /projects/{id}/files` | `client.saveProjectFiles(id, { files })` | Bearer required |
| projects | `generateProjectIcon` `POST /projects/{id}/icon` | `client.generateProjectIcon()` | Bearer required |
| projects | `reshareProject` `POST /projects/{id}/reshare` | `client.reshareProject(id, { platform })` | Bearer required |
| projects | `listPreviewErrors` `GET /projects/{id}/preview-errors` | `client.listPreviewErrors(id, { consume })` | Bearer required |
| projects | `getProjectSupabaseLink` `GET /projects/{id}/supabase-link` | `client.getProjectSupabaseLink()` | Bearer required |
| explore | `listExploreProjects` `GET /explore/projects` | `client.listExploreProjects({ q })` / `client.listAllExploreProjects()` | Bearer required |
| moderation | `createReport` `POST /reports` | `client.createReport()` → 201 | Bearer required |
| moderation | `blockUser` `POST /blocks` | `client.blockUser({ blocked_id })` | Bearer required |
| github | `exchangeGithubToken` `POST /github/token` | `client.exchangeGithubToken({ code })` | Bearer required |
| github | `listGithubInstallations` / `saveGithubInstallation` | `client.listGithubInstallations()` / `client.saveGithubInstallation({ id, ghu })` | Bearer required |
| github | `listGithubRepositories` / `linkGithubRepository` | `client.listGithubRepositories()` / `client.linkGithubRepository()` | Bearer required |
| github | `unlinkGithubRepository` `DELETE /github/repositories` | `client.unlinkGithubRepository(project_id)` → void (204) | Bearer required |
| integrations | `startSupabaseOAuth` `POST /integrations/supabase/login` | `client.startSupabaseOAuth({ code_challenge })` → open `authorize_url` | Bearer required |
| integrations | `listSupabaseProjects` `GET /integrations/supabase/projects` | `client.listSupabaseProjects()` | Bearer required |
| integrations | `linkSupabaseProject` `POST /integrations/supabase/links` | `client.linkSupabaseProject({ project_id, supabase_ref })` | Bearer required |
| integrations | `unlinkSupabaseProject` `DELETE /integrations/supabase/links` | `client.unlinkSupabaseProject(project_id)` → void (204) | Bearer required |
| integrations | `getSupabaseConnection` `GET /integrations/supabase/connection` | `client.getSupabaseConnection()` | Bearer required |
| wallets | `getMyWallet` `GET /wallets/me` | `client.getMyWallet()` | Bearer required |
| wallets | `listMyTransactions` `GET /wallets/me/transactions` | `client.listMyTransactions()` / `client.listAllMyTransactions()` | Bearer required |
| usage | `getUsageSummary` `GET /usage/summary` | `client.getUsageSummary({ period: "month" })` | Bearer required |
| usage | `getUsageContributions` `GET /usage/contributions` | `client.getUsageContributions({ start_date, end_date })` | Bearer required |
| usage | `getUsageInsights` `GET /usage/insights` | `client.getUsageInsights({ timezone })` | Bearer required |
| notifications | `listNotifications` `GET /notifications` | `client.listNotifications()` | Bearer required |
| notifications | `getUnreadCount` `GET /notifications/unread-count` | `client.getUnreadCount()` | Bearer required |
| notifications | `markNotificationRead` `PATCH /notifications/{id}` | `client.markNotificationRead(id)` | Bearer required |
| notifications | `markAllNotificationsRead` `PATCH /notifications` | `client.markAllNotificationsRead()` → `{ updated_count }` | Bearer required |
| notifications | `registerPushToken` `POST /push-tokens` | `client.registerPushToken({ token, device_type })` → 201 | Bearer required |
| notifications | `removePushToken` `DELETE /push-tokens` | `client.removePushToken(token)` → void (204) | Bearer required |
| billing | `createBillingCheckout` `POST /billing/checkouts` | `client.createBillingCheckout()` → open `checkout_url` | Bearer required |

Not covered on purpose: `getOpenApiDocument`/`getDocs` (meta) and
`handleBillingWebhook` (Stripe-signed server hook) / `handleGithubWebhook`
(HMAC-signed server hook).

```ts
// Async generation: create, then wait (backoff 2s → 30s, 10 min timeout).
const job = await client.createJob({ type: "prompt", input: { prompt: "a timer app" } });
const done = await client.waitForJob(job.id, {
  onProgress: (j) => console.log(j.status),
});
if (done.status !== "succeeded") throw new Error(done.error?.message ?? done.status);

// GitHub push job (project must be linked first):
await client.linkGithubRepository({ project_id: 12, github_installation_id: 34 });
const push = await client.createJob({ type: "github-push", project_id: 12 });

// Prompt with images: upload first, then attach the manifest.
const manifest = await client.uploadJobAttachments({ files: [imageBlob] });
await client.createJob({ type: "prompt", input: { prompt: "redesign this" }, attachments: manifest.attachments });

// Prompt with Live Activity + linked Supabase ref (folded into `input` server-side):
await client.createJob({
  type: "prompt",
  input: { prompt: "add auth" },
  live_activity_token,
  live_activity_user,
  supabase_project_ref: "abcxyz",
});

// Author of a project (explore feed shows the `author` embed; `user_id` for the full hero):
const author = project.author; // { username, avatar_url } | null
const hero = await client.getPublicProfile(project.user_id!);

// Community feed: every page, one array.
const projects = await client.listAllProjects({ visibility: "all" });
const feed = await client.listAllExploreProjects({ q: "timer" });

// Files round-trip + reshare + icon:
await client.saveProjectFiles(12, { files: [{ path: "App.tsx", contents: "...", type: "CODE" }] });
await client.reshareProject(12, { platform: "x" });
await client.generateProjectIcon(12);

// Wallet + usage + notifications:
const wallet = await client.getMyWallet();
const summary = await client.getUsageSummary({ period: "month" });
const { unread_count } = await client.getUnreadCount();
await client.registerPushToken({ token: expoPushToken, device_type: "ios" });

// Top-up: 1 EUR = 1 credit, crediting happens in the webhook once paid.
const co = await client.createBillingCheckout({ amount_eur: 20 });
openBrowser(co.checkout_url);
```

Multipart on React Native: `Blob` construction differs on Hermes — pass a
prebuilt `FormData` instead (e.g. `form.append("file", { uri, name, type })`
for avatars, `form.append("files", …)` + optional `idempotency_key` for job
attachments). On Node/web a `Blob`/`File` (or `FormData`) works directly.

## Token expiry

Calls that fail with 401 refresh the access token from the in-memory
refresh token and retry once (disable with `new MichelangeloClient({
autoRefresh: false })`). If the refresh fails too, the SDK drops to
anonymous and the 401 surfaces — call `loginWithLoopback()` (or the browser
flow) again.

## Expo / React Native (Hermes)

Hermes has no `crypto.subtle`, so inject the `expo-crypto` backend once at
startup — the app already depends on `expo-crypto`:

```ts
import { digest, getRandomBytes, CryptoDigestAlgorithm } from "expo-crypto";
import { setPkceCrypto } from "@michelangelo-land/sdk";

setPkceCrypto({
  randomBytes: (size) => getRandomBytes(size),
  sha256: async (data) => {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, copy));
  },
});
```

(`digest` accepts a `BufferSource`; a `Uint8Array` qualifies.) Alternatively pass
`pkceCrypto` per-client via `new MichelangeloClient({ pkceCrypto })`. Do **not**
import `@michelangelo-land/sdk/node-loopback` in app bundles — it needs
`node:http` and is excluded from the Metro graph as long as it stays
unimported (the `react-native` export condition maps the core entry only).

## Scripts

- `npm run sync:openapi` — vendor the live swagger to `openapi/openapi.json`
- `npm run contract` — fail if SDK defaults drift from the live swagger (run in CI)
- `npm run type-check` / `npm run build` / `npm test`

## Publishing (trusted publishing, no npm token)

Releases are cut by pushing a tag — `.github/workflows/release.yml` runs
type-check, tests, contract check and `npm publish --provenance`:

```bash
npm version 0.3.0 && git push origin main v0.3.0
```

One-time bootstrap (npm org owner, on npmjs.com): open the
`@michelangelo-land/sdk` package → Settings → Trusted Publisher → add repo
`michelangelo-land/sdk`, workflow `release.yml`. The very first version must be
published once by hand (`npm publish --access public` from an org member —
trusted publishing attaches to an existing package); every later release is
tag-driven with no long-lived token.
