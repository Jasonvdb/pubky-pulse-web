import { describe, expect, it } from "vitest";
import { createScreenNameMapper } from "../src/screen-name";

// The app can supply Object.values of its existing app/routes.ts enums instead.
const staticRoutes = [
  "/", "/home", "/hot", "/search", "/collections", "/collections/bookmarks",
  "/sign-in", "/logout", "/share", "/offline", "/copyright", "/who-to-follow", "/sentry-test",
  "/profile", ...["collections", "friends", "following", "profile", "tags", "tagged", "replies", "followers", "posts", "notifications"].map((tab) => `/profile/${tab}`),
  "/settings", ...["account", "edit", "notifications", "privacy-safety", "muted-users", "help"].map((tab) => `/settings/${tab}`),
  ...["backup", "install", "profile", "pubky", "scan", "human", "tags"].map((tab) => `/onboarding/${tab}`),
];
const mapper = createScreenNameMapper([
  "/profile/[pubky]", "/post/[userId]/[postId]", "/collections/[userId]/[postId]",
  "/feed/[id]", "/invite/[inviteCode]",
  ...["collections", "friends", "following", "profile", "tagged", "replies", "followers"].map((tab) => `/profile/[pubky]/${tab}`),
  ...staticRoutes,
]);

// Original Pubky App PR #1 route privacy cases, preserved unchanged in meaning.
const PUBLIC_KEY = "public-key";
describe("createScreenNameMapper", () => {
  it.each([
    ["/", "/"],
    ["/home/", "/home"],
    ["/search?q=private#secret", "/search"],
    ["/settings/privacy-safety", "/settings/privacy-safety"],
    ["/onboarding/backup", "/onboarding/backup"],
    ["/profile/followers", "/profile/followers"],
    ["/profile/posts", "/profile/posts"],
    ["/profile/notifications", "/profile/notifications"],
    [`/profile/${PUBLIC_KEY}`, "/profile/[pubky]"],
    [`/profile/${PUBLIC_KEY}/followers`, "/profile/[pubky]/followers"],
    [`/post/${PUBLIC_KEY}/private-post`, "/post/[userId]/[postId]"],
    [`/collections/${PUBLIC_KEY}/private-post`, "/collections/[userId]/[postId]"],
    ["/collections/bookmarks", "/collections/bookmarks"],
    ["/feed/private-feed", "/feed/[id]"],
    ["/invite/private-code", "/invite/[inviteCode]"],
    ["/unknown/private-path", "/unknown"],
    ["/profile/user/private-tab", "/unknown"],
    ["/settings/private-setting", "/unknown"],
  ])("preserves app privacy for %s", (path, expected) => {
    expect(mapper(path)).toBe(expected);
  });

  it.each([
    ["/profile/followers///?secret#token", "/profile/followers"],
    ["/profile/%66ollowers", "/profile/followers"],
    ["/profile/%E2%98%83", "/profile/[pubky]"],
    ["/profile/%252Fsecret", "/profile/[pubky]"],
    ["/profile/%2fsecret", "/unknown"],
    ["/profile/%5csecret", "/unknown"],
    ["/profile/%00secret", "/unknown"],
    ["/profile/%20secret", "/unknown"],
    ["/profile/%", "/unknown"],
    ["/profile/%C0%AF", "/unknown"],
    ["/profile/..", "/unknown"],
    ["/profile/%2e", "/unknown"],
    ["/profile//secret", "/unknown"],
    ["/profile/secret\\another", "/unknown"],
    ["https://app.example/profile/secret", "/unknown"],
    ["//profile/secret", "/unknown"],
    ["profile/secret", "/unknown"],
    ["", "/unknown"],
    ["?secret", "/unknown"],
  ])("normalizes safely: %s", (path, expected) => {
    expect(mapper(path)).toBe(expected);
  });

  it("uses a caller-owned fallback and tolerates malformed runtime input", () => {
    const custom = createScreenNameMapper(["/home"], { fallback: "Other screen" });
    expect(custom("/private/path")).toBe("Other screen");
    expect(custom(null as unknown as string)).toBe("Other screen");
  });

  it("chooses the most specific match independently of definition order", () => {
    const routes = ["/[section]/[id]", "/profile/[id]", "/profile/followers"];
    for (const definitions of [routes, [...routes].reverse()]) {
      const map = createScreenNameMapper(definitions);
      expect(map("/profile/followers")).toBe("/profile/followers");
      expect(map("/profile/secret")).toBe("/profile/[id]");
    }
  });

  it.each(["/[...rest]", "/[[id]]", "/[[...rest]]", "/prefix-[id]", "/:id", "/*", "/bad%", "//bad", "/bad?query", "/bad#fragment", "/bad/../path"])("rejects unsupported template %s", (template) => {
    expect(() => createScreenNameMapper([template])).toThrow();
  });

  it("rejects ambiguous overlaps but allows repeated identical constants", () => {
    expect(() => createScreenNameMapper(["/[a]/fixed", "/fixed/[b]"])).toThrow("ambiguous");
    expect(() => createScreenNameMapper(["/profile/[a]", "/profile/[b]"])).toThrow("ambiguous");
    expect(createScreenNameMapper(["/home", "/home/"])("/home")).toBe("/home");
    expect(() => createScreenNameMapper([], { fallback: " " })).toThrow();
  });
});
