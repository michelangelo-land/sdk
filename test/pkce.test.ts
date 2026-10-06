import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AuthManager } from "../src/auth.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  type PkceCrypto,
} from "../src/pkce.js";

// Deterministic stand-in for expo-crypto (getRandomBytes + digest) on Hermes.
const stubCrypto: PkceCrypto = {
  randomBytes: (size: number) => new Uint8Array(Array.from({ length: size }, (_, i) => i % 256)),
  sha256: async (data: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(data).digest()),
};

describe("pkce", () => {
  it("verifier is 86 base64url chars (64 bytes, within 43–128)", () => {
    const v = generateCodeVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{86}$/);
  });

  it("challenge matches RFC 7636 appendix B vector", async () => {
    // verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const challenge = await generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("state is a non-empty base64url string", () => {
    assert.match(generateState(), /^[A-Za-z0-9_-]+$/);
  });

  it("accepts an injected backend (expo-crypto shape) with identical vectors", async () => {
    const verifier = generateCodeVerifier(stubCrypto);
    assert.match(verifier, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(
      await generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", stubCrypto),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("AuthManager uses the injected backend for beginLogin", async () => {
    const auth = new AuthManager({ clientId: "c", pkceCrypto: stubCrypto });
    const { url } = await auth.beginLogin({ redirectUri: "http://127.0.0.1:1/callback" });
    const u = new URL(url);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.match(u.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  });
});
