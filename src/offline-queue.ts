import { randomUuid } from "./event-builder";
import { jsonByteLength, MAX_OFFLINE_BYTES, stringByteLength } from "./event-size";
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

/** Keep the newest admissible events within both budgets before serialization. */
function capped(events: LogEvent[], byteLimit = MAX_OFFLINE_BYTES, countLimit = MAX_OFFLINE_EVENTS): LogEvent[] {
  const kept: LogEvent[] = [];
  let size = 2;
  const oldest = Math.max(0, events.length - MAX_OFFLINE_EVENTS);
  for (let index = events.length - 1; index >= oldest && kept.length < countLimit; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const eventSize = jsonByteLength(event);
    if (eventSize === null) continue;
    const nextSize = size + eventSize + (kept.length > 0 ? 1 : 0);
    if (nextSize > byteLimit) break;
    kept.push(event);
    size = nextSize;
  }
  return kept.reverse();
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
    let events = this.readKey(QUEUE_KEY);
    for (const key of this.spillKeys()) events = capped([...events, ...this.readKey(key)]);
    return events;
  }

  /** Park `events` behind whatever is already queued. */
  async append(events: LogEvent[], isActive: () => boolean = () => true): Promise<void> {
    // Retain only bounded work while waiting for another tab's lock.
    events = capped(events);
    if (events.length === 0) return;
    await this.withLock(() => {
      if (!isActive()) return;
      const incoming = events;
      const current = this.readKey(QUEUE_KEY);
      const spills = this.spillKeys().map((key) => this.storedUsage(key));
      let spillBytes = spills.reduce((sum, item) => sum + item.bytes, 0);
      let spillCount = spills.reduce((sum, item) => sum + item.count, 0);
      const incomingBytes = jsonByteLength(incoming, MAX_OFFLINE_BYTES)!;
      // An append holds the shared lock. Shed older spill keys only when the
      // incoming batch itself cannot fit; ordinary small spills remain intact.
      for (const spill of spills) {
        if (spillBytes + incomingBytes <= MAX_OFFLINE_BYTES && spillCount + incoming.length <= MAX_OFFLINE_EVENTS) break;
        this.storage.remove(spill.key);
        spillBytes -= spill.bytes;
        spillCount -= spill.count;
      }
      this.store(QUEUE_KEY, [...current, ...incoming], MAX_OFFLINE_BYTES - spillBytes, MAX_OFFLINE_EVENTS - spillCount);
    });
  }

  /** Read every parked event and clear the queue in one step. */
  async drain(isActive: () => boolean = () => true): Promise<LogEvent[]> {
    return this.withLock(() => {
      if (!isActive()) return [];
      let events = this.readKey(QUEUE_KEY);
      if (events.length > 0) this.storage.remove(QUEUE_KEY);
      for (const key of this.spillKeys()) {
        events = capped([...events, ...this.readKey(key)]);
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
    const incoming = capped(events);
    if (incoming.length === 0) return;
    const budget = this.shedForSpill(incoming);
    const at = String(Date.now()).padStart(SPILL_TIMESTAMP_DIGITS, "0");
    this.store(`${SPILL_PREFIX}${at}:${randomUuid()}`, incoming, budget.bytes, budget.count);
  }

  /** The spill keys oldest first; the timestamp in the name is what sorts. */
  private spillKeys(): string[] {
    return this.storage.keys(SPILL_PREFIX).sort();
  }

  private storedUsage(key: string): { key: string; count: number; bytes: number } {
    const count = this.readKey(key).length;
    const raw = this.storage.get(key);
    return { key, count, bytes: raw ? stringByteLength(raw, MAX_OFFLINE_BYTES) ?? 0 : 0 };
  }

  /**
   * Unload cannot acquire a lock or rewrite the shared key. Shed old spills,
   * then admit only the incoming events that fit beside the protected shared
   * data. Concurrent tabs may transiently race this best-effort aggregate cap;
   * every reader and writer also applies its own bounded payload admission.
   */
  private shedForSpill(incoming: LogEvent[]): { bytes: number; count: number } {
    const shared = this.storedUsage(QUEUE_KEY);
    const spills = this.spillKeys().map((key) => this.storedUsage(key));
    let storedBytes = shared.bytes + spills.reduce((sum, item) => sum + item.bytes, 0);
    let storedCount = shared.count + spills.reduce((sum, item) => sum + item.count, 0);
    const incomingBytes = jsonByteLength(incoming, MAX_OFFLINE_BYTES)!;
    for (const spill of spills) {
      if (storedBytes + incomingBytes <= MAX_OFFLINE_BYTES && storedCount + incoming.length <= MAX_OFFLINE_EVENTS) break;
      this.storage.remove(spill.key);
      storedBytes -= spill.bytes;
      storedCount -= spill.count;
    }
    return {
      bytes: Math.max(0, MAX_OFFLINE_BYTES - storedBytes),
      count: Math.max(0, MAX_OFFLINE_EVENTS - storedCount),
    };
  }

  private readKey(key: string): LogEvent[] {
    const raw = this.storage.get(key);
    if (!raw) return [];
    if (stringByteLength(raw, MAX_OFFLINE_BYTES) === null) {
      this.storage.remove(key);
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? capped(parsed as LogEvent[]) : [];
    } catch {
      // Corrupt payload: drop it rather than failing every future flush.
      this.storage.remove(key);
      return [];
    }
  }

  /** Persist `events` under `key`, keeping only the newest `MAX_OFFLINE_EVENTS`. */
  private store(key: string, events: LogEvent[], byteLimit = MAX_OFFLINE_BYTES, countLimit = MAX_OFFLINE_EVENTS): void {
    let pending = capped(events, byteLimit, countLimit);
    if (pending.length === 0) {
      this.storage.remove(key);
      return;
    }

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
