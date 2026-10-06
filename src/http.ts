/**
 * Default fetch that always invokes the global with its receiver intact.
 *
 * Storing a bare `fetch` reference (`const f = fetch`) and calling it later
 * throws on runtimes with a `this`-sensitive implementation — Hermes /
 * React Native and some WebViews reject it with e.g.
 * "Can only call Window.fetch on instances of Window" (browsers call it
 * "Illegal invocation"). Going through `globalThis` at call time also picks
 * up fetch polyfills installed after the SDK was imported.
 */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
