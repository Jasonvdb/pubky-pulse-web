/**
 * Best-effort device description derived from the user agent. Browsers report
 * far less than a native app, and UA reduction keeps trimming what is left, so
 * every field is optional and a parse miss simply omits it.
 */

export interface DeviceInfo {
  /** Operating system and version, e.g. `macOS 10.15.7`. */
  osVersion?: string;
  /** Browser name and major version, e.g. `Chrome 120`. */
  deviceModel?: string;
  locale?: string;
  preferredLanguage?: string;
  /** Only set when the app explicitly configures `supportedLanguages`. */
  supportedLanguages?: string[];
}

interface NavigatorLike {
  userAgent?: string;
  language?: string;
}

function getNavigator(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator;
}

function parseOsVersion(ua: string): string | undefined {
  const windows = /Windows NT ([0-9._]+)/.exec(ua);
  if (windows?.[1]) return `Windows NT ${windows[1]}`;

  const mac = /Mac OS X ([0-9_.]+)/.exec(ua);
  if (mac?.[1]) return `macOS ${mac[1].replace(/_/g, ".")}`;

  const ios = /(?:iPhone|CPU) OS ([0-9_]+)/.exec(ua);
  if (ios?.[1]) return `iOS ${ios[1].replace(/_/g, ".")}`;

  const android = /Android ([0-9.]+)/.exec(ua);
  if (android?.[1]) return `Android ${android[1]}`;

  if (ua.includes("Macintosh")) return "macOS";
  if (ua.includes("CrOS")) return "ChromeOS";
  if (ua.includes("Linux")) return "Linux";
  return undefined;
}

/**
 * Order matters: Edge and Opera both carry `Chrome` in their user agent, and
 * every Chromium browser carries `Safari`, so the most specific token wins.
 */
const BROWSER_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ["Edge", /Edg(?:e|A|iOS)?\/([0-9]+)/],
  ["Opera", /OPR\/([0-9]+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/([0-9]+)/],
  ["Chrome", /(?:Chrome|CriOS)\/([0-9]+)/],
  ["Safari", /Version\/([0-9]+).*Safari/],
];

function parseBrowser(ua: string): string | undefined {
  for (const [name, pattern] of BROWSER_PATTERNS) {
    const match = pattern.exec(ua);
    if (match?.[1]) return `${name} ${match[1]}`;
  }
  return undefined;
}

/**
 * `supportedLanguages` describes the locales the app itself ships and is only
 * reported when the host app configures it. There is deliberately no
 * `navigator.languages` fallback: the server writes this list through to the
 * app record, so a browser-derived default would let each visitor's language
 * preferences overwrite the app's shipped-locale list.
 */
export function collectDeviceInfo(supportedLanguages?: string[]): DeviceInfo {
  const nav = getNavigator();
  const ua = typeof nav?.userAgent === "string" ? nav.userAgent : "";
  const language = typeof nav?.language === "string" && nav.language ? nav.language : undefined;

  const info: DeviceInfo = {};
  const osVersion = ua ? parseOsVersion(ua) : undefined;
  if (osVersion) info.osVersion = osVersion;
  const deviceModel = ua ? parseBrowser(ua) : undefined;
  if (deviceModel) info.deviceModel = deviceModel;
  if (language) {
    info.locale = language;
    info.preferredLanguage = language;
  }
  if (supportedLanguages && supportedLanguages.length > 0) {
    info.supportedLanguages = [...supportedLanguages];
  }
  return info;
}

/** True when the browser reports itself as offline. Unknown counts as online. */
export function isOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  return nav?.onLine === false ? false : true;
}
