/**
 * Contract check: fails (exit 1) if the SDK expectations drift from either
 * the vendored swagger (`openapi/openapi.json`) or the live document.
 *
 *   npm run contract              # live + vendored (needs network)
 *   npm run contract -- --offline # vendored only (CI without network)
 *   CONTRACT_OFFLINE=1 npm run contract
 *
 * The vendored file is part of the package and must track EXPECTED paths +
 * operationIds; the live check is the final gate before a release. Operations
 * listed in PENDING_DEPLOY are expected to appear only after the next API
 * deploy: offline warns instead of failing, the live check still fails until
 * the API ships them (then re-run `npm run sync:openapi`).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_URL = "https://api.michelangelo.land/v1/openapi.json";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED_PATH = join(root, "openapi", "openapi.json");

const OFFLINE =
  process.argv.includes("--offline") ||
  process.env.CONTRACT_OFFLINE === "1" ||
  process.env.CONTRACT_OFFLINE === "true";

const EXPECTED = {
  apiBaseUrl: "https://api.michelangelo.land/v1",
  authorizationUrl: "https://auth.michelangelo.land/auth/v1/oauth/authorize",
  tokenUrl: "https://auth.michelangelo.land/auth/v1/oauth/token",
  operations: [
    "getHealth", "getOpenApiDocument", "getDocs", "getWhoami", "getMe",
    "updateMe", "deleteMe", "uploadMyAvatar", "getPublicProfile", "createJob", "uploadJobAttachments",
    "getJob", "getActiveJob", "listPromptSuggestions", "listProjects", "createProject", "createBillingCheckout",
    "handleBillingWebhook", "getProject", "updateProject", "deleteProject",
    "listProjectFiles", "saveProjectFiles", "generateProjectIcon", "pushProjectToGithub", "reshareProject",
    "listPreviewErrors", "drainPreviewErrors", "getProjectSupabaseLink",
    "createReport", "blockUser", "exchangeGithubToken", "getGithubUser", "discoverGithubInstallations", "listGithubInstallations",
    "saveGithubInstallation",
    "listGithubRepositories", "linkGithubRepository", "unlinkGithubRepository", "handleGithubWebhook",
    "createSupabaseAuthorization", "listSupabaseProjects", "linkSupabaseProject",
    "unlinkSupabaseProject",
    "getSupabaseConnection", "disconnectSupabaseConnection", "getMyWallet", "getWalletSummary", "listMyTransactions", "getUsageSummary",
    "getUsageContributions",     "getUsageInsights", "listNotifications", "getUnreadCount",
    "markNotificationRead", "markAllNotificationsRead", "registerPushToken", "removePushToken",
    "listLiveActivityTokens", "registerLiveActivityToken", "removeLiveActivityToken",
    "registerLiveActivityUpdateToken", "removeLiveActivityUpdateToken",
  ],
  paths: [
    "/health", "/openapi.json", "/docs", "/whoami", "/me", "/me/avatar", "/users/{userId}",
    "/jobs", "/jobs/active", "/jobs/attachments", "/jobs/{jobId}", "/prompt-suggestions", "/projects",
    "/billing/checkouts", "/billing/webhooks", "/projects/{projectId}",
    "/projects/{projectId}/files", "/projects/{projectId}/icon",
    "/projects/{projectId}/pushes", "/projects/{projectId}/reshares", "/projects/{projectId}/preview-errors",
    "/projects/{projectId}/supabase-link", "/reports", "/blocks",
    "/github/token", "/github/user", "/github/discover", "/github/installations", "/github/repositories", "/github/repositories/{projectId}",
    "/github/webhooks",
    "/integrations/supabase/authorizations", "/integrations/supabase/projects",
    "/integrations/supabase/links", "/integrations/supabase/links/{projectId}",
    "/integrations/supabase/connection",
    "/wallets/me", "/wallets/me/summary", "/wallets/me/transactions", "/usage/summary", "/usage/contributions",
    "/usage/insights", "/notifications", "/notifications/unread-count",
    "/notifications/{notificationId}", "/push-tokens", "/push-tokens/{token}",
    "/live-activity/tokens", "/live-activity/tokens/{token}",
    "/live-activity/update-tokens", "/live-activity/update-tokens/{jobId}",
  ],
  // Client-covered operations. Deliberately skipped: getOpenApiDocument/getDocs
  // (meta) and handleBillingWebhook/handleGithubWebhook (signed server hooks).
  implementedBySdk: [
    "getHealth", "getWhoami", "getMe", "updateMe", "deleteMe", "uploadMyAvatar",
    "getPublicProfile",
    "createJob", "uploadJobAttachments", "getJob", "getActiveJob", "listPromptSuggestions", "listProjects", "createProject",
    "getProject", "updateProject", "deleteProject", "listProjectFiles", "saveProjectFiles",
    "generateProjectIcon", "pushProjectToGithub", "reshareProject", "listPreviewErrors",
    "drainPreviewErrors", "getProjectSupabaseLink",
    "createReport", "blockUser", "exchangeGithubToken", "getGithubUser", "discoverGithubInstallations",
    "listGithubInstallations", "listGithubRepositories", "linkGithubRepository",
    "createSupabaseAuthorization", "listSupabaseProjects", "linkSupabaseProject",
    "getSupabaseConnection", "disconnectSupabaseConnection",
    "getMyWallet", "getWalletSummary", "listMyTransactions", "getUsageSummary",
    "getUsageContributions", "getUsageInsights", "listNotifications", "getUnreadCount",
    "markNotificationRead", "markAllNotificationsRead", "registerPushToken", "removePushToken",
    "listLiveActivityTokens", "registerLiveActivityToken", "removeLiveActivityToken",
    "registerLiveActivityUpdateToken", "removeLiveActivityUpdateToken",
    "createBillingCheckout", "saveGithubInstallation", "unlinkGithubRepository",
    "unlinkSupabaseProject",
  ],
  skippedByDesign: [
    "getOpenApiDocument", "getDocs", "handleBillingWebhook", "handleGithubWebhook",
  ],
  // Approved by the lead but not deployed yet. Offline tolerates their
  // absence (warning); the live check fails until the API ships them.
  pendingDeploy: ["disconnectSupabaseConnection"],
};

function collectOperations(doc) {
  const operations = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const operation of Object.values(item ?? {})) {
      if (operation && typeof operation === "object" && typeof operation.operationId === "string") {
        operations.set(operation.operationId, path);
      }
    }
  }
  return operations;
}

function validate(doc, label, { allowPending }) {
  const failures = [];
  const warnings = [];
  const pending = new Set(EXPECTED.pendingDeploy);
  const operations = collectOperations(doc);
  const paths = Object.keys(doc.paths ?? {});

  const servers = (doc.servers ?? []).map((s) => s.url);
  if (!servers.includes(EXPECTED.apiBaseUrl)) {
    failures.push(`${label}: servers[] missing ${EXPECTED.apiBaseUrl} (got: ${servers.join(", ") || "none"})`);
  }

  const flows = doc.components?.securitySchemes?.oauth2?.flows?.authorizationCode ?? {};
  for (const key of ["authorizationUrl", "tokenUrl"]) {
    if (flows[key] !== EXPECTED[key]) {
      failures.push(`${label}: oauth2 flow ${key}: expected ${EXPECTED[key]}, got ${flows[key]}`);
    }
  }

  for (const op of EXPECTED.operations) {
    if (operations.has(op)) continue;
    if (allowPending && pending.has(op)) warnings.push(`${label}: operation pending API deploy: ${op}`);
    else failures.push(`${label}: operation missing: ${op}`);
  }
  for (const path of EXPECTED.paths) {
    if (!doc.paths?.[path]) failures.push(`${label}: path missing: ${path}`);
  }
  for (const path of paths) {
    if (!EXPECTED.paths.includes(path)) {
      failures.push(`${label}: unexpected path (add it to EXPECTED): ${path}`);
    }
  }

  // Every operation the SDK claims must exist in the document…
  for (const op of EXPECTED.implementedBySdk) {
    if (operations.has(op)) continue;
    if (allowPending && pending.has(op)) warnings.push(`${label}: SDK operation pending API deploy: ${op}`);
    else failures.push(`${label}: SDK-covered operation missing: ${op}`);
  }
  // …and every document operation must be a conscious choice (covered or skipped).
  for (const op of operations.keys()) {
    if (!EXPECTED.implementedBySdk.includes(op) && !EXPECTED.skippedByDesign.includes(op)) {
      failures.push(`${label}: operation not tracked by SDK contract: ${op}`);
    }
  }

  return { failures, warnings, operations, paths };
}

function compareVendoredToLive(vendored, live) {
  const failures = [];
  const vendoredPaths = [...vendored.paths].sort();
  const livePaths = [...live.paths].sort();
  const missingPaths = livePaths.filter((p) => !vendoredPaths.includes(p));
  const extraPaths = vendoredPaths.filter((p) => !livePaths.includes(p));
  if (missingPaths.length || extraPaths.length) {
    failures.push(
      `vendored openapi.json is stale — run \`npm run sync:openapi\`` +
        ` (paths missing: ${missingPaths.join(", ") || "none"};` +
        ` extra: ${extraPaths.join(", ") || "none"})`,
    );
  }

  const vendoredOps = [...vendored.operations.keys()].sort();
  const liveOps = [...live.operations.keys()].sort();
  const missingOps = liveOps.filter((op) => !vendoredOps.includes(op));
  const extraOps = vendoredOps.filter((op) => !liveOps.includes(op));
  if (missingOps.length || extraOps.length) {
    failures.push(
      `vendored openapi.json is stale — run \`npm run sync:openapi\`` +
        ` (operations missing: ${missingOps.join(", ") || "none"};` +
        ` extra: ${extraOps.join(", ") || "none"})`,
    );
  }

  return failures;
}

const failures = [];
const warnings = [];

let vendoredDoc;
try {
  vendoredDoc = JSON.parse(await readFile(VENDORED_PATH, "utf8"));
} catch (err) {
  console.error(`contract: cannot read ${VENDORED_PATH}: ${err.message}`);
  process.exit(1);
}

const vendored = validate(vendoredDoc, "vendored", { allowPending: true });
failures.push(...vendored.failures);
warnings.push(...vendored.warnings);

let liveOperationsCount = vendored.operations.size;
if (!OFFLINE) {
  let liveDoc;
  try {
    const res = await fetch(LIVE_URL);
    if (!res.ok) {
      console.error(`contract: cannot fetch ${LIVE_URL}: HTTP ${res.status}`);
      process.exit(1);
    }
    liveDoc = await res.json();
  } catch (err) {
    console.error(`contract: cannot fetch ${LIVE_URL}: ${err.message}`);
    console.error("contract: use --offline to validate only the vendored document");
    process.exit(1);
  }

  const live = validate(liveDoc, "live", { allowPending: false });
  failures.push(...live.failures);
  warnings.push(...live.warnings);
  liveOperationsCount = live.operations.size;
  failures.push(...compareVendoredToLive(vendored, live));
  console.log(`contract: checked live ${LIVE_URL}`);
} else {
  console.log("contract: offline mode — live swagger not fetched");
}

for (const warning of warnings) console.warn(`  ! ${warning}`);

if (failures.length > 0) {
  console.error("contract FAILED — swagger drifted from SDK expectations:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `contract OK — ${liveOperationsCount} operations, SDK covers: ${EXPECTED.implementedBySdk.join(", ")}`,
);
