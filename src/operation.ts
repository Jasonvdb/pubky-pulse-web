import { nowMs } from "./clock";
import { randomUuid } from "./event-builder";
import { metricMessage, normalizeSlug, type MetricPhase } from "./metrics";
import type { PulseAttributes, PulseLogLevel } from "./types";

/** How an operation hands an event back to the SDK pipeline. */
export type OperationLogger = (
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
) => void;

/** Turn whatever the caller threw into the single `error` attribute. */
function describeError(error: unknown): string {
  try {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message || error.name;
    if (error === null || error === undefined) return "unknown error";
    return String(error);
  } catch {
    return "unknown error";
  }
}

let constructing = false;
const inactiveLogger: OperationLogger = () => undefined;

/** An inert handle performs no clock, identifier or caller-metadata work. */
export function createInactiveOperation(): PulseOperation {
  return new PulseOperation(inactiveLogger, "");
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
  /** UUID shared by every event; empty for a handle created while inactive. */
  readonly trackingId: string;

  private readonly log: OperationLogger;
  private readonly slug: string;
  private readonly startedAt: number;
  private finished = false;

  constructor(log: OperationLogger, metric: string, attributes?: PulseAttributes) {
    this.log = log;
    this.slug = "";
    this.trackingId = "";
    this.startedAt = 0;
    this.finished = log === inactiveLogger || constructing;
    if (this.finished) return;
    constructing = true;
    try {
      // Normalise once so the start and terminal events keep the same slug.
      this.slug = normalizeSlug(metric);
      this.trackingId = randomUuid();
      this.startedAt = nowMs();
      this.log("info", metricMessage(this.slug, "start"), {
        ...attributes,
        tracking_id: this.trackingId,
      });
    } catch { /* An operation must never replace the application's own result. */ }
    finally { constructing = false; }
  }

  /** Finish successfully. */
  complete(attributes?: PulseAttributes): void {
    this.finish("info", "complete", attributes);
  }

  /** Finish with a failure; logged at error level with an `error` attribute. */
  fail(error: unknown, attributes?: PulseAttributes): void {
    this.finish("error", "fail", attributes, error);
  }

  /** Finish because the work was abandoned rather than failed. */
  cancel(attributes?: PulseAttributes): void {
    this.finish("info", "cancel", attributes);
  }

  private finish(
    level: PulseLogLevel,
    phase: Extract<MetricPhase, "complete" | "fail" | "cancel">,
    attributes?: PulseAttributes,
    error?: unknown,
  ): void {
    if (this.finished) return;
    this.finished = true;

    try {
      this.log(level, metricMessage(this.slug, phase), {
        ...attributes,
        ...(phase === "fail" ? { error: describeError(error) } : {}),
        tracking_id: this.trackingId,
        duration_ms: String(Math.max(0, Math.round(nowMs() - this.startedAt))),
      });
    } catch { /* Finishing is best effort and remains idempotent after a failure. */ }
  }
}
