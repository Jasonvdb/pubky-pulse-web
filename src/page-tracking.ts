/**
 * Screen tracking for single-page apps. There is no navigation event for
 * `history.pushState`, so the History API is patched once and compared against
 * `location.pathname` before and after the call: that keeps hash-only changes
 * (in-page anchors) from looking like navigations.
 */

import { nowMs } from "./clock";

export interface ScreenCallbacks {
  /** A screen became visible. */
  onAppeared(screenName: string): void;
  /** The previous screen was left after `durationMs` on it. */
  onDisappeared(screenName: string, durationMs: number): void;
}

/** Path of the page currently shown, normalised to a leading slash. */
export function currentPath(): string {
  const loc = (globalThis as { location?: Location }).location;
  const path = loc?.pathname;
  return path ? path : "/";
}

function patchHistory(onNavigation: () => void): () => void {
  let active = true;
  const restores: Array<() => void> = [];
  try {
    const history = (globalThis as { history?: History }).history;
    if (history) {
      for (const method of ["pushState", "replaceState"] as const) {
        try {
          const original = history[method];
          if (typeof original !== "function") continue;
          const wrapped = function (this: History, ...args: Parameters<History["pushState"]>): void {
            let before: string | undefined;
            if (active) {
              try { before = currentPath(); } catch { /* Navigation does not depend on location access. */ }
            }
            // Preserve the host's receiver, return value and original exception.
            const result = Reflect.apply(original, this, args);
            if (active) {
              try {
                if (before !== undefined && currentPath() !== before) onNavigation();
              } catch { /* Telemetry must not interrupt a completed navigation. */ }
            }
            return result;
          };
          // Record cleanup before assignment in case a host setter partially succeeds.
          restores.push(() => {
            if (history[method] === wrapped) history[method] = original;
          });
          history[method] = wrapped;
        } catch { /* Each method is optional, including on read-only History objects. */ }
      }
    }
  } catch { /* A host can deny access to History altogether. */ }
  return () => {
    active = false;
    for (const restore of restores.splice(0)) {
      try { restore(); } catch { /* Retained wrappers remain inactive. */ }
    }
  };
}

/**
 * Tracks which screen is showing and how long each one was on screen. The
 * current name is also the default `screen_name` for every other event, so a
 * tracker exists even when automatic page views are switched off — in that
 * case only `trackScreen()` moves it.
 */
export class PageTracker {
  private readonly callbacks: ScreenCallbacks;
  private readonly screenNameForPath?: (pathname: string) => string;
  private current: string | null = null;
  private enteredAt = 0;
  private popstateHandler: (() => void) | null = null;
  private installed = false;
  private restoreHistory: (() => void) | null = null;

  constructor(callbacks: ScreenCallbacks, screenNameForPath?: (pathname: string) => string) {
    this.callbacks = callbacks;
    this.screenNameForPath = screenNameForPath;
  }

  /** Screen stamped on events that do not name one themselves. */
  get screenName(): string | undefined {
    return this.current ?? undefined;
  }

  /**
   * Start automatic tracking: patch the History API, listen for back/forward
   * navigation, and report the page that is already open.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    const navigate = () => {
      if (!this.installed) return;
      try { this.enterCurrentPath(); } catch { /* Tracking is best effort. */ }
    };
    this.restoreHistory = patchHistory(navigate);
    try {
      const win = (globalThis as { window?: Window }).window;
      if (win) {
        this.popstateHandler = navigate;
        win.addEventListener("popstate", navigate);
      }
    } catch { /* History tracking can still work without a popstate listener. */ }
    navigate();
  }

  /** Report a screen change the SDK cannot see, e.g. a modal or a tab. */
  trackScreen(name: string): void {
    try { this.enter(name); } catch { /* Manual telemetry cannot interrupt the caller. */ }
  }

  /** Undo `install()` and forget the current screen. */
  restore(): void {
    this.installed = false;
    try {
      const win = (globalThis as { window?: Window }).window;
      if (win && this.popstateHandler) win.removeEventListener("popstate", this.popstateHandler);
    } catch { /* Continue restoring history. */ }
    this.popstateHandler = null;
    this.restoreHistory?.();
    this.restoreHistory = null;
    this.current = null;
    this.enteredAt = 0;
  }

  private enterCurrentPath(): void {
    const pathname = currentPath();
    if (!this.screenNameForPath) {
      this.enter(pathname);
      return;
    }

    let name: string | null = null;
    try {
      const mapped = this.screenNameForPath(pathname);
      if (typeof mapped === "string" && mapped.trim().length > 0) {
        name = mapped;
      } else {
        // Invalid async results must not leak mapper errors through unhandled capture.
        void Promise.resolve(mapped).catch(() => undefined);
      }
    } catch {
      // Mapping must not break navigation or expose a raw path on failure.
    }
    this.enter(name);
  }

  private enter(name: string | null): void {
    if (this.current === name) return;

    const at = nowMs();
    if (this.current !== null) {
      try {
        this.callbacks.onDisappeared(this.current, Math.max(0, Math.round(at - this.enteredAt)));
      } catch { /* Continue tracking the screen even if its previous event failed. */ }
    }
    this.current = name;
    this.enteredAt = at;
    if (name !== null) {
      try { this.callbacks.onAppeared(name); } catch { /* A collector cannot break navigation. */ }
    }
  }
}
