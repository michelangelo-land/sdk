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
| jobs | `createJob` `POST /jobs` | `client.createJob()` → 202 row (200 on idempotent replay; 409 `job_already_active` when one is already queued/running — `err.activeJobId()` gives the id to poll) | Bearer required |
| jobs | `uploadJobAttachments` `POST /jobs/attachments` (multipart, ≤3 images) | `client.uploadJobAttachments({ files, idempotencyKey })` or `FormData` | Bearer required |
| jobs | `getJob` `GET /jobs/{jobId}` | `client.getJob()` / `client.waitForJob()` (retries transient network/502/429 with backoff; row carries `estimated_duration_seconds` + `queue_position`) | Bearer required |
| jobs | `getActiveJob` `GET /jobs/active` | `client.getActiveJob()` → active row or 404 (cold start / after 409) | Bearer required |
| jobs | `listPromptSuggestions` `GET /prompt-suggestions` | `client.listPromptSuggestions({ mode: "create", locale: "it", limit: 20 })` / `{ mode: "edit", shuffle: true, limit: 1 }` for dice | Bearer required |
| projects | `listProjects` `GET /projects` | `client.listProjects({ visibility: "all", q, owner })` / `client.listAllProjects()` (`owner` = one user's shared projects, no feed download) | Bearer required |
| projects | `createProject` `POST /projects` | `client.createProject({ name })` → 201 | Bearer required |
| projects | `getProject` `GET /projects/{id}` | `client.getProject()` | Bearer required |
| projects | `updateProject` `PATCH /projects/{id}` | `client.updateProject(id, { name, shared })` (icon is server-managed via `…/icon`) | Bearer required |
| projects | `deleteProject` `DELETE /projects/{id}` | `client.deleteProject()` → void (204) | Bearer required |
| projects | `listProjectFiles` `GET /projects/{id}/files` | `client.listProjectFiles(id, { type: "CODE" })` | Bearer required |
| projects | `saveProjectFiles` `PUT /projects/{id}/files` | `client.saveProjectFiles(id, { files })` | Bearer required |
| projects | `generateProjectIcon` `POST /projects/{id}/icon` | `client.generateProjectIcon()` → `{ icon_url }` | Bearer required |
| projects | `pushProjectToGithub` `POST /projects/{id}/pushes` | `client.pushProjectToGithub(id)` → `{ pushed, commit_sha }` (sync, no polling) | Bearer required |
| projects | `reshareProject` `POST /projects/{id}/reshares` | `client.reshareProject(id, { platform })` | Bearer required |
| projects | `listPreviewErrors` `GET /projects/{id}/preview-errors` | `client.listPreviewErrors(id)` (pure read) | Bearer required |
| projects | `drainPreviewErrors` `DELETE /projects/{id}/preview-errors` | `client.drainPreviewErrors(id)` → `{ deleted_count }` | Bearer required |
| projects | `getProjectSupabaseLink` `GET /projects/{id}/supabase-link` | `client.getProjectSupabaseLink()` | Bearer required |
| moderation | `createReport` `POST /reports` | `client.createReport()` → 201 | Bearer required |
| moderation | `blockUser` `POST /blocks` | `client.blockUser({ blocked_id })` | Bearer required |
| github | `exchangeGithubToken` `POST /github/token` | `client.exchangeGithubToken({ code })` | Bearer required |
| github | `getGithubUser` `GET /github/user` | `client.getGithubUser()` → `{ login, avatar_url, name }` (server-side via stored token; 404 `not_connected` when unlinked) | Bearer required |
| github | `discoverGithubInstallations` `POST /github/discover` | `client.discoverGithubInstallations({ ghu })` → `{ installations }` (fresh token, used once, never stored — pre-store picker) | Bearer required |
| github | `listGithubInstallations` / `saveGithubInstallation` | `client.listGithubInstallations()` / `client.saveGithubInstallation({ id, ghu })` (`login/avatar/name` optional — fetched server-side when omitted) | Bearer required |
| github | `listGithubRepositories` / `linkGithubRepository` | `client.listGithubRepositories()` / `client.linkGithubRepository()` | Bearer required |
| github | `unlinkGithubRepository` `DELETE /github/repositories/{projectId}` | `client.unlinkGithubRepository(project_id)` → void (204) | Bearer required |
| integrations | `createSupabaseAuthorization` `POST /integrations/supabase/authorizations` | `client.createSupabaseAuthorization({ code_challenge })` → open `authorize_url` | Bearer required |
| integrations | `listSupabaseProjects` `GET /integrations/supabase/projects` | `client.listSupabaseProjects()` | Bearer required |
| integrations | `linkSupabaseProject` `POST /integrations/supabase/links` | `client.linkSupabaseProject({ project_id, supabase_ref })` | Bearer required |
| integrations | `unlinkSupabaseProject` `DELETE /integrations/supabase/links/{projectId}` | `client.unlinkSupabaseProject(project_id)` → void (204) | Bearer required |
| integrations | `getSupabaseConnection` `GET /integrations/supabase/connection` | `client.getSupabaseConnection()` | Bearer required |
| wallets | `getMyWallet` `GET /wallets/me` | `client.getMyWallet()` | Bearer required |
| wallets | `getWalletSummary` `GET /wallets/me/summary` | `client.getWalletSummary()` / `client.getCreditBalance()` → `{ balance, total_granted, total_used, display_* }` (one call, no ledger pagination) | Bearer required |
| wallets | `listMyTransactions` `GET /wallets/me/transactions` | `client.listMyTransactions()` / `client.listAllMyTransactions()` | Bearer required |
| usage | `getUsageSummary` `GET /usage/summary` | `client.getUsageSummary({ period: "month" })` | Bearer required |
| usage | `getUsageContributions` `GET /usage/contributions` | `client.getUsageContributions({ start_date, end_date })` | Bearer required |
| usage | `getUsageInsights` `GET /usage/insights` | `client.getUsageInsights({ timezone })` | Bearer required |
| notifications | `listNotifications` `GET /notifications` | `client.listNotifications()` (rows carry `sender_id` + `sender{username,avatar_url}` + `project_icon_url`) | Bearer required |
| notifications | `getUnreadCount` `GET /notifications/unread-count` | `client.getUnreadCount()` | Bearer required |
| notifications | `markNotificationRead` `PATCH /notifications/{id}` | `client.markNotificationRead(id)` | Bearer required |
| notifications | `markAllNotificationsRead` `PATCH /notifications` | `client.markAllNotificationsRead()` → `{ updated_count }` | Bearer required |
| notifications | `registerPushToken` `POST /push-tokens` | `client.registerPushToken({ token, device_type })` → 201 | Bearer required |
| notifications | `removePushToken` `DELETE /push-tokens/{token}` | `client.removePushToken(token)` → void (204) | Bearer required |
| live-activity | `listLiveActivityTokens` `GET /live-activity/tokens` | `client.listLiveActivityTokens()` | Bearer required |
| live-activity | `registerLiveActivityToken` `POST /live-activity/tokens` | `client.registerLiveActivityToken({ push_to_start_token })` → 201 | Bearer required |
| live-activity | `removeLiveActivityToken` `DELETE /live-activity/tokens/{token}` | `client.removeLiveActivityToken(token)` → void (204) | Bearer required |
| live-activity | `registerLiveActivityUpdateToken` `POST /live-activity/update-tokens` | `client.registerLiveActivityUpdateToken({ job_id, update_token })` → 201 | Bearer required |
| live-activity | `removeLiveActivityUpdateToken` `DELETE /live-activity/update-tokens/{jobId}` | `client.removeLiveActivityUpdateToken(job_id)` → void (204) | Bearer required |
| billing | `createBillingCheckout` `POST /billing/checkouts` | `client.createBillingCheckout()` → open `checkout_url` | Bearer required |

> Migration notes (0.14.0): new `GET /jobs/active` (`getActiveJob()` —
> cold start / after 409 `job_already_active`, whose id is also on
> `err.activeJobId()`), `GET /wallets/me/summary` (`getWalletSummary()` /
> `getCreditBalance()` alias — replaces ledger pagination for the budget
> bar), `GET /github/user` (`getGithubUser()` — replaces direct
> `api.github.com` fetches), `GET /projects?owner=` (`listProjects({ owner
> })` — foreign profiles without feed download), `estimated_duration_seconds`
> + `queue_position` on `Job` (indicative only), `sender_id` +
> `project_icon_url` on `Notification`, `waitForJob` retries transient
> network/502/429 with backoff (`retryNetworkErrors`/`maxNetworkRetries`),
> `onAuthStateChange()` listener (Supabase-style handle), `isUsernameTaken()`
> / `isNotConnected()` / `isNetworkError()` / `isRetryable()` error helpers,
> typed `SupabaseProject` rows, and attachment constants
> (`JOB_ATTACHMENT_MAX_COUNT/MAX_BYTES/ALLOWED_MIMES`,
> `isAllowedAttachmentMime()`).
>
> Migration notes (0.13.0): `POST /jobs` enforces a single active job per
> user — a second call while one is `queued`/`running` returns 409
> `job_already_active` (catch with `err.isJobAlreadyActive()` and poll the
> active job). `POST /live-activity/update-tokens` and the
> `LiveActivityUpdateToken` row lost `activity_id` — drop it from
> `registerLiveActivityUpdateToken()` calls.
>
> Migration notes (0.12.0): new `POST /live-activity/update-tokens` +
> `DELETE /live-activity/update-tokens/{jobId}`
> (`registerLiveActivityUpdateToken()` / `removeLiveActivityUpdateToken()`).
> After a remote start, report the per-activity token with the `job_id` from
> the start props — the server trigger reads this table (never `jobs.input`)
> to send `update`/`end` pushes.
>
> Migration notes (0.11.0): new `live-activity` tag — `GET|POST
> /live-activity/tokens` + `DELETE /live-activity/tokens/{token}`
> (`listLiveActivityTokens()` / `registerLiveActivityToken()` /
> `removeLiveActivityToken()`). Register the push-to-start token at
> login/onboarding and refresh it at every launch; the server starts the Live
> Activity via APNs when a job is inserted, even with the app closed.
> `POST /jobs` lost its per-job push fields — `expo_push_token`,
> `live_activity_token` and `live_activity_user` were removed from the swagger
> (push routing now uses the registered `push-tokens` / `live-activity/tokens`
> tables). They survive in the SDK only as the deprecated
> `DeprecatedJobPushFields` helper — the server ignores them if still sent.
>
> Migration notes (0.10.0): `GET /prompt-suggestions` gained `?mode=create|edit`
> and every `PromptSuggestion` now carries a required `mode`
> (`create` = new-app ideas, `edit` = modify-current-app ideas).
> Pass `mode` to `listPromptSuggestions()` to fetch one use case
> (omit for both).
>
> Migration notes (0.8.0): `GET /wallets/me` is now single-balance —
> `bonus_balance`, `bonus_expires_at`, `total` and `display_total` are gone.
> Bonus grants (`reason: "bonus"`) credit the same `balance` like a top-up.
> Render `wallet.display_balance` (was `display_total`); `balance` /
> `balance_eur` semantics unchanged.
>
> Migration notes (0.7.0): `GET /explore/projects` was removed — community
> search is `listProjects({ visibility: "all", q })` (`listExploreProjects*`
> remain as deprecated shims). `POST /integrations/supabase/login` was renamed
> to `POST /integrations/supabase/authorizations`
> (`createSupabaseAuthorization()`; `startSupabaseOAuth()` still works as a
> deprecated alias). `POST /jobs` is prompt-only — GitHub pushes are the sync
> `pushProjectToGithub()` (`POST …/pushes`), not a queued job. `PATCH
> /projects/{id}` no longer accepts `icon_url`, `GET …/preview-errors` lost
> `?consume=true` (use `drainPreviewErrors()`), `POST …/reshare` is now
> `POST …/reshares`, and the three DELETEs take a path id
> (`/github/repositories/{id}`, `/integrations/supabase/links/{id}`,
> `/push-tokens/{token}`) instead of a query/body. Job input `appName` is now
> `app_name` (both accepted by the client types, `app_name` is canonical).

Not covered on purpose: `getOpenApiDocument`/`getDocs` (meta) and
`handleBillingWebhook` (Stripe-signed server hook) / `handleGithubWebhook`
(HMAC-signed server hook).

```ts
// Async generation: create, then wait (backoff 2s → 30s, 10 min timeout).
// createJob throws 402 insufficient_credits when the overdraft floor is reached,
// 409 job_already_active when another job is still queued/running.
const job = await client.createJob({ type: "prompt", input: { prompt: "a timer app" } });
const done = await client.waitForJob(job.id, {
  onProgress: (j) => console.log(j.status),
});
if (done.status !== "succeeded") throw new Error(done.error?.message ?? done.status);

// GitHub push (project must be linked first) — sync, no polling:
await client.linkGithubRepository({ project_id: 12, github_installation_id: 34 });
const push = await client.pushProjectToGithub(12);
if (!push.pushed) console.log("nothing to push", push.commit_sha);

// Prompt with images: upload first, then attach the manifest.
const manifest = await client.uploadJobAttachments({ files: [imageBlob] });
await client.createJob({ type: "prompt", input: { prompt: "redesign this" }, attachments: manifest.attachments });

// Prompt with linked Supabase ref (folded into `input` server-side):
await client.createJob({
  type: "prompt",
  input: { prompt: "add auth" },
  supabase_project_ref: "abcxyz",
});

// Push routing: register once at launch, not per job (POST /jobs no longer
// takes expo_push_token / live_activity_* — the server reads these tables):
await client.registerPushToken({ token: expoPushToken, device_type: "ios" });
await client.registerLiveActivityToken({ push_to_start_token });
// After a remote start, bind the per-activity token to its job (job_id comes
// from the start props, token from getPushToken()/addPushTokenListener) so the
// server can send update/end pushes for that job:
await client.registerLiveActivityUpdateToken({ job_id: job.id, update_token });

// Author of a project (community cards show the `author` embed; `user_id` for the full hero):
const author = project.author; // { username, avatar_url } | null
const hero = await client.getPublicProfile(project.user_id!);

// Community feed: every page, one array (`visibility: "all"` + `q` search).
const projects = await client.listAllProjects({ visibility: "all" });
const feed = await client.listAllProjects({ visibility: "all", q: "timer" });

// Files round-trip + reshare + icon:
await client.saveProjectFiles(12, { files: [{ path: "App.tsx", contents: "...", type: "CODE" }] });
await client.reshareProject(12, { platform: "x" });
await client.generateProjectIcon(12);

// Wallet + usage + notifications (money in EUR-cent credits: 1 EUR = 100 credits,
// single balance — bonus grants credit the same balance, render display_*
// verbatim — never divide balance yourself):
const wallet = await client.getMyWallet();
console.log(wallet.display_balance); // e.g. "10,10 €"
const summary = await client.getUsageSummary({ period: "month" });
const { unread_count } = await client.getUnreadCount();
await client.registerPushToken({ token: expoPushToken, device_type: "ios" });

// Top-up: 1 EUR = 100 credits (1 credit = 1 EUR-cent), crediting happens in
// the webhook once paid. Small overdraft allowed: POST /jobs returns
// 402 insufficient_credits only once the floor is reached.
const co = await client.createBillingCheckout({ amount_eur: 20 }); // → 2000 credits
openBrowser(co.checkout_url);
```

Multipart on React Native: `Blob` construction differs on Hermes — pass a
prebuilt `FormData` instead (e.g. `form.append("file", { uri, name, type })`
for avatars, `form.append("files", …)` + optional `idempotency_key` for job
attachments). On Node/web a `Blob`/`File` (or `FormData`) works directly.

## Token expiry

Calls that fail with 401 refresh the access token from the in-memory
refresh token and retry once (disable with `new MichelangeloClient({
autoRefresh: false })`). If the refresh fails too, the original 401
surfaces — the session is dropped to anonymous only when the server
rejected the refresh token, never on a transport failure (the next call
then retries the refresh). Serial callers re-presenting a just-failed
token fail fast for 10s instead of hammering the token endpoint. If the
session is really dead, log in again via `loginWithLoopback()` (or the
browser flow).

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
