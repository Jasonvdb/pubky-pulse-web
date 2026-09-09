export interface ScreenNameMapperOptions {
  /** App-owned safe label used for unknown or malformed paths. Default: /unknown. */
  fallback?: string;
}

interface RouteTemplate {
  name: string;
  segments: Array<string | null>;
  staticCount: number;
}

/** Decode each segment once without turning encoded separators into route structure. */
function pathSegments(path: string): string[] | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) return undefined;
  if (path === "/") return [];
  try {
    const segments = path.slice(1).split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[/\\\u0000-\u0020\u007f]/.test(segment))) {
      return undefined;
    }
    return segments;
  } catch {
    return undefined;
  }
}

/**
 * Compile app-owned absolute path templates into a screenNameForPath callback.
 * Only whole-segment [parameter] placeholders are supported (one nonempty
 * segment). More static segments take precedence; ambiguous overlaps throw.
 * Query/fragment and trailing slashes are ignored. Segments are decoded once;
 * malformed escapes, dot segments, encoded separators, whitespace/control
 * characters, absolute URLs and repeated interior slashes use the safe fallback.
 * The callback returns only a configured template or fallback, never input data.
 */
export function createScreenNameMapper(
  templates: readonly string[],
  options: ScreenNameMapperOptions = {},
): (pathname: string) => string {
  const fallback = options.fallback ?? "/unknown";
  if (typeof fallback !== "string" || !fallback.trim() || /[\u0000-\u001f\u007f]/.test(fallback)) {
    throw new Error("Pubky Pulse: screen name fallback must be a nonempty safe label");
  }
  if (!Array.isArray(templates)) throw new Error("Pubky Pulse: route templates must be an array");
  const routes: RouteTemplate[] = [];
  for (const template of templates) {
    if (typeof template !== "string" || !template.startsWith("/") || /[?#]/.test(template)) {
      throw new Error("Pubky Pulse: invalid route template");
    }
    const name = template.replace(/\/+$/, "") || "/";
    const decoded = pathSegments(name);
    if (!decoded || template.startsWith("//")) throw new Error("Pubky Pulse: invalid route template");
    const segments = decoded.map((segment) => {
      if (/^\[[A-Za-z_][A-Za-z0-9_]*\]$/.test(segment)) return null;
      if (/[\[\]*:]/.test(segment)) throw new Error("Pubky Pulse: unsupported route template syntax");
      return segment;
    });
    if (routes.some((route) => route.name === name)) continue;
    const staticCount = segments.filter((segment) => segment !== null).length;
    if (routes.some((route) => route.staticCount === staticCount && route.segments.length === segments.length &&
      route.segments.every((segment, index) => segment === null || segments[index] === null || segment === segments[index]))) {
      throw new Error("Pubky Pulse: ambiguous route templates");
    }
    routes.push({ name, segments, staticCount });
  }
  routes.sort((left, right) => right.staticCount - left.staticCount);
  return (pathname: string): string => {
    if (typeof pathname !== "string") return fallback;
    const path = pathname.split(/[?#]/, 1)[0]!;
    if (!path || path.startsWith("//")) return fallback;
    const segments = pathSegments(path.replace(/\/+$/, "") || "/");
    if (!segments) return fallback;
    return routes.find((route) => route.segments.length === segments.length &&
      route.segments.every((segment, index) => segment === null || segment === segments[index]))?.name ?? fallback;
  };
}
