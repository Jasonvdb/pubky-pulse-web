import { afterEach, describe, expect, it } from "vitest";
import { collectDeviceInfo, type DeviceInfoFlags } from "../src/device-info";
import { resetTestEnvironment, testNavigator } from "./setup";

const DEFAULT_USER_AGENT = testNavigator.userAgent;

/** What `deviceInfo` defaults to: every browser-derived field collected. */
const ALL: DeviceInfoFlags = { os: true, browser: true, language: true };

/**
 * `collectDeviceInfo()` reads `globalThis.navigator`, so each row swaps the
 * stubbed user agent rather than passing one in. Edge and Opera are the rows
 * that pin the ordering invariant in `BROWSER_PATTERNS`: both user agents also
 * contain `Chrome/`, and every Chromium one contains `Safari`.
 */
const USER_AGENTS: Array<{
  label: string;
  ua: string;
  osVersion?: string;
  deviceModel?: string;
}> = [
  {
    label: "Windows Edge",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91",
    osVersion: "Windows NT 10.0",
    deviceModel: "Edge 120",
  },
  {
    label: "Windows Opera",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
    osVersion: "Windows NT 10.0",
    deviceModel: "Opera 105",
  },
  {
    label: "Android Chrome",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36",
    osVersion: "Android 14",
    deviceModel: "Chrome 120",
  },
  {
    label: "iOS Safari",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
    osVersion: "iOS 17.1.2",
    deviceModel: "Safari 17",
  },
  {
    label: "iOS Firefox",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15",
    osVersion: "iOS 17.1",
    deviceModel: "Firefox 121",
  },
  {
    label: "macOS without a version token",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36",
    osVersion: "macOS",
    deviceModel: undefined,
  },
  {
    label: "ChromeOS",
    ua: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    osVersion: "ChromeOS",
    deviceModel: "Chrome 119",
  },
  {
    label: "Linux Firefox",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    osVersion: "Linux",
    deviceModel: "Firefox 121",
  },
  { label: "empty user agent", ua: "", osVersion: undefined, deviceModel: undefined },
];

describe("collectDeviceInfo", () => {
  afterEach(() => {
    resetTestEnvironment();
    testNavigator.userAgent = DEFAULT_USER_AGENT;
  });

  it.each(USER_AGENTS)("parses the $label user agent", ({ ua, osVersion, deviceModel }) => {
    testNavigator.userAgent = ua;
    const info = collectDeviceInfo(ALL);

    expect(info.osVersion).toBe(osVersion);
    expect(info.deviceModel).toBe(deviceModel);
    if (osVersion === undefined) expect("osVersion" in info).toBe(false);
    if (deviceModel === undefined) expect("deviceModel" in info).toBe(false);
  });

  it("reports the browser locale", () => {
    const info = collectDeviceInfo(ALL);
    expect(info.locale).toBe("en-GB");
    expect(info.preferredLanguage).toBe("en-GB");
  });

  it("omits the supported languages unless they are configured", () => {
    const info = collectDeviceInfo(ALL);
    expect(info.supportedLanguages).toBeUndefined();
    expect("supportedLanguages" in info).toBe(false);
  });

  it("reports the configured supported languages", () => {
    expect(collectDeviceInfo(ALL, ["fr", "de"]).supportedLanguages).toEqual(["fr", "de"]);
  });

  it("collects nothing browser-derived when every flag is off", () => {
    const info = collectDeviceInfo({ os: false, browser: false, language: false });
    expect(info).toEqual({});
  });

  it.each([
    { flag: "os", off: ["osVersion"], on: ["deviceModel", "locale", "preferredLanguage"] },
    { flag: "browser", off: ["deviceModel"], on: ["osVersion", "locale", "preferredLanguage"] },
    { flag: "language", off: ["locale", "preferredLanguage"], on: ["osVersion", "deviceModel"] },
  ] as const)("omits only the $flag fields when $flag is off", ({ flag, off, on }) => {
    const info = collectDeviceInfo({ ...ALL, [flag]: false });

    for (const key of off) expect(key in info).toBe(false);
    for (const key of on) expect(info[key]).toBeDefined();
  });

  // Disabling every browser-derived field must not take the app's own shipped
  // locales with it: they come from configuration, not from the browser.
  it("still reports supported languages with every flag off", () => {
    const info = collectDeviceInfo({ os: false, browser: false, language: false }, ["fr"]);
    expect(info).toEqual({ supportedLanguages: ["fr"] });
  });
});
