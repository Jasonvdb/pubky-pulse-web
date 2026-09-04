/**
 * Global capture of errors nobody caught. The listeners are observers only:
 * they never call `preventDefault()`, so the browser still logs the error and
 * any other handler on the page still runs.
 */

/** Which global hook saw the error, reported as the `_unhandled` attribute. */
export type UnhandledKind = "uncaught_exception" | "unhandled_rejection";

export type UnhandledHandler = (value: unknown, kind: UnhandledKind) => void;

/**
 * Listen for uncaught exceptions and unhandled promise rejections. Returns the
 * uninstaller; without a `window` nothing is installed.
 */
export function installUnhandledCapture(onUnhandled: UnhandledHandler): () => void {
  const win = (globalThis as { window?: Window }).window;
  if (!win) return () => undefined;

  const report = (value: unknown, kind: UnhandledKind): void => {
    try {
      onUnhandled(value, kind);
    } catch {
      // Reporting must never turn one broken event into two.
    }
  };

  const onError = (event: Event): void => {
    const errorEvent = event as Partial<ErrorEvent>;
    // `error` is null for cross-origin script errors; the message is all we get.
    const value = errorEvent.error ?? errorEvent.message ?? "uncaught exception";
    report(value, "uncaught_exception");
  };

  const onRejection = (event: Event): void => {
    const rejection = event as Partial<PromiseRejectionEvent>;
    const value = "reason" in rejection ? rejection.reason : "unhandled rejection";
    report(value, "unhandled_rejection");
  };

  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);

  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
