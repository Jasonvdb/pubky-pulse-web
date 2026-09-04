import { randomUuid } from "./event-builder";
import { localStore } from "./storage";

/** Anonymous id for this browser profile. Survives reloads and tabs. */
export const ANONYMOUS_ID_KEY = "anonymous_id";
/** Identifier passed to `setUser`, so a reload keeps the user identified. */
export const USER_ID_KEY = "user_id";
export const ANONYMOUS_ID_PREFIX = "pulse_anon_";

export function createAnonymousId(): string {
  return `${ANONYMOUS_ID_PREFIX}${randomUuid()}`;
}

export interface IdentityHooks {
  /**
   * Flush pending events and POST `/v1/identity/claim`. Resolves once the
   * claim finished or gave up; it never rejects for a server failure.
   */
  claim(anonymousId: string, userId: string): Promise<void>;
  onDebug?(message: string, detail?: unknown): void;
}

/**
 * Anonymous-first identity. Events carry the anonymous id until `setUser`
 * runs; the claim then reassigns the events already on the server so one
 * person is one row, whichever side of the login they happened on.
 */
export class IdentityManager {
  private readonly hooks: IdentityHooks;
  private anonymousId: string;
  private savedUserId: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  /**
   * Bumped by every `setUser`/`clearUser`. A claim that settles after its
   * generation was superseded must not write back the id it was started for,
   * or a logout during an in-flight claim would silently re-identify the user.
   */
  private generation = 0;

  constructor(hooks: IdentityHooks) {
    this.hooks = hooks;
    this.anonymousId = createAnonymousId();
  }

  /** The anonymous id, kept even while a user is identified. */
  get anonymous(): string {
    return this.anonymousId;
  }

  /** The id stamped on outgoing events: the user id when set, else the anon id. */
  get currentId(): string {
    return this.savedUserId ?? this.anonymousId;
  }

  /** Resolves once any in-flight claim has settled. Primarily for tests. */
  get settled(): Promise<void> {
    return this.pending;
  }

  /**
   * Load the persisted ids. A saved user id means an earlier page already
   * identified this person, so re-run the claim in the background: it is
   * idempotent server-side and covers a claim that never reached the server.
   */
  load(): void {
    const storedAnon = localStore.get(ANONYMOUS_ID_KEY);
    if (storedAnon) {
      this.anonymousId = storedAnon;
    } else {
      this.anonymousId = createAnonymousId();
      localStore.set(ANONYMOUS_ID_KEY, this.anonymousId);
    }

    this.savedUserId = localStore.get(USER_ID_KEY) ?? undefined;
    if (this.savedUserId && this.savedUserId !== this.anonymousId) {
      this.generation += 1;
      this.pending = this.runClaim(this.anonymousId, this.savedUserId);
    }
  }

  /**
   * Persist the identifier, let the events already buffered reach the server
   * under the anonymous id, claim them, and only then switch. Switching first
   * would split the person across two rows: the claim's `UPDATE` would miss
   * the events still in flight under the old id.
   */
  async setUser(identifier: string): Promise<void> {
    const userId = identifier.trim();
    if (!userId) {
      throw new Error("Pubky Pulse: setUser requires a non-empty user id");
    }
    if (userId === this.savedUserId) return;

    localStore.set(USER_ID_KEY, userId);
    const anonymousId = this.anonymousId;
    this.generation += 1;
    const generation = this.generation;

    this.pending = this.runClaim(anonymousId, userId).finally(() => {
      // Switch even when the claim failed: the id is persisted, so the next
      // configure() retries the claim, and events must not stay anonymous
      // after the app told us who this is. A clearUser (or a later setUser)
      // in the meantime wins, so the switch is skipped.
      if (generation !== this.generation) return;
      this.savedUserId = userId;
    });
    await this.pending;
  }

  /**
   * Forget the identified user. `newAnonymousId` mints a fresh anonymous id
   * so a shared device does not attribute the next person's events to the
   * one who just logged out.
   */
  clearUser(options?: { newAnonymousId?: boolean }): void {
    this.generation += 1;
    localStore.remove(USER_ID_KEY);
    this.savedUserId = undefined;

    if (options?.newAnonymousId) {
      this.anonymousId = createAnonymousId();
      localStore.set(ANONYMOUS_ID_KEY, this.anonymousId);
    }
  }

  private runClaim(anonymousId: string, userId: string): Promise<void> {
    return this.hooks.claim(anonymousId, userId).catch((err: unknown) => {
      this.hooks.onDebug?.("identity claim failed", err);
    });
  }
}
