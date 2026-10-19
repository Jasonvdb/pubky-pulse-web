/**
 * Web Storage access that can never throw. Browsers reject `localStorage`
 * outright in some privacy modes and in sandboxed iframes, so every access is
 * guarded and falls back to a per-key in-memory map for the life of the page.
 */

/**
 * All keys of the default namespace live under this prefix so host app keys
 * are never touched.
 */
export const STORAGE_PREFIX = "pulse.";

/**
 * Marker every named namespace's prefix starts with. It differs from
 * `STORAGE_PREFIX` at the sixth character, so neither prefix is a prefix of a
 * key in the other: a default `clear()` cannot delete a namespace's keys, and a
 * namespace's keys cannot keep the default's `confirmCleared()` false.
 */
const NAMESPACE_MARKER = "pulse:";

/** The default namespace: no name, keys under `STORAGE_PREFIX`. */
export const DEFAULT_STORAGE_NAMESPACE = undefined;

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * True for a usable namespace name: 1 to 32 lowercase ASCII letters, digits,
 * `_` or `-`, starting with a letter or digit. A `.` is banned so that one
 * namespace's prefix can never be a prefix of another's (`pulse:shop.` would
 * otherwise capture `pulse:shop.x.`), and uppercase is rejected rather than
 * lowercased so two spellings never silently share state.
 */
export function isValidStorageNamespace(value: unknown): value is string {
  return typeof value === "string" && NAMESPACE_PATTERN.test(value);
}

/**
 * The key prefix of a namespace: exactly `"pulse."` for the default and
 * `"pulse:<namespace>."` otherwise. Throws for an invalid name, which is a
 * programming error: callers validate user input before they get here.
 */
export function storagePrefixFor(namespace: string | undefined): string {
  if (namespace === DEFAULT_STORAGE_NAMESPACE) return STORAGE_PREFIX;
  if (!isValidStorageNamespace(namespace)) {
    throw new TypeError("Pubky Pulse: invalid storage namespace");
  }
  return `${NAMESPACE_MARKER}${namespace}.`;
}

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
  private readonly storageNamespace: string | undefined;
  /** Prepended to every key on the backend; see `storagePrefixFor`. */
  private readonly prefix: string;
  private readonly memory = new Map<string, string>();
  private usingFallback = false;
  private generation = 0;

  constructor(kind: StorageKind, namespace: string | undefined = DEFAULT_STORAGE_NAMESPACE) {
    this.kind = kind;
    this.prefix = storagePrefixFor(namespace);
    this.storageNamespace = namespace;
  }

  /** The namespace this store's keys live in; `undefined` for the default. */
  get namespace(): string | undefined {
    return this.storageNamespace;
  }

  /** True once any access failed and the in-memory map took over. */
  get isFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * Bumped by every `clear()` and every `invalidate()`. A holder of long-lived
   * derived state captures this when it is created and compares it before
   * writing back, so data a deletion already removed cannot be restored behind
   * that deletion's back; see `OfflineQueue`. It lives in this instance, and
   * `storesFor` keeps one instance per namespace and kind, so the epoch is
   * per-realm and per-namespace: bumping it retires this tab's holders of that
   * namespace and never another tab's or another namespace's.
   */
  get epoch(): number {
    return this.generation;
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
      return backend.getItem(this.prefix + key);
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
        backend.setItem(this.prefix + key, value);
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
      const scoped = this.prefix + prefix;
      for (let index = 0; index < backend.length; index += 1) {
        const raw = backend.key(index);
        if (raw?.startsWith(scoped)) found.add(raw.slice(this.prefix.length));
      }
    } catch {
      this.usingFallback = true;
    }
    return [...found];
  }

  /**
   * Delete every SDK key of this namespace, from the backend and the in-memory
   * fallback alike. Host app keys and other namespaces' keys are untouched:
   * only this store's prefix is enumerated.
   * The epoch advances whether or not anything was stored, so a holder created
   * before the clear is invalidated even when the deletion found nothing.
   */
  clear(): void {
    for (const key of this.keys("")) this.remove(key);
    this.generation += 1;
  }

  /**
   * Retire this realm's stored state without deleting anything shared: drop
   * the in-memory fallback and advance the epoch, touching no backend at all.
   * The fallback holds whatever this tab could not persist — parked events, the
   * anonymous id — and `get`/`keys` prefer it, so dropping it is what keeps the
   * next holder from finding and reusing this tab's values. Every other tab
   * reads the backend it left byte-identical, and keeps its own epoch.
   */
  invalidate(): void {
    this.memory.clear();
    this.generation += 1;
  }

  /**
   * True only when nothing of this namespace is left: the fallback is empty,
   * the backend resolves, enumerating it does not throw, and it holds no key
   * under this store's prefix. Goes to the backend directly rather than
   * through `get`/`keys`, which swallow failures and so report an unreadable
   * store as an empty one; here
   * "could not look" has to be false, because the caller uses it to decide
   * whether a deletion can be reported as done.
   */
  confirmCleared(): boolean {
    if (this.memory.size > 0) return false;

    const backend = resolveBackend(this.kind);
    if (!backend) return false;
    try {
      for (let index = 0; index < backend.length; index += 1) {
        if (backend.key(index)?.startsWith(this.prefix)) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  remove(key: string): void {
    this.memory.delete(key);
    const backend = resolveBackend(this.kind);
    if (!backend) {
      this.usingFallback = true;
      return;
    }
    try {
      backend.removeItem(this.prefix + key);
    } catch {
      this.usingFallback = true;
    }
  }
}

/** The local and session stores of one namespace. */
export interface StorePair {
  readonly local: SafeStorage;
  readonly session: SafeStorage;
}

export const localStore = new SafeStorage("local");
export const sessionStore = new SafeStorage("session");

const registry = new Map<string | undefined, StorePair>([
  [DEFAULT_STORAGE_NAMESPACE, Object.freeze({ local: localStore, session: sessionStore })],
]);

/**
 * The store pair of a namespace, created on first use and the same instances
 * every time after, so each namespace has one epoch and one in-memory fallback
 * per realm. The default namespace's pair is `localStore`/`sessionStore`.
 * Throws for an invalid name; see `storagePrefixFor`.
 */
export function storesFor(namespace: string | undefined = DEFAULT_STORAGE_NAMESPACE): StorePair {
  let pair = registry.get(namespace);
  if (!pair) {
    pair = Object.freeze({
      local: new SafeStorage("local", namespace),
      session: new SafeStorage("session", namespace),
    });
    registry.set(namespace, pair);
  }
  return pair;
}

/**
 * Every named namespace this realm can find state for: those with a
 * `"pulse:<name>."` key in either backend, plus those with a store pair in
 * this realm, whose in-memory fallback may hold what no backend does. Sorted
 * and without the default. Never throws: a backend that cannot be read is
 * skipped, so a caller deleting "everything" must still treat the result as a
 * lower bound and confirm each deletion separately.
 */
export function enumerateNamespaces(): string[] {
  const found = new Set<string>();
  for (const namespace of registry.keys()) {
    if (namespace !== DEFAULT_STORAGE_NAMESPACE) found.add(namespace);
  }
  for (const kind of ["local", "session"] as const) {
    const backend = resolveBackend(kind);
    if (!backend) continue;
    try {
      for (let index = 0; index < backend.length; index += 1) {
        const raw = backend.key(index);
        if (!raw?.startsWith(NAMESPACE_MARKER)) continue;
        const end = raw.indexOf(".", NAMESPACE_MARKER.length);
        const namespace = end === -1 ? "" : raw.slice(NAMESPACE_MARKER.length, end);
        if (isValidStorageNamespace(namespace)) found.add(namespace);
      }
    } catch {
      // An unreadable backend contributes nothing; see the doc comment.
    }
  }
  return [...found].sort();
}
