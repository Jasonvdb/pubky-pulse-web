import { isQuotaExceededError, type SafeStorage } from "./storage";
import type { LogEvent } from "./types";

const QUEUE_KEY = "offline_queue";

/** Hard cap on parked events; the oldest are dropped first. */
export const MAX_OFFLINE_EVENTS = 10000;

/**
 * Events that could not be delivered are parked in `localStorage` so they
 * survive a reload or a spell offline. Storage is shared with the host app, so
 * a quota failure sheds the oldest half rather than losing the whole queue.
 */
export class OfflineQueue {
  private readonly storage: SafeStorage;
  private readonly onDebug: ((message: string) => void) | undefined;

  constructor(storage: SafeStorage, onDebug?: (message: string) => void) {
    this.storage = storage;
    this.onDebug = onDebug;
  }

  read(): LogEvent[] {
    const raw = this.storage.get(QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LogEvent[]) : [];
    } catch {
      // Corrupt payload: drop it rather than failing every future flush.
      this.storage.remove(QUEUE_KEY);
      return [];
    }
  }

  /** Persist `events`, keeping only the newest `MAX_OFFLINE_EVENTS`. */
  write(events: LogEvent[]): void {
    if (events.length === 0) {
      this.storage.remove(QUEUE_KEY);
      return;
    }

    let pending = events.length > MAX_OFFLINE_EVENTS ? events.slice(-MAX_OFFLINE_EVENTS) : events;
    if (this.persist(pending)) return;

    // One retry after shedding the oldest half; a second failure means the
    // origin has no room at all and the events are dropped.
    pending = pending.slice(Math.ceil(pending.length / 2));
    this.onDebug?.(`offline queue over quota, dropped ${events.length - pending.length} events`);
    if (pending.length === 0) {
      this.storage.remove(QUEUE_KEY);
      return;
    }
    if (!this.persist(pending)) {
      this.onDebug?.("offline queue could not be written, dropping parked events");
      this.storage.remove(QUEUE_KEY);
    }
  }

  append(events: LogEvent[]): void {
    if (events.length === 0) return;
    this.write([...this.read(), ...events]);
  }

  /** Read every parked event and clear the queue in one step. */
  drain(): LogEvent[] {
    const events = this.read();
    if (events.length > 0) this.storage.remove(QUEUE_KEY);
    return events;
  }

  private persist(events: LogEvent[]): boolean {
    try {
      return this.storage.set(QUEUE_KEY, JSON.stringify(events));
    } catch (err) {
      if (!isQuotaExceededError(err)) {
        this.onDebug?.("offline queue serialisation failed");
      }
      return false;
    }
  }
}
