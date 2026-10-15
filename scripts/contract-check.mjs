/**
 * Contract check: fails (exit 1) if the SDK defaults drift from the live swagger.
 * The swagger is the meeting point — `src/config.ts` + `src/types.ts` + `src/client.ts`
 * must track it. Run in CI and before releases:
 *
 *   npm run contract
 */
const LIVE_URL = "https://api.michelangelo.land/v1/openapi.json";

const EXPECTED = {
  apiBaseUrl: "https://api.michelangelo.land/v1",
  authorizationUrl: "https://auth.michelangelo.land/auth/v1/oauth/authorize",
  tokenUrl: "https://auth.michelangelo.land/auth/v1/oauth/token",
  operations: [
    "getHealth", "getOpenApiDocument", "getDocs", "getWhoami", "getMe",
    "updateMe", "deleteMe", "uploadMyAvatar", "getPublicProfile", "createJob", "uploadJobAttachments",
    "getJob", "listPromptSuggestions", "listProjects", "createProject", "createBillingCheckout",
    "handleBillingWebhook", "getProject", "updateProject", "deleteProject",
    "listProjectFiles", "saveProjectFiles", "generateProjectIcon", "pushProjectToGithub", "reshareProject",
    "listPreviewErrors", "drainPreviewErrors", "getProjectSupabaseLink",
    "createReport", "blockUser", "exchangeGithubToken", "listGithubInstallations",
    "saveGithubInstallation",
    "listGithubRepositories", "linkGithubRepository", "unlinkGithubRepository", "handleGithubWebhook",
    "createSupabaseAuthorization", "listSupabaseProjects", "linkSupabaseProject",
    "unlinkSupabaseProject",
    "getSupabaseConnection", "getMyWallet", "listMyTransactions", "getUsageSummary",
    "getUsageContributions",     "getUsageInsights", "listNotifications", "getUnreadCount",
    "markNotificationRead", "markAllNotificationsRead", "registerPushToken", "removePushToken",
  ],
  paths: [
    "/health", "/openapi.json", "/docs", "/whoami", "/me", "/me/avatar", "/users/{userId}",
    "/jobs", "/jobs/attachments", "/jobs/{jobId}", "/prompt-suggestions", "/projects",
    "/billing/checkouts", "/billing/webhooks", "/projects/{projectId}",
    "/projects/{projectId}/files", "/projects/{projectId}/icon",
    "/projects/{projectId}/pushes", "/projects/{projectId}/reshares", "/projects/{projectId}/preview-errors",
    "/projects/{projectId}/supabase-link", "/reports", "/blocks",
    "/github/token", "/github/installations", "/github/repositories", "/github/repositories/{projectId}",
    "/github/webhooks",
    "/integrations/supabase/authorizations", "/integrations/supabase/projects",
    "/integrations/supabase/links", "/integrations/supabase/links/{projectId}",
    "/integrations/supabase/connection",
    "/wallets/me", "/wallets/me/transactions", "/usage/summary", "/usage/contributions",
    "/usage/insights", "/notifications", "/notifications/unread-count",
    "/notifications/{notificationId}", "/push-tokens", "/push-tokens/{token}",
  ],
  // Client-covered operations. Deliberately skipped: getOpenApiDocument/getDocs
  // (meta) and handleBillingWebhook/handleGithubWebhook (signed server hooks).
  implementedBySdk: [
    "getHealth", "getWhoami", "getMe", "updateMe", "deleteMe", "uploadMyAvatar",
    "getPublicProfile",
    "createJob", "uploadJobAttachments", "getJob", "listPromptSuggestions", "listProjects", "createProject",
    "getProject", "updateProject", "deleteProject", "listProjectFiles", "saveProjectFiles",
    "generateProjectIcon", "pushProjectToGithub", "reshareProject", "listPreviewErrors",
    "drainPreviewErrors", "getProjectSupabaseLink",
    "createReport", "blockUser", "exchangeGithubToken",
    "listGithubInstallations", "listGithubRepositories", "linkGithubRepository",
    "createSupabaseAuthorization", "listSupabaseProjects", "linkSupabaseProject",
    "getSupabaseConnection", "getMyWallet", "listMyTransactions", "getUsageSummary",
    "getUsageContributions", "getUsageInsights", "listNotifications", "getUnreadCount",
    "markNotificationRead", "markAllNotificationsRead", "registerPushToken", "removePushToken",
    "createBillingCheckout", "saveGithubInstallation", "unlinkGithubRepository",
    "unlinkSupabaseProject",
  ],
  skippedByDesign: [
    "getOpenApiDocument", "getDocs", "handleBillingWebhook", "handleGithubWebhook",
  ],
};

const failures = [];

const res = await fetch(LIVE_URL);
if (!res.ok) {
  console.error(`contract: cannot fetch ${LIVE_URL}: HTTP ${res.status}`);
  process.exit(1);
}
const doc = await res.json();

const servers = (doc.servers ?? []).map((s) => s.url);
if (!servers.includes(EXPECTED.apiBaseUrl)) {
  failures.push(`servers[] missing ${EXPECTED.apiBaseUrl} (got: ${servers.join(", ")})`);
}

const flows = doc.components?.securitySchemes?.oauth2?.flows?.authorizationCode ?? {};
for (const key of ["authorizationUrl", "tokenUrl"]) {
  if (flows[key] !== EXPECTED[key]) {
    failures.push(`oauth2 flow ${key}: expected ${EXPECTED[key]}, got ${flows[key]}`);
  }
}

const liveOps = [];
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  for (const op of Object.values(item)) liveOps.push(op.operationId);
}
for (const op of EXPECTED.operations) {
  if (!liveOps.includes(op)) failures.push(`operation missing from swagger: ${op}`);
}
for (const p of EXPECTED.paths) {
  if (!doc.paths?.[p]) failures.push(`path missing from swagger: ${p}`);
}

// Every operation the SDK claims must exist in the swagger…
for (const op of EXPECTED.implementedBySdk) {
  const path = Object.entries(doc.paths ?? {}).find(([, item]) =>
    Object.values(item).some((o) => o.operationId === op),
  )?.[0];
  if (!path) failures.push(`SDK-covered operation vanished from swagger: ${op}`);
}
// …and every swagger operation must be a conscious choice (covered or skipped).
for (const op of liveOps) {
  if (!EXPECTED.implementedBySdk.includes(op) && !EXPECTED.skippedByDesign.includes(op)) {
    failures.push(`swagger operation not tracked by SDK contract: ${op}`);
  }
}

if (failures.length > 0) {
  console.error("contract FAILED — swagger drifted from SDK expectations:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`contract OK — ${liveOps.length} operations, SDK covers: ${EXPECTED.implementedBySdk.join(", ")}`);
