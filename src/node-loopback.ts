/**
 * Node-only login helper (RFC 8252 loopback + platform bridge).
 *
 * Spins an ephemeral `http://127.0.0.1:<port>/callback` server, prints the
 * consent URL, waits for the `?code=` redirect and exchanges it — the session
 * ends up in the client's in-memory `auth`.
 *
 * Why ephemeral ports work: the auth proxy (`Desktop/auth src/routes/authProxy.ts`)
 * transparently bridges loopback redirects, so registering a single
 * `http://127.0.0.1/callback` URI via DCR covers any ephemeral port.
 *
 * Import from `@michelangelo-land/sdk/node-loopback` to keep the core
 * entrypoint runtime-agnostic (browser-safe).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MichelangeloAuthError } from "./errors.js";
import type { MichelangeloClient } from "./client.js";

export interface LoopbackLoginOptions {
  /** Shown on the consent screen during DCR. Used only when no clientId exists yet. */
  clientName?: string;
  scopes?: string[];
  /** Defaults to printing the URL to stdout (paste into a browser). */
  onOpen?: (url: string) => void;
  /** Give up after this long (default 5 min). */
  timeoutMs?: number;
}

const LOOPBACK_DCR_URI = "http://127.0.0.1/callback";

export async function loginWithLoopback(
  client: MichelangeloClient,
  options: LoopbackLoginOptions = {},
): Promise<void> {
  if (!client.auth.getClientId()) {
    await client.auth.registerClient({
      client_name: options.clientName ?? "Michelangelo SDK (loopback)",
      redirect_uris: [LOOPBACK_DCR_URI],
    });
  }

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const { url, codeVerifier } = await client.auth.beginLogin({
      redirectUri,
      scopes: options.scopes,
    });
    (options.onOpen ?? defaultOpen)(url);

    const code = await waitForCode(server, options.timeoutMs ?? 5 * 60 * 1000);
    await client.auth.exchangeCode({ code, codeVerifier, redirectUri });
  } finally {
    server.close();
  }
}

function defaultOpen(url: string): void {
  console.log(`\nOpen this URL in your browser to sign in:\n\n  ${url}\n`);
}

function waitForCode(
  server: ReturnType<typeof createServer>,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MichelangeloAuthError("login timed out waiting for the browser callback", "timeout"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<h1>Signed in — you can close this tab and return to the terminal.</h1>"
          : `<h1>Sign in failed${error ? `: ${error}` : ""}.</h1>`,
      );
      clearTimeout(timer);
      if (code) resolve(code);
      else reject(new MichelangeloAuthError(error ? `authorization failed: ${error}` : "callback has no code", "callback_error"));
    });
  });
}
