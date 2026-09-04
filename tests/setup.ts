/**
 * Hand-written browser globals. Deliberately not jsdom: the SDK touches a
 * small, well understood slice of the platform, and owning these fakes keeps
 * the failure modes we care about (blocked storage, quota, visibility
 * transitions) directly controllable from a test.
 */

/** `Storage` backed by a Map, with a switch to make writes fail. */
export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  /** `"quota"` throws QuotaExceededError, `"error"` throws a plain Error. */
  throwOnSet: false | "quota" | "error" = false;

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet === "quota") {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    if (this.throwOnSet === "error") {
      throw new Error("storage unavailable");
    }
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  /** Test helper: every key currently held. */
  keys(): string[] {
    return [...this.data.keys()];
  }
}

export interface TestLocation {
  pathname: string;
  hostname: string;
  protocol: string;
  href: string;
}

export interface TestNavigator {
  language: string;
  languages: string[];
  userAgent: string;
  onLine: boolean;
}

export interface TestHistory {
  state: unknown;
  pushState(state: unknown, title: string, url?: string): void;
  replaceState(state: unknown, title: string, url?: string): void;
}

class TestDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

export const testLocalStorage = new MemoryStorage();
export const testSessionStorage = new MemoryStorage();
export const testWindow = new EventTarget();
export const testDocument = new TestDocument();

export const testNavigator: TestNavigator = {
  language: "en-GB",
  languages: ["en-GB", "en"],
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  onLine: true,
};

export const testLocation: TestLocation = {
  pathname: "/",
  hostname: "app.example.com",
  protocol: "https:",
  href: "https://app.example.com/",
};

/** Mirror a real navigation: a url argument moves `location`. */
function applyUrl(url?: string): void {
  if (typeof url !== "string") return;
  try {
    const resolved = new URL(url, testLocation.href);
    testLocation.pathname = resolved.pathname;
    testLocation.href = resolved.href;
  } catch {
    // Ignore urls a browser would reject too.
  }
}

export const testHistory: TestHistory = {
  state: null,
  pushState(state, _title, url) {
    this.state = state;
    applyUrl(url);
  },
  replaceState(state, _title, url) {
    this.state = state;
    applyUrl(url);
  },
};

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

define("window", testWindow);
define("document", testDocument);
define("navigator", testNavigator);
define("location", testLocation);
define("history", testHistory);
define("localStorage", testLocalStorage);
define("sessionStorage", testSessionStorage);

/** Restore every mutable global to the state a fresh page would have. */
export function resetTestEnvironment(): void {
  testLocalStorage.clear();
  testLocalStorage.throwOnSet = false;
  testSessionStorage.clear();
  testSessionStorage.throwOnSet = false;
  testDocument.visibilityState = "visible";
  testNavigator.language = "en-GB";
  testNavigator.languages = ["en-GB", "en"];
  testNavigator.onLine = true;
  testLocation.pathname = "/";
  testLocation.hostname = "app.example.com";
  testLocation.protocol = "https:";
  testLocation.href = "https://app.example.com/";
  testHistory.state = null;
}
