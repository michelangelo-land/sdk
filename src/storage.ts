/**
 * Opt-in session persistence contracts.
 *
 * The SDK stays in-memory by default. Pass a `storage` implementation
 * (SecureStore, localStorage, AsyncStorage, …) to persist rotated tokens;
 * pass a `lock` (e.g. the Web Locks API) to serialize refresh rotations
 * across tabs. The SDK never imports a storage library — these are plain
 * structural interfaces, so any adapter with the right shape works.
 */

/** Session snapshot written by the SDK — safe to persist on disk/keychain. */
export interface PersistedSession {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry in epoch milliseconds (`Date.now() + expires_in * 1000`). */
  expiresAt?: number;
  clientId?: string;
}

/**
 * Adapter used only when `storage` is provided. Methods may be synchronous
 * (in-memory, localStorage) or asynchronous (SecureStore, AsyncStorage).
 *
 * Errors are swallowed by the SDK: a failing storage backend must never
 * break authentication.
 */
export interface SessionStorage {
  load(): PersistedSession | null | Promise<PersistedSession | null>;
  save(session: PersistedSession): void | Promise<void>;
  clear(): void | Promise<void>;
}

/**
 * Minimal cross-tab mutex, structurally compatible with the Web Locks API:
 *
 *   const lock: SessionLock = {
 *     request: (callback) => navigator.locks.request("michelangelo-session", callback),
 *   };
 *
 * The SDK wraps the whole refresh rotation (read storage → adopt newer
 * refresh token → rotate → save) in a single `request()` callback so two
 * tabs never present the same single-use refresh token at the same time.
 */
export interface SessionLock {
  request<T>(callback: () => Promise<T>): Promise<T>;
}
