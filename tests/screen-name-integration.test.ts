import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pulse } from "../src/index";
import { createScreenNameMapper } from "../src/screen-name";
import type { IngestRequest, LogEvent } from "../src/types";
import { resetTestEnvironment, testLocation, testWindow } from "./setup";

let fetchMock: ReturnType<typeof vi.fn>;
const config = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_test",
  consoleLogging: false,
  compressionEnabled: false,
  flushThreshold: 1000,
};

function sentEvents(): LogEvent[] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith("/v1/ingest"))
    .flatMap((call) => (JSON.parse((call[1] as RequestInit).body as string) as IngestRequest).events);
}

beforeEach(() => {
  resetTestEnvironment();
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await Pulse.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("route templates with automatic screen tracking", () => {
  it("maps initial views, all navigation paths, durations, and event attribution", async () => {
    testLocation.pathname = "/profile/private-key";
    Pulse.configure({
      ...config,
      screenNameForPath: createScreenNameMapper([
        "/profile/[pubky]", "/profile/followers", "/invite/[inviteCode]", "/post/[userId]/[postId]",
      ]),
    });
    Pulse.info("initial");
    history.pushState(null, "", "/profile/followers");
    Pulse.info("followers");
    history.replaceState(null, "", "/invite/private-code?token=secret#fragment");
    Pulse.info("invite");
    testLocation.pathname = "/post/private-author/private-post";
    testWindow.dispatchEvent(new Event("popstate"));
    Pulse.info("post");
    history.pushState(null, "", "/unknown/private-path");
    Pulse.info("unknown");
    await Pulse.flush();

    const names = ["/profile/[pubky]", "/profile/followers", "/invite/[inviteCode]", "/post/[userId]/[postId]", "/unknown"];
    const events = sentEvents();
    expect(events.filter((event) => event.message === "sdk:screen_appeared").map((event) => event.screen_name)).toEqual(names);
    const durations = events.filter((event) => event.message === "sdk:screen_disappeared");
    expect(durations.map((event) => event.screen_name)).toEqual(names.slice(0, -1));
    for (const event of durations) expect(event.custom_attributes?._duration_ms).toMatch(/^\d+$/);
    expect(events.filter((event) => !event.message.startsWith("sdk:")).map((event) => event.screen_name)).toEqual(names);
    expect(JSON.stringify(events)).not.toMatch(/private-|secret|fragment/);
  });
});
