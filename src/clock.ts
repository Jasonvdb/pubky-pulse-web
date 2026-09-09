/** Best-effort elapsed time; broken host clocks must never interrupt telemetry callers. */
export function nowMs(): number {
  try {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === "function") {
      const now = perf.now();
      if (Number.isFinite(now)) return now;
    }
  } catch { /* Fall back when a host clock adapter is unavailable. */ }
  try {
    const now = Date.now();
    if (Number.isFinite(now)) return now;
  } catch { /* No usable clock: a zero duration is preferable to throwing. */ }
  return 0;
}
