/**
 * Web Storage access that can never throw. Browsers reject `localStorage`
 * outright in some privacy modes and in sandboxed iframes, so every access is
 * guarded and falls back to a per-key in-memory map for the life of the page.
 */

/** All SDK keys live under this prefix so host app keys are never touched. */
export const STORAGE_PREFIX = "pulse.";

export type StorageKind = "local" | "session";

/**
 * True for the several spellings browsers use when a write exceeds the
 * origin quota. Safari's private mode reports code 22 with no name.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: unknown; code?: unknown };
  if (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  return err.code === 22 || err.code === 1014;
}

function resolveBackend(kind: StorageKind): Storage | null {
  try {
    const global = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const backend = kind === "local" ? global.localStorage : global.sessionStorage;
    return backend ?? null;
  } catch {
    // Accessing the property itself throws when storage is blocked.
    return null;
  }
}

export class SafeStorage {
  private readonly kind: StorageKind;
  private readonly memory = new Map<string, string>();
  private usingFallback = false;

  constructor(kind: StorageKind) {
    this.kind = kind;
  }

  /** True once any access failed and the in-memory map took over. */
  get isFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * The in-memory map only holds keys whose last write to the backend failed,
   * so when it has a value that value is the freshest one and wins.
   */
  get(key: string): string | null {
    const cached = this.memory.get(key);
    if (cached !== undefined) return cached;

    const backend = resolveBackend(this.kind);
    if (!backend) {
      this.usingFallback = true;
      return null;
    }
    try {
      return backend.getItem(STORAGE_PREFIX + key);
    } catch {
      this.usingFallback = true;
      return null;
    }
  }

  /**
   * Returns false when the value could not be persisted. Quota failures are
   * reported rather than hidden so callers such as the offline queue can shed
   * data and retry; the value is still mirrored in memory.
   */
  set(key: string, value: string): boolean {
    const backend = resolveBackend(this.kind);
    if (backend) {
      try {
        backend.setItem(STORAGE_PREFIX + key, value);
        this.memory.delete(key);
        return true;
      } catch {
        this.usingFallback = true;
      }
    } else {
      this.usingFallback = true;
    }
    this.memory.set(key, value);
    return false;
  }

  remove(key: string): void {
    this.memory.delete(key);
    const backend = resolveBackend(this.kind);
    if (!backend) {
      this.usingFallback = true;
      return;
    }
    try {
      backend.removeItem(STORAGE_PREFIX + key);
    } catch {
      this.usingFallback = true;
    }
  }
}

export const localStore = new SafeStorage("local");
export const sessionStore = new SafeStorage("session");
