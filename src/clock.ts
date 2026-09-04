/**
 * Single source of elapsed time for every duration the SDK reports.
 * `performance.now()` is monotonic, so a clock adjustment cannot produce a
 * negative duration; the wall clock is the fallback where it is missing.
 */
export function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}
