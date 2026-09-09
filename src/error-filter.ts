/** Snapshot caller-owned rules so later mutations cannot alter capture policy. */
export function snapshotIgnoreErrors(value: unknown): Array<string | RegExp> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Pubky Pulse: ignoreErrors must be an array of strings or RegExp values");
  }
  return Array.from(value, (rule: unknown) => {
    if (typeof rule === "string") return rule;
    if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags);
    throw new Error("Pubky Pulse: ignoreErrors must be an array of strings or RegExp values");
  });
}

/** Call before event construction: wire limits must never hide an ignored suffix. */
export function isIgnoredError(
  rules: ReadonlyArray<string | RegExp> | undefined,
  message: string,
  attributes?: Record<string, unknown>,
): boolean {
  if (!rules?.length) return false;
  try {
    const type = attributes?._error_type;
    const candidates = typeof type === "string" && type ? [message, `${type}: ${message}`] : [message];
    return rules.some((rule) => candidates.some((candidate) => {
      if (typeof rule === "string") return candidate.includes(rule);
      // Both global and sticky rules start at zero for every candidate/capture.
      rule.lastIndex = 0;
      try {
        return RegExp.prototype.test.call(rule, candidate);
      } finally {
        rule.lastIndex = 0;
      }
    }));
  } catch {
    // A broken policy drops the error silently; never recursively report it.
    return true;
  }
}
