/**
 * Message conventions for metrics and funnel steps. The server reads the
 * event `message` itself, so the exact shape here is part of the wire
 * contract: `metric:<slug>:<phase>` and `step:<name>`.
 */

/** Lifecycle phases a metric message can carry. */
export type MetricPhase = "start" | "complete" | "fail" | "cancel" | "record";

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** One warning per page, however many bad slugs the app passes. */
let slugWarningShown = false;

/** Test seam: forget that the one-time slug warning was already printed. */
export function resetSlugWarning(): void {
  slugWarningShown = false;
}

/**
 * Coerce a metric slug to `^[a-z0-9-]+$`: lowercase, every other character
 * becomes a hyphen, runs collapse, edges are trimmed. Matches the Swift and
 * Node SDKs so the same metric from any client lands on one dashboard row.
 *
 * A slug of nothing but invalid characters normalises to the empty string,
 * exactly as the other SDKs do; correcting it further would silently invent a
 * different metric name than the other clients report.
 */
export function normalizeSlug(slug: string): string {
  if (SLUG_PATTERN.test(slug)) return slug;

  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slugWarningShown) {
    slugWarningShown = true;
    try { console.warn(
      `Pubky Pulse: metric slug "${slug}" was auto-corrected to "${normalized}". ` +
        "Slugs should contain only lowercase letters, numbers, and hyphens. " +
        "Further corrections are not reported.",
    ); } catch { /* Diagnostics are best effort, including replaced consoles. */ }
  }

  return normalized;
}

/** `metric:<slug>:<phase>`, with the slug normalised. */
export function metricMessage(slug: string, phase: MetricPhase): string {
  return `metric:${normalizeSlug(slug)}:${phase}`;
}

/** `step:<name>`. Funnel step names are free-form and kept verbatim. */
export function stepMessage(name: string): string {
  return `step:${name}`;
}
