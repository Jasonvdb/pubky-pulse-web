/**
 * What a `Pulse.reset` leaves behind for the initializations that follow it,
 * in a module of its own so the two guards cannot drift apart and so tests can
 * put the page back to its loaded state without `src/index.ts` exporting a
 * seam into the published API.
 *
 * Both guards are page memory, not storage, and both are retired only by an
 * initialization that actually completed — an initialization that threw
 * deleted nothing and adopted nothing, so it may not spend them.
 *
 * Both are kept per storage namespace: a reset of one namespace must not make
 * another namespace's next initialization distrust its own state or abandon
 * its session. `undefined` is the default namespace throughout, as in
 * `storage.ts`.
 */

/**
 * Namespaces whose stored session the next initialization refuses, however
 * fresh it is. Set by every reset, of either scope. A reset promises this
 * tab's session is gone, and `sessionStorage.removeItem` can throw while
 * `getItem` keeps working, so a session the deletion could not remove would
 * otherwise be resumed and carry activity from before the reset across it.
 */
const freshSession = new Set<string | undefined>();

/**
 * Namespaces of which nothing stored is trusted, for the rest of this page's
 * life. Set only where a browser-wide deletion could not be confirmed: what
 * survived it was overwritten best effort, but a store that refuses writes as
 * well as removals keeps its old values, and none of them may be adopted,
 * claimed, resumed or replayed after the user asked for them to be deleted.
 */
const distrustStored = new Set<string | undefined>();

/** Both scopes: a browser-wide purge can leave a session behind too. */
export function requireFreshSession(namespace: string | undefined): void {
  freshSession.add(namespace);
}

/** Also requires a fresh session: distrust is the stronger of the two. */
export function distrustStoredState(namespace: string | undefined): void {
  freshSession.add(namespace);
  distrustStored.add(namespace);
}

export function freshSessionRequired(namespace: string | undefined): boolean {
  return freshSession.has(namespace);
}

export function storedStateDistrusted(namespace: string | undefined): boolean {
  return distrustStored.has(namespace);
}

/** Retire one namespace's guards: called by an initialization of it that completed. */
export function clearResetGuards(namespace: string | undefined): void {
  freshSession.delete(namespace);
  distrustStored.delete(namespace);
}

/** Retire every namespace's guards, as tests standing in for a page that has just loaded do. */
export function clearAllResetGuards(): void {
  freshSession.clear();
  distrustStored.clear();
}
