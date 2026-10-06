/**
 * Node login example: anonymous → loopback browser login → whoami.
 *
 *   npm run example:node-login
 *
 * Reuses a client id across runs via MICHELANGELO_CLIENT_ID to skip DCR.
 */
import { MichelangeloClient } from "../src/index.js";
import { loginWithLoopback } from "../src/node-loopback.js";

const client = new MichelangeloClient({
  clientId: process.env.MICHELANGELO_CLIENT_ID,
});

console.log(`anonymous: isAuthenticated=${client.auth.isAuthenticated()}`);
await client.health().then(
  (h) => console.log("health:", h),
  (err) => console.error("health failed:", err.message),
);

await loginWithLoopback(client, { clientName: "Michelangelo SDK example" });

console.log(`authenticated: isAuthenticated=${client.auth.isAuthenticated()}`);
const me = await client.whoami();
console.log("whoami:", me);
if (client.auth.getClientId()) {
  console.log(`\nSave MICHELANGELO_CLIENT_ID=${client.auth.getClientId()} to skip registration next time.`);
}
