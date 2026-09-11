/**
 * Web Storage access that can never throw. Browsers reject `localStorage`
 * outright in some privacy modes and in sandboxed iframes, so every access is
 * guarded and falls back to a per-key in-memory map for the life of the page.
 */

/** All SDK keys live under this prefix so host app keys are never touched. */
export const STORAGE_PREFIX = "pulse.";

export type StorageKind = "local" | "session";

/**
 * Outcome of a write: persisted to the backend, rejected for lack of room, or
 * held only in the in-memory fallback.
 */
export type StorageWriteResult = "persisted" | "quota" | "memory-only";

/**
 * True for the several spellings browsers use when a write exceeds the
 * origin quota. Safari's private mode reports code 22 with no name.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  try {
    const err = error as { name?: unknown; code?: unknown };
    if (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED") {
      return true;
    }
    return err.code === 22 || err.code === 1014;
  } catch {
    // Even the value thrown by a storage adapter can have hostile getters.
    return false;
  }
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
   * Reports how the value was retained. `"quota"` is the only outcome that
   * means the origin has no room: callers such as the offline queue may shed
   * data and retry on it. `"memory-only"` (no backend, or a write that failed
   * for another reason) still keeps the value in the in-memory map, so it is
   * readable for the life of the page and must not be discarded.
   */
  set(key: string, value: string): StorageWriteResult {
    const backend = resolveBackend(this.kind);
    let result: StorageWriteResult = "memory-only";
    if (backend) {
      try {
        backend.setItem(STORAGE_PREFIX + key, value);
        this.memory.delete(key);
        return "persisted";
      } catch (err) {
        this.usingFallback = true;
        if (isQuotaExceededError(err)) result = "quota";
      }
    } else {
      this.usingFallback = true;
    }
    this.memory.set(key, value);
    return result;
  }

  /**
   * Every SDK key currently held whose name starts with `prefix`, from the
   * backend and the in-memory fallback alike. Used to find the offline queue's
   * spill keys, whose names are not known ahead of time.
   */
  keys(prefix: string): string[] {
    const found = new Set<string>();
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) found.add(key);
    }

    const backend = resolveBackend(this.kind);
    if (!backend) {
      this.usingFallback = true;
      return [...found];
    }
    try {
      const scoped = STORAGE_PREFIX + prefix;
      for (let index = 0; index < backend.length; index += 1) {
        const raw = backend.key(index);
        if (raw?.startsWith(scoped)) found.add(raw.slice(STORAGE_PREFIX.length));
      }
    } catch {
      this.usingFallback = true;
    }
    return [...found];
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
