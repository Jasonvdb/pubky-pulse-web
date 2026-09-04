/**
 * Turn a value passed to `Pulse.error(value)` into the reserved `_error_*`
 * attributes the server uses for issue fingerprinting. `unknown` is the right
 * input type because JavaScript allows `throw <anything>`.
 */

const MAX_CAUSE_DEPTH = 5;
const MAX_STACK_LENGTH = 16000;
const MAX_VALUE_LENGTH = 200;

export interface ExtractionResult {
  message: string;
  attributes: Record<string, string>;
}

function clip(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? value.slice(0, max) : value;
}

function typeOf(error: Error): string {
  return error.name || error.constructor?.name || "Error";
}

/**
 * `AggregateError` (and `Promise.any` rejections) carry an `errors` array;
 * surface the count and the first entry so the dashboard is not blind to it.
 */
function extractAggregateErrors(error: Error, attrs: Record<string, string>): void {
  const aggregate = error as Error & { errors?: unknown };
  if (!Array.isArray(aggregate.errors)) return;
  attrs._error_aggregate_count = String(aggregate.errors.length);
  const first: unknown = aggregate.errors[0];
  if (first instanceof Error) {
    attrs._error_aggregate_first_type = clip(typeOf(first));
    attrs._error_aggregate_first_message = clip(first.message || String(first));
  } else if (first !== undefined) {
    attrs._error_aggregate_first_type = clip(first === null ? "null" : typeof first);
    attrs._error_aggregate_first_message = clip(safeString(first));
  }
}

/** Walk `Error.cause` up to five levels. Cycle-safe via a set of seen values. */
function walkCauseChain(error: Error, attrs: Record<string, string>): void {
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as Error & { cause?: unknown }).cause;
  let depth = 1;

  while (current !== undefined && current !== null && depth <= MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);

    if (current instanceof Error) {
      attrs[`_error_cause_${depth}_type`] = clip(typeOf(current));
      attrs[`_error_cause_${depth}_message`] = clip(current.message || String(current));
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      attrs[`_error_cause_${depth}_type`] = clip(typeof current);
      attrs[`_error_cause_${depth}_message`] = clip(safeString(current));
      break;
    }
    depth += 1;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unrepresentable error>";
  }
}

function resolveMessage(error: unknown, userMessage?: string): string {
  if (typeof userMessage === "string") {
    const trimmed = userMessage.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (error instanceof Error) return error.message || safeString(error);
  if (typeof error === "string") return error;
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  return safeString(error);
}

export function extractErrorAttributes(error: unknown, userMessage?: string): ExtractionResult {
  const attrs: Record<string, string> = {};

  if (error instanceof Error) {
    attrs._error_type = typeOf(error);
    if (typeof error.stack === "string" && error.stack.length > 0) {
      attrs._error_stack = clip(error.stack, MAX_STACK_LENGTH);
    }
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      attrs._error_code = clip(code);
    } else if (typeof code === "number") {
      attrs._error_code = String(code);
    }
    extractAggregateErrors(error, attrs);
    walkCauseChain(error, attrs);
  } else {
    attrs._error_type = error === null ? "null" : typeof error;
  }

  return { message: resolveMessage(error, userMessage), attributes: attrs };
}
