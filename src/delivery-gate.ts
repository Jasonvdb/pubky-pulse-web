import type { PulseConfiguration } from "./types";

/**
 * Wrap the host's `canDeliver` callback in a check that cannot break or
 * mislead delivery. Only a literal `true` allows a send: `false`, a thrown
 * error, a non-boolean, a thenable (the check is synchronous, so a promise is
 * never awaited), and a call made from inside the callback itself all count as
 * a veto. Without a callback the gate always allows, so the default path is
 * unchanged.
 */
export function createDeliveryGate(
  canDeliver: PulseConfiguration["canDeliver"],
  onDebug?: (message: string, detail?: unknown) => void,
): () => boolean {
  if (canDeliver === undefined) return () => true;

  const debug = (message: string, detail?: unknown): void => {
    try { onDebug?.(message, detail); } catch { /* Diagnostics cannot reject delivery decisions. */ }
  };
  let checking = false;

  return () => {
    // A callback that flushes or tracks would re-enter the gate; answering
    // false keeps that nested send held instead of recursing.
    if (checking) return false;
    checking = true;
    try {
      const allowed = canDeliver() === true;
      if (!allowed) debug("canDeliver vetoed delivery, holding events");
      return allowed;
    } catch (error) {
      debug("canDeliver threw, holding events", error);
      return false;
    } finally {
      checking = false;
    }
  };
}
