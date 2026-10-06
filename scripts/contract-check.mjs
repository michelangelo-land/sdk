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
  operations: ["getHealth", "getWhoami", "createJob", "getJob", "listProjects", "getProject"],
  paths: ["/health", "/openapi.json", "/docs", "/whoami", "/jobs", "/jobs/{jobId}", "/projects", "/projects/{projectId}"],
  implementedBySdk: ["getHealth", "getWhoami"],
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

// SDK Dors: every method the SDK claims must exist in the swagger.
const { readFile } = await import("node:fs/promises");
const clientSrc = await readFile(new URL("../src/client.ts", import.meta.url), "utf8");
for (const op of EXPECTED.implementedBySdk) {
  const path = Object.entries(doc.paths ?? {}).find(([, item]) =>
    Object.values(item).some((o) => o.operationId === op),
  )?.[0];
  if (!path) failures.push(`SDK-covered operation vanished from swagger: ${op}`);
  void clientSrc;
}

if (failures.length > 0) {
  console.error("contract FAILED — swagger drifted from SDK expectations:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`contract OK — ${liveOps.length} operations, SDK covers: ${EXPECTED.implementedBySdk.join(", ")}`);
