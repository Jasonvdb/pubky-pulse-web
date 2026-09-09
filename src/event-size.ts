/** Browser resource budgets apply to wire payloads, independently of event counts. */
export const MAX_EVENT_BYTES = 128 * 1024;
export const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const MAX_OFFLINE_BYTES = 1024 * 1024;

/**
 * Count UTF-8 bytes without allocating a second copy. `escaped` counts the JSON
 * string representation, including quotes and escaped lone surrogate halves.
 * Stop as soon as the caller's budget is exhausted.
 */
export function stringByteLength(value: string, limit: number, escaped = false): number | null {
  let size = escaped ? 2 : 0;
  if (value.length + size > limit) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (escaped && (code === 34 || code === 92)) size += 2;
    else if (escaped && code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code < 128) size += 1;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      size += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) size += escaped ? 6 : 3;
    else size += 3;
    if (size > limit) return null;
  }
  return size <= limit ? size : null;
}

/**
 * Size detached JSON data before serializing it. Reject accessors, custom JSON
 * conversion and deep/cyclic objects instead of executing application code or
 * allocating an unbounded JSON string just to measure it.
 */
export function jsonByteLength(value: unknown, limit = MAX_EVENT_BYTES): number | null {
  const seen = new Set<object>();
  function measure(item: unknown, remaining: number, depth: number): number | null {
    if (remaining < 0) return null;
    if (typeof item === "string") return stringByteLength(item, remaining, true);
    if (item === null) return remaining >= 4 ? 4 : null;
    if (typeof item === "boolean") {
      const size = item ? 4 : 5;
      return size <= remaining ? size : null;
    }
    if (typeof item === "number") {
      const size = Number.isFinite(item) ? String(item).length : 4;
      return size <= remaining ? size : null;
    }
    if (typeof item !== "object" || depth > 16 || seen.has(item)) return null;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return null;
    const conversion = Object.getOwnPropertyDescriptor(item, "toJSON") ??
      (prototype && Object.getOwnPropertyDescriptor(prototype, "toJSON")) ??
      (array ? Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") : undefined);
    if (conversion && (!("value" in conversion) || typeof conversion.value === "function")) return null;
    seen.add(item);
    let size = 2;
    let count = 0;
    if (array) {
      // Even empty strings take three bytes with their separator. This cheap
      // lower bound avoids traversing an oversized hook-produced language list.
      if (item.length > remaining) return null;
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) return null;
        if (count++ > 0) size += 1;
        const next = measure(descriptor.value === undefined ? null : descriptor.value, remaining - size, depth + 1);
        if (next === null) return null;
        size += next;
      }
    } else {
      for (const key in item) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) return null;
        if (descriptor.value === undefined) continue;
        if (count++ > 0) size += 1;
        const keySize = stringByteLength(key, remaining - size, true);
        if (keySize === null) return null;
        size += keySize + 1;
        const next = measure(descriptor.value, remaining - size, depth + 1);
        if (next === null) return null;
        size += next;
      }
    }
    seen.delete(item);
    return size <= remaining ? size : null;
  }
  try { return measure(value, limit, 0); } catch { return null; }
}
