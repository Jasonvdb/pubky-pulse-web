/**
 * Page lifecycle listeners. The browser gives no reliable "the tab is closing"
 * signal, so the SDK treats `pagehide` and a `visibilitychange` to `hidden` as
 * the last chance to get buffered events out, and a return to `visible` as the
 * moment to re-check whether the session went idle while we were backgrounded.
 */

/** `pagehide` and `visibilitychange` fire back to back; only the first sends. */
export const UNLOAD_DEBOUNCE_MS = 1000;

export interface LifecycleCallbacks {
  /** The page is going away or was backgrounded: flush synchronously. */
  onHidden(): void;
  /** The page came back to the foreground: renew the session if it expired. */
  onVisible(): void;
}

/**
 * Install the lifecycle listeners and return the matching uninstaller. Without
 * a `window` (server rendering) nothing is installed and the uninstaller is a
 * no-op, so callers do not need their own environment check.
 */
export function installLifecycle(callbacks: LifecycleCallbacks): () => void {
  const win = (globalThis as { window?: Window }).window;
  const doc = (globalThis as { document?: Document }).document;
  if (!win) return () => undefined;

  let lastHiddenAt = 0;

  const hide = (): void => {
    const now = Date.now();
    if (lastHiddenAt !== 0 && now - lastHiddenAt < UNLOAD_DEBOUNCE_MS) return;
    lastHiddenAt = now;
    callbacks.onHidden();
  };

  const onPageHide = (): void => {
    hide();
  };

  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === "hidden") {
      hide();
      return;
    }
    // Coming back into view: a long background stint may have ended the
    // session, and the next check is what emits the new one.
    callbacks.onVisible();
  };

  win.addEventListener("pagehide", onPageHide);
  doc?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    win.removeEventListener("pagehide", onPageHide);
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
