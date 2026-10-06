# @michelangelo-land/sdk

Official Michelangelo SDK (TypeScript, zero runtime dependencies).

Meeting point with the API: **the swagger** — [`GET /v1/openapi.json`](https://api.michelangelo.land/v1/openapi.json) (source file: `Desktop/api/openapi/v1.yaml`).
`src/config.ts`, `src/types.ts` and `src/client.ts` track it; `npm run contract` fails if they drift.

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

| Swagger (`operationId`) | SDK | Auth |
|---|---|---|
| `getHealth` `GET /health` | `client.health()` | none (anonymous OK) |
| `getWhoami` `GET /whoami` | `client.whoami()` | Bearer required |
| `createJob` / `getJob` / `listProjects` / `getProject` | next iteration (tracked by `npm run contract`) | Bearer required |

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
npm version 0.2.0 && git push origin main v0.2.0
```

One-time bootstrap (npm org owner, on npmjs.com): open the
`@michelangelo-land/sdk` package → Settings → Trusted Publisher → add repo
`michelangelo-land/sdk`, workflow `release.yml`. The very first version must be
published once by hand (`npm publish --access public` from an org member —
trusted publishing attaches to an existing package); every later release is
tag-driven with no long-lived token.
