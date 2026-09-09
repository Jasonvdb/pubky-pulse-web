import { randomUuid } from "./event-builder";
import { type SafeStorage, type StorageWriteResult } from "./storage";
import type { LogEvent } from "./types";

const QUEUE_KEY = "offline_queue";
/** Prefix for the per-call keys the unload path writes; see `spill`. */
const SPILL_PREFIX = "offline_queue:spill:";
/**
 * Digits the timestamp in a spill key is padded to, so the keys sort
 * chronologically as plain strings. Fifteen holds every millisecond until the
 * year 33658, which is long enough.
 */
const SPILL_TIMESTAMP_DIGITS = 15;
/** Web Lock serialising every read-modify-write of the shared queue key. */
const LOCK_NAME = "pulse_offline_queue";

/** Hard cap on parked events, across every key; the oldest are dropped first. */
export const MAX_OFFLINE_EVENTS = 10000;

/** The newest `MAX_OFFLINE_EVENTS`, which is all any reader is entitled to. */
function capped(events: LogEvent[]): LogEvent[] {
  return events.length > MAX_OFFLINE_EVENTS ? events.slice(-MAX_OFFLINE_EVENTS) : events;
}

/** The slice of the Web Locks API this module uses. */
interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

/** The Web Locks API, or null where the browser does not expose one. */
function lockManager(): LockManagerLike | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    return typeof locks?.request === "function" ? locks : null;
  } catch {
    // Accessing `navigator.locks` throws in some sandboxed contexts.
    return null;
  }
}

/**
 * Events that could not be delivered are parked in `localStorage` so they
 * survive a reload or a spell offline. Storage is shared with the host app, so
 * a quota failure sheds the oldest half rather than losing the whole queue.
 *
 * It is shared with every other tab on the origin too, and a read-modify-write
 * of one key from two tabs loses whatever the loser wrote in between. So
 * `append` and `drain` run inside a Web Lock, and the synchronous unload path,
 * which cannot await one, never touches the shared key at all: it uses `spill`.
 */
export class OfflineQueue {
  private readonly storage: SafeStorage;
  private readonly onDebug: ((message: string) => void) | undefined;

  constructor(storage: SafeStorage, onDebug?: (message: string) => void) {
    this.storage = storage;
    this.onDebug = onDebug;
  }

  /**
   * Every parked event, from the shared key and the spills alike, oldest
   * first, capped as a drain is and left in place. Inspection only — the
   * flush path uses `drain`.
   */
  read(): LogEvent[] {
    const events = this.readKey(QUEUE_KEY);
    for (const key of this.spillKeys()) events.push(...this.readKey(key));
    return capped(events);
  }

  /** Park `events` behind whatever is already queued. */
  async append(events: LogEvent[], isActive: () => boolean = () => true): Promise<void> {
    if (events.length === 0) return;
    await this.withLock(() => {
      if (isActive()) this.store(QUEUE_KEY, [...this.readKey(QUEUE_KEY), ...events]);
    });
  }

  /** Read every parked event and clear the queue in one step. */
  async drain(isActive: () => boolean = () => true): Promise<LogEvent[]> {
    return this.withLock(() => {
      if (!isActive()) return [];
      const events = this.readKey(QUEUE_KEY);
      if (events.length > 0) this.storage.remove(QUEUE_KEY);
      for (const key of this.spillKeys()) {
        events.push(...this.readKey(key));
        this.storage.remove(key);
      }
      return capped(events);
    });
  }

  /**
   * Park `events` from a caller that cannot await the lock — the unload flush,
   * which gets one synchronous turn before the page goes away. Each call writes
   * a key of its own, so it can never clobber another tab's queue; the next
   * `drain` folds the spill back in and removes it.
   */
  spill(events: LogEvent[]): void {
    if (events.length === 0) return;
    this.shedForSpill(events.length);
    const at = String(Date.now()).padStart(SPILL_TIMESTAMP_DIGITS, "0");
    this.store(`${SPILL_PREFIX}${at}:${randomUuid()}`, events);
  }

  /** The spill keys oldest first; the timestamp in the name is what sorts. */
  private spillKeys(): string[] {
    return this.storage.keys(SPILL_PREFIX).sort();
  }

  /**
   * Make room for `incoming` events by removing the oldest whole spill keys,
   * so a page hidden over and over cannot grow the aggregate past the cap.
   * The shared key is never rewritten here — there is no turn to await the
   * lock in — so a queue already at the cap sheds only spills, and `read` and
   * `drain` trim whatever is left over.
   */
  private shedForSpill(incoming: number): void {
    const keys = this.spillKeys();
    const counts = keys.map((key) => this.readKey(key).length);
    let stored = this.readKey(QUEUE_KEY).length + counts.reduce((sum, n) => sum + n, 0);

    for (const [index, key] of keys.entries()) {
      if (stored + incoming <= MAX_OFFLINE_EVENTS) return;
      this.storage.remove(key);
      stored -= counts[index]!;
    }
  }

  private readKey(key: string): LogEvent[] {
    const raw = this.storage.get(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LogEvent[]) : [];
    } catch {
      // Corrupt payload: drop it rather than failing every future flush.
      this.storage.remove(key);
      return [];
    }
  }

  /** Persist `events` under `key`, keeping only the newest `MAX_OFFLINE_EVENTS`. */
  private store(key: string, events: LogEvent[]): void {
    if (events.length === 0) {
      this.storage.remove(key);
      return;
    }

    let pending = capped(events);
    const first = this.persist(key, pending);
    if (first === "persisted") return;
    if (first !== "quota") {
      // No backend, or a write that failed for another reason: the events are
      // still held in the storage fallback, so keep them there to be drained.
      this.onDebug?.("offline queue not persisted, kept in memory");
      return;
    }

    // One retry after shedding the oldest half; a second quota failure means
    // the origin has no room at all and the events are dropped.
    pending = pending.slice(Math.ceil(pending.length / 2));
    this.onDebug?.(`offline queue over quota, dropped ${events.length - pending.length} events`);
    if (pending.length === 0) {
      this.storage.remove(key);
      return;
    }
    if (this.persist(key, pending) === "quota") {
      this.onDebug?.("offline queue could not be written, dropping parked events");
      this.storage.remove(key);
    }
  }

  private persist(key: string, events: LogEvent[]): StorageWriteResult {
    try {
      return this.storage.set(key, JSON.stringify(events));
    } catch {
      // Only `JSON.stringify` can throw here; nothing was retained anywhere,
      // so take the shed-and-drop path as before.
      this.onDebug?.("offline queue serialisation failed");
      return "quota";
    }
  }

  /**
   * Run `fn` holding the cross-tab lock, so two tabs cannot interleave a
   * read-modify-write of the shared key. Where the API is missing, or refuses
   * the request before `fn` ran, it runs unlocked exactly as it used to.
   */
  private async withLock<T>(fn: () => T): Promise<T> {
    const locks = lockManager();
    if (!locks) return fn();

    let started = false;
    try {
      return (await locks.request(LOCK_NAME, async () => {
        started = true;
        return fn();
      })) as T;
    } catch (err) {
      if (started) throw err;
      this.onDebug?.("offline queue lock unavailable, writing unlocked");
      return fn();
    }
  }
}
