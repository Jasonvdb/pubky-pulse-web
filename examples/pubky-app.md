# Pubky App integration migration

This example derives from [Pubky App PR #1](https://github.com/Jasonvdb/pubky-app-pulse/pull/1).
Use a package release containing these APIs before applying it; 0.5.1 does not have them.
App-specific deployment decisions, error drop policy, metadata selection and redaction remain in
Pubky App. This example changes neither that PR nor its paused test environment.

Before, each initialization checked the browser, test environment, key and session, then caught
`configure` failures. Each error call passed through a guarded `capturePulseError` wrapper.
The hook iterated Sentry's ignore list, rewrote `_http_url`, and dropped recaptured errors by type.
After, initialization is one supported SDK call and factory/React-boundary call sites use
`Pulse.captureException(error)` directly:

```ts
import { Pulse } from "@synonymdev/pubky-pulse-web";
import { Env } from "@/libs/env/env";
import { AppError } from "@/libs/error/error";
import { IGNORED_BROWSER_ERRORS } from "@/libs/observability/sentry.constants";
import { sanitizeForSentry, shouldDropAppErrorFromSentry } from "@/libs/observability/sentry.utils";
import { getDeployEnv, getPulseClientKey, getPulseEndpoint } from "@/libs/runtime-config/runtime-config";

export function initPulse() {
  return Pulse.init({
    apiKey: getPulseClientKey(),
    endpoint: getPulseEndpoint(),
    enabled: Env.NODE_ENV !== "test" && !Env.VITEST,
    appVersion: Env.NEXT_PUBLIC_APP_VERSION,
    isDev: Env.NODE_ENV !== "production" || getDeployEnv() !== "production",
    consoleLogging: false,
    ignoreErrors: IGNORED_BROWSER_ERRORS,
    networkTracking: { urlMode: "origin" },
    screenNameForPath: pulseScreenName,
    beforeSend(event, hint) {
      const error = hint.originalException;
      if (error instanceof AppError) {
        if (shouldDropAppErrorFromSentry(error)) return null;
        // Keep only app-reviewed fields. Never spread error.context or the Error.
        event.custom_attributes = {
          ...event.custom_attributes,
          app_error_code: error.code,
        };
      }
      event.message = sanitizeForSentry(event.message) as string;
      event.custom_attributes = sanitizeForSentry(event.custom_attributes) as typeof event.custom_attributes;
      return event;
    },
  });
}
```

Check `result.status` and `result.reason` where local diagnostics are useful. The SDK does not catch
errors in app-owned getters before they are passed to `init`. Existing factory metadata allowlists
should move into the hook verbatim; the single `code` field above illustrates that boundary.
The same Error captured in a factory and later seen by a render boundary/global handler is attempted
once, even if the policy dropped it. A new Error with the same message remains reportable.

## Route privacy: reuse the application's definitions

The original `pulseScreenName` is a roughly 22-line matcher containing five static regular
expressions, four dynamic-route branches, captured-path reconstruction, normalization and fallback.
The replacement is an app-owned list, using the actual enums and `getProfileRoute` from
`src/app/routes.ts`. It needs no regex or extraction of a path parameter:

```ts
import { createScreenNameMapper } from "@synonymdev/pubky-pulse-web";
import {
  APP_ROUTES, AUTH_ROUTES, COLLECTION_ROUTES, COPYRIGHT_ROUTES, DEV_ROUTES,
  ONBOARDING_ROUTES, PROFILE_ROUTES, ROOT_ROUTES, SETTINGS_ROUTES, getProfileRoute,
} from "@/app/routes";

export const pulseScreenName = createScreenNameMapper([
  ROOT_ROUTES, "/offline", "/profile/tags",
  ...Object.values(APP_ROUTES).filter((route) => route !== APP_ROUTES.FEED),
  ...[AUTH_ROUTES, COLLECTION_ROUTES, COPYRIGHT_ROUTES, DEV_ROUTES,
    ONBOARDING_ROUTES, PROFILE_ROUTES, SETTINGS_ROUTES].flatMap(Object.values),
  ...Object.values(PROFILE_ROUTES).map((route) => getProfileRoute(route, "[pubky]")),
  "/post/[userId]/[postId]", "/collections/[userId]/[postId]",
  "/invite/[inviteCode]", "/feed/[id]",
], { fallback: "/unknown" });
```

This reuses eight static route groups and the existing profile-route generator. The input list
replaces every matching branch and all parameter reconstruction; new safe static routes are
maintained in the app's routing enums. Review additions to those enums as telemetry allowlist
changes. The explicit `APP_ROUTES.FEED` exclusion preserves the original `/feed` → `/unknown`
mapping while `/feed/[id]` continues to match individual feeds.

The SDK regression suite retains all 18 original PR privacy cases, including the static
`/profile/followers` collision, profile tabs, post/collection IDs, invite codes, and unknown routes.
Additional tests cover malformed/encoded paths and automatic initial views, push/replace/pop
navigation, durations and event screen attribution. Keep the app's original privacy tests when
adopting this example; the SDK cannot infer which app routes or metadata are safe.
