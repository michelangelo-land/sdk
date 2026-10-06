/**
 * PKCE helpers (RFC 7636, S256 mandatory).
 *
 * Default implementation uses WebCrypto — works on Node 18+, Bun and browsers.
 * On runtimes without WebCrypto (e.g. Hermes / React Native), inject an
 * adapter instead — see `expoCryptoAdapter` in the README (built on
 * `expo-crypto`'s `getRandomBytes` + `digest`):
 *
 *   import { setPkceCrypto } from "@michelangelo-land/sdk";
 *   setPkceCrypto(myAdapter); // global, or pass `pkceCrypto` per AuthManager
 */

/** Pluggable randomness + SHA-256 behind PKCE generation. */
export interface PkceCrypto {
  randomBytes(size: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

let globalOverride: PkceCrypto | null = null;

/** Process-wide PKCE backend (e.g. call once at app startup on Expo). */
export function setPkceCrypto(crypto: PkceCrypto | null): void {
  globalOverride = crypto;
}

function webCryptoBackend(): PkceCrypto {
  const g = globalThis.crypto as Crypto | undefined;
  if (!g?.getRandomValues || !g.subtle?.digest) {
    throw new Error(
      "WebCrypto unavailable in this runtime (crypto.getRandomValues/subtle.digest missing)." +
        " Inject a backend via setPkceCrypto() or the AuthManager `pkceCrypto` option" +
        " — e.g. the expo-crypto adapter documented in the README.",
    );
  }
  return {
    randomBytes: (size: number) => {
      const bytes = new Uint8Array(size);
      g.getRandomValues(bytes);
      return bytes;
    },
    sha256: async (data: Uint8Array) => new Uint8Array(await g.subtle.digest("SHA-256", data as BufferSource)),
  };
}

function resolve(impl?: PkceCrypto): PkceCrypto {
  return impl ?? globalOverride ?? webCryptoBackend();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** High-entropy `code_verifier`: 64 random bytes → 86 base64url chars (range 43–128). */
export function generateCodeVerifier(impl?: PkceCrypto): string {
  return base64UrlEncode(resolve(impl).randomBytes(64));
}

/** `code_challenge = BASE64URL(SHA256(code_verifier))`. */
export async function generateCodeChallenge(verifier: string, impl?: PkceCrypto): Promise<string> {
  const digest = await resolve(impl).sha256(new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/** Opaque `state` (CSRF protection). */
export function generateState(impl?: PkceCrypto): string {
  return base64UrlEncode(resolve(impl).randomBytes(16));
}
