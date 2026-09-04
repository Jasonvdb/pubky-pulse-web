import { randomUuid } from "./event-builder";
import { type SafeStorage, type StorageWriteResult } from "./storage";
import type { LogEvent } from "./types";

const QUEUE_KEY = "offline_queue";
/** Prefix for the per-call keys the unload path writes; see `spill`. */
const SPILL_PREFIX = "offline_queue:spill:";
/** Web Lock serialising every read-modify-write of the shared queue key. */
const LOCK_NAME = "pulse_offline_queue";

/** Hard cap on parked events; the oldest are dropped first. */
export const MAX_OFFLINE_EVENTS = 10000;

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
   * Every parked event, from the shared key and the spills alike, left in
   * place. Inspection only — the flush path uses `drain`.
   */
  read(): LogEvent[] {
    const events = this.readKey(QUEUE_KEY);
    for (const key of this.storage.keys(SPILL_PREFIX)) events.push(...this.readKey(key));
    return events;
  }

  /** Park `events` behind whatever is already queued. */
  async append(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.withLock(() => {
      this.store(QUEUE_KEY, [...this.readKey(QUEUE_KEY), ...events]);
    });
  }

  /** Read every parked event and clear the queue in one step. */
  async drain(): Promise<LogEvent[]> {
    return this.withLock(() => {
      const events = this.readKey(QUEUE_KEY);
      if (events.length > 0) this.storage.remove(QUEUE_KEY);
      for (const key of this.storage.keys(SPILL_PREFIX)) {
        events.push(...this.readKey(key));
        this.storage.remove(key);
      }
      return events;
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
    this.store(SPILL_PREFIX + randomUuid(), events);
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

    let pending = events.length > MAX_OFFLINE_EVENTS ? events.slice(-MAX_OFFLINE_EVENTS) : events;
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
