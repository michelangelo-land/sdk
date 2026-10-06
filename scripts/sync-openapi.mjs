/**
 * Vendors the live swagger into `openapi/openapi.json` — the meeting point
 * between API and SDK. Run after any contract change:
 *
 *   npm run sync:openapi
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_URL = "https://api.michelangelo.land/v1/openapi.json";
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi", "openapi.json");

const res = await fetch(LIVE_URL);
if (!res.ok) {
  console.error(`sync:openapi failed: HTTP ${res.status} ${LIVE_URL}`);
  process.exit(1);
}
const doc = await res.json();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n");

const paths = Object.keys(doc.paths ?? {});
const ops = paths.flatMap((p) => Object.values(doc.paths[p] ?? {}).map((op) => op.operationId));
console.log(`synced ${LIVE_URL} → openapi/openapi.json`);
console.log(`paths (${paths.length}): ${paths.join(", ")}`);
console.log(`operations: ${ops.join(", ")}`);
