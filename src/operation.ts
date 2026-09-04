import { randomUuid } from "./event-builder";
import { metricMessage, normalizeSlug, type MetricPhase } from "./metrics";
import type { PulseAttributes, PulseLogLevel } from "./types";

/** How an operation hands an event back to the SDK pipeline. */
export type OperationLogger = (
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
) => void;

/** Monotonic where the browser offers it; wall clock is the fallback. */
function nowMs(): number {
  const performanceRef = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof performanceRef?.now === "function" ? performanceRef.now() : Date.now();
}

/** Turn whatever the caller threw into the single `error` attribute. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  if (error === null || error === undefined) return "unknown error";
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * One tracked operation: a `metric:<slug>:start` event now, and exactly one
 * terminal event later. Every event carries the same `tracking_id`, so the
 * server can pair them; the terminal event also carries `duration_ms`.
 *
 * Finishing is idempotent — a late `complete()` after a `fail()` (a retry
 * path, a promise that settles twice) is ignored rather than double-counted.
 */
export class PulseOperation {
  /** UUID shared by every event of this operation. */
  readonly trackingId: string;

  private readonly log: OperationLogger;
  private readonly slug: string;
  private readonly startedAt: number;
  private finished = false;

  constructor(log: OperationLogger, metric: string, attributes?: PulseAttributes) {
    this.log = log;
    // Normalise once: the terminal events must use the slug the start used,
    // and a bad slug should only be reported the one time.
    this.slug = normalizeSlug(metric);
    this.trackingId = randomUuid();
    this.startedAt = nowMs();

    this.log("info", metricMessage(this.slug, "start"), {
      ...attributes,
      tracking_id: this.trackingId,
    });
  }

  /** Finish successfully. */
  complete(attributes?: PulseAttributes): void {
    this.finish("info", "complete", attributes);
  }

  /** Finish with a failure; logged at error level with an `error` attribute. */
  fail(error: unknown, attributes?: PulseAttributes): void {
    this.finish("error", "fail", { ...attributes, error: describeError(error) });
  }

  /** Finish because the work was abandoned rather than failed. */
  cancel(attributes?: PulseAttributes): void {
    this.finish("info", "cancel", attributes);
  }

  private finish(
    level: PulseLogLevel,
    phase: Extract<MetricPhase, "complete" | "fail" | "cancel">,
    attributes?: PulseAttributes,
  ): void {
    if (this.finished) return;
    this.finished = true;

    this.log(level, metricMessage(this.slug, phase), {
      ...attributes,
      tracking_id: this.trackingId,
      duration_ms: String(Math.round(nowMs() - this.startedAt)),
    });
  }
}
