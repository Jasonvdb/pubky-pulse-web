/**
 * What a `Pulse.reset` leaves behind for the initializations that follow it,
 * in a module of its own so the two guards cannot drift apart and so tests can
 * put the page back to its loaded state without `src/index.ts` exporting a
 * seam into the published API.
 *
 * Both guards are page memory, not storage, and both are retired only by an
 * initialization that actually completed — an initialization that threw
 * deleted nothing and adopted nothing, so it may not spend them.
 */

/**
 * Refuse the stored session on the next initialization, however fresh it is.
 * Set by every reset, of either scope. A reset promises this tab's session is
 * gone, and `sessionStorage.removeItem` can throw while `getItem` keeps
 * working, so a session the deletion could not remove would otherwise be
 * resumed and carry activity from before the reset across it.
 */
let freshSession = false;

/**
 * Trust nothing this browser has stored, for the rest of this page's life.
 * Set only where a browser-wide deletion could not be confirmed: what survived
 * it was overwritten best effort, but a store that refuses writes as well as
 * removals keeps its old values, and none of them may be adopted, claimed,
 * resumed or replayed after the user asked for them to be deleted.
 */
let distrustStored = false;

/** Both scopes: a browser-wide purge can leave a session behind too. */
export function requireFreshSession(): void {
  freshSession = true;
}

/** Also requires a fresh session: distrust is the stronger of the two. */
export function distrustStoredState(): void {
  freshSession = true;
  distrustStored = true;
}

export function freshSessionRequired(): boolean {
  return freshSession;
}

export function storedStateDistrusted(): boolean {
  return distrustStored;
}

/**
 * Retire both guards. Called by an initialization that completed, and by tests
 * standing in for a page that has just loaded.
 */
export function clearResetGuards(): void {
  freshSession = false;
  distrustStored = false;
}
