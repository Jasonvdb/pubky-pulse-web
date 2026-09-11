# Pubky Pulse web SDK

[![test](https://github.com/Jasonvdb/pubky-pulse-web/actions/workflows/test.yml/badge.svg)](https://github.com/Jasonvdb/pubky-pulse-web/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`@synonymdev/pubky-pulse-web` is the browser client for [Pubky Pulse](https://github.com/Jasonvdb/pubky-pulse):
events, errors, metrics, funnels, identity, feedback and questionnaires from any web app, batched
and sent to your own Pulse server. It is framework-agnostic TypeScript with no runtime
dependencies, no UI and no framework bindings — you call it from wherever your app already lives.

## Install

```sh
npm install @synonymdev/pubky-pulse-web
```

## Quick start

Initialize early, then log from anywhere. `init`, `captureException`, `ignoreErrors`, origin URL
mode and the route helper are included in this source version; use a package release containing
these APIs before adopting the examples (they are not in 0.5.1).

```ts
import { Pulse } from "@synonymdev/pubky-pulse-web";

Pulse.init({ apiKey: "pulse_client_…" });

Pulse.info("signed_up", { plan: "pro" });
```

Leaving `endpoint` out sends the events to Pubky's hosted instance at
`https://ingest.pubkypulse.com`. Nothing warns you when that happens, so if you run your own Pubky
Pulse you must pass your own ingest host or your data goes to Pubky's instance instead of yours.
The default needs 0.2.0 or newer; on 0.1.1 and earlier `endpoint` is still required.

The client key identifies exactly one Pulse app; web apps do not need a bundle identifier.
Client-key-only setup requires a server that accepts requests without `bundle_id`. Self-hosters
must deploy that server update before upgrading clients to omit the identifier. Until then, keep
passing the existing `bundleId` for compatibility with older servers. Updated servers skip
identifier validation for keys belonging to web or backend apps, even when the supplied value
differs from the app's identifier. For Apple or Android app keys, a supplied identifier must match
the registered one; an absent identifier is accepted. There is no identifier lookup request during
configuration.

### Safe optional initialization

```ts
const result = Pulse.init({
  apiKey: import.meta.env.VITE_PULSE_KEY,
  enabled: import.meta.env.MODE !== "test", // Your deployment/test policy.
});
// result.status: "enabled", "disabled", or "error"; result.reason is a safe diagnostic code.
```

An absent, null, empty or whitespace key, or `enabled: false`, disables tracking. No browser/SSR
is a safe no-op. Disabled initialization creates no identity/session, reads or writes no storage,
installs no listeners/timers/fetch wrapper, and neither replays nor sends events. A later valid
browser `init` still works. `captureException` is a quiet no-op before initialization and while disabled.

The first successful initialization wins. Equivalent normalized options return `unchanged` without
restarting a session; callback identity matters. Changed valid options return `configuration-ignored`
and keep the running client. To change options, use `await Pulse.shutdown()` (which drains), then
`init` again, or disable first when queued events must be discarded.

`Pulse.init({ enabled: false })` stops an active client and discards its pending in-memory telemetry
without flushing or parking it. It leaves pre-existing browser storage intact; a later enabled
initialization can replay that old queue. Already transmitted requests cannot be recalled.
Initialization failures roll back installed collectors and return `error`. Invalid configuration
returns `invalid-configuration`; a supplied invalid endpoint never falls back to the hosted service.
An invalid reinitialization preserves an already-running valid client. Diagnostics contain no keys,
endpoint values or caught exceptions. Inspect the returned status instead of adding try/catch.

Existing `Pulse.configure()` remains the strict API: configuration errors throw, including during
SSR, and valid repeated calls explicitly replace the configuration. Existing logger calls before
configuration retain their one-time console note; `captureException` never emits that note.

## Host application boundaries

Logging, metrics, screen tracking, attachment work and SDK diagnostics are best effort. Telemetry
failures are contained and can drop data. History cleanup preserves hooks installed by other libraries;
retained Pulse wrappers become inactive. These protections cannot guarantee recovery from browser
memory exhaustion or interrupt a nonterminating application callback.

Keep handling intentional API failures: strict `Pulse.configure()` can throw, invalid `setUser()`
input rejects, and feedback/questionnaire requests reject on validation or request failure. Use
`await` with your application's error handling, or attach `.catch(...)` when deliberately not awaiting.
`Pulse.init()` reports setup failures through its result instead.

## Use it in your environment

### Static page

```html
<script type="module">
  import { Pulse } from "https://esm.sh/@synonymdev/pubky-pulse-web";

  Pulse.init({ apiKey: "pulse_client_…" });

  document.querySelector("#buy").addEventListener("click", () => {
    Pulse.info("buy_clicked");
  });
</script>
```

There is a runnable version of this in [`examples/vanilla/index.html`](./examples/vanilla/index.html):
build the package with `npm run build`, then serve the repository over HTTP — `npx serve .` or
`python3 -m http.server` — and open `http://localhost:3000/examples/vanilla/index.html` (port 8000
for `http.server`). The page imports the built SDK as a module, so opening it straight from disk
over `file://` leaves it dead. Fill in your key and endpoint there and watch the events stream;
the optional bundle id field is only needed when connecting to an older server, and
the origin you serve it from must be in the app's allowed origins.

### React

No provider and no context — `Pulse` is a module singleton. Initialize in your root component;
repeated effects with equivalent options retain the same session.

```tsx
import { useEffect } from "react";
import { Pulse } from "@synonymdev/pubky-pulse-web";

export function App() {
  useEffect(() => {
    Pulse.init({
      apiKey: import.meta.env.VITE_PULSE_KEY,
      appVersion: __APP_VERSION__,
    });
  }, []);

  return <Routes />;
}
```

If your router does not use the History API (some hash routers do not), turn `trackPageViews` off
and call `Pulse.trackScreen(name)` from your route change handler instead.

### Next.js App Router

`init()` is safe during SSR and with an absent key. Initialize in a client effect to start
browser capture; no browser, missing-key or session guard is needed.

```tsx
// app/pulse-provider.tsx
"use client";

import { useEffect } from "react";
import { Pulse } from "@synonymdev/pubky-pulse-web";

export function PulseProvider({ userId }: { userId?: string }) {
  useEffect(() => {
    Pulse.init({
      apiKey: process.env.NEXT_PUBLIC_PULSE_KEY,
      enabled: process.env.NODE_ENV !== "test",
      propagateSessionTo: ["/api"],
    });
  }, []);

  useEffect(() => {
    if (userId) void Pulse.setUser(userId);
  }, [userId]);

  return null;
}
```

```tsx
// app/layout.tsx
import { PulseProvider } from "./pulse-provider";
import { getSession } from "@/lib/session";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <html lang="en">
      <body>
        <PulseProvider userId={session?.userId} />
        {children}
      </body>
    </html>
  );
}
```

`propagateSessionTo: ["/api"]` adds an `X-Pulse-Session-Id` header to every request whose URL starts
with `/api`. The header is added by wrapping the global `fetch`, so only requests that go through it
are annotated. Read it in your route handlers with the
[Node SDK](https://github.com/Jasonvdb/pubky-pulse-node) and the browser session and the server
session become one trace:

```ts
// app/api/checkout/route.ts
import { Pulse } from "@synonymdev/pubky-pulse-node";

export async function POST(req: Request) {
  const log = Pulse.withUser(await currentUserId()).withSession(
    req.headers.get("x-pulse-session-id"),
  );

  log.info("checkout_started");
  return Response.json({ ok: true });
}
```

### SvelteKit

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { Pulse } from "@synonymdev/pubky-pulse-web";
  import { PUBLIC_PULSE_KEY } from "$env/static/public";

  onMount(() => {
    Pulse.init({
      apiKey: PUBLIC_PULSE_KEY,
    });

    return () => void Pulse.shutdown();
  });
</script>

<slot />
```

### Angular

```ts
// src/app/app.config.ts
import { APP_INITIALIZER, type ApplicationConfig } from "@angular/core";
import { Pulse } from "@synonymdev/pubky-pulse-web";
import { environment } from "../environments/environment";

export const appConfig: ApplicationConfig = {
  providers: [
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => () => {
        Pulse.init({
          apiKey: environment.pulseKey,
          appVersion: environment.version,
        });
      },
    },
  ],
};
```

### Any other framework

There is nothing framework-specific in the package: import `Pulse`, call `init()` early,
and log from anywhere. That is the whole integration.

## Events and levels

Four levels, all with the same shape: a message, optional attributes, and optional per-call options.

```ts
Pulse.debug("cache_hit", { key: "profile" });
Pulse.info("signed_up", { plan: "pro" });
Pulse.warn("slow_response", { ms: 2400 });
Pulse.error("payment_declined", { code: "insufficient_funds" });
```

Keep messages short and stable — they are what you group by on the server. Attribute values are
converted to strings; `undefined` and `null` values are dropped, so you can pass optional fields
straight through. Per call you can override the screen and attach files:

```ts
Pulse.info("exported_report", { rows: 940 }, { screenName: "Reports" });
```

While `consoleLogging` is on, every event is mirrored to the console as
`[pulse] INFO signed_up {plan=pro}`. The SDK's own lifecycle messages (anything starting with
`sdk:`) stay out of the console so your log stays readable.

## Screens and route tracking

With `trackPageViews` on (the default), the SDK patches `pushState`/`replaceState` and listens for
`popstate`, using `location.pathname` as the screen name by default. Hash-only and query-only
History API changes are ignored.

For routes containing identifiers, compile explicit app-owned templates into the existing
`screenNameForPath` hook. Reuse your routing constants for safe static routes:

```ts
import { createScreenNameMapper, Pulse } from "@synonymdev/pubky-pulse-web";

const screenNameForPath = createScreenNameMapper([
  "/", "/home", "/profile/followers", "/profile/[pubky]", "/invite/[inviteCode]",
], { fallback: "/unknown" });

Pulse.init({ apiKey: "pulse_client_YOUR_KEY", screenNameForPath });
```

The helper returns only a literal template or the fallback (default `/unknown`). `/profile/followers`
beats `/profile/[pubky]`, regardless of list order. Whole-segment `[name]` matches exactly one
nonempty segment; catch-all, optional and partial-segment syntax are unsupported. More static
segments win; equally specific overlapping templates throw during helper creation. Duplicate
identical constants are accepted. Templates and fallback must be safe app-owned labels.

Trailing slashes and query/fragment are excluded. Segments are decoded once for matching, so
`/profile/%66ollowers` matches the static route. Invalid escapes, encoded separators, dot segments,
whitespace/control characters, repeated interior slashes, and absolute URLs return the fallback.
Only configured template text is emitted, never decoded parameter values. Invalid template
configuration throws. See the [Pubky App migration example](./examples/pubky-app.md) for reuse of
real route constants and the before/after reduction in integration code.

A custom synchronous `screenNameForPath` callback remains supported without the helper.
The callback receives only the pathname, without a query string or hash, on initial load and
`pushState`, `replaceState`, and `popstate` navigation. Its returned name is used for automatic
screen events, duration attribution, and the default `screen_name` on subsequent events. Moving
between two paths mapped to the same name keeps the current screen and its duration running.

Return a nonblank string. If the callback throws or returns a blank or non-string value, the
previous screen ends and default screen attribution is cleared until a valid automatic or
manual screen is entered. The SDK does not fall back to the raw pathname or report the callback's
error. Nonblank names are preserved as returned. Omitting the callback preserves raw-path
tracking; setting `trackPageViews: false` disables the callback along with automatic tracking.
This callback only controls automatic screen naming; it does not sanitize network URLs or
arbitrary event attributes.

For anything the URL does not describe — a modal, a wizard step, a tab — name it yourself:

```ts
Pulse.trackScreen("Checkout / Payment");
```

`trackScreen` also sets the default `screen_name` for the events that follow, until the next screen
change. Manual names and per-event `screenName` overrides are used directly, without calling
`screenNameForPath`.

## Errors

`Pulse.captureException(error)` accepts any thrown value and extracts the type, stack and up to
five levels of `cause`. It is a quiet no-op before initialization, while disabled and during SSR:

```ts
try {
  await pay(order);
} catch (err) {
  Pulse.captureException(err);
}
```

The optional `PulseCaptureExceptionOptions` argument accepts an explicit replacement message and
attributes, without automatically serializing arbitrary error properties:

```ts
Pulse.captureException(err, {
  message: "checkout failed",
  attributes: { checkout_stage: "payment" },
});
```

`Pulse.error(message, attributes?)` still works when you have no error object. Uncaught exceptions
and unhandled promise rejections are captured automatically while `captureUnhandled` is on, tagged
with `_unhandled`, and re-thrown as usual — the SDK never swallows an error.

## Filtering and sanitizing events

Configure `ignoreErrors` for shared error patterns and `beforeSend(event, hint)` for your
application's redaction and metadata policy:

```ts
import { IGNORED_BROWSER_ERRORS } from "./observability-policy";

Pulse.init({
  apiKey: "pulse_client_…",
  ignoreErrors: IGNORED_BROWSER_ERRORS, // The same app-owned list can be passed to Sentry.
  networkTracking: { urlMode: "origin" },
  beforeSend(event, hint) {
    const original = hint.originalException;
    if (original instanceof AppError) {
      if (shouldDropAppError(original)) return null;
      event.custom_attributes = {
        ...event.custom_attributes,
        app_error_code: original.code, // Explicit allowlist; never spread the Error/context.
      };
    }
    event.message = redact(event.message);
    event.custom_attributes = redactAttributes(event.custom_attributes);
    return event;
  },
});
```

`AppError`, the drop policy, redaction functions and the ignore list are app-owned; the SDK
contains no Pubky App-specific exclusions. String rules use substring matching against the complete
message and `Type: message`; regular expressions test both. Global/sticky expressions are reset
for each match without changing the caller's `lastIndex`. This documents matching semantics only,
not full Sentry compatibility. Invalid rules fail configuration validation.

Ignored error captures and error-level logger calls are filtered before the hook, truncation,
console, buffering, persistence and attachment scheduling. Lower-level events remain unaffected;
error-level network and metric events are also filtered when their messages match. For Error
instances, duplicate suppression runs before filtering: the same
Error object is attempted at most once per configured client lifetime, even when a hook drops it
or throws. A WeakSet does not retain objects; a new configuration clears it. Distinct Error objects
with the same message and repeated primitive throws remain reportable.

Hints provide the original thrown value for exception capture, automatic error paths and the
automatic `sdk:network_request` event of a failed or cancelled fetch. Plain logger and other SDK
events receive an empty hint. The SDK uses hints only during the synchronous hook:
they are not part of the event, persisted, uploaded, buffered or retained for replay. Do not copy
`hint.originalException` into the event. One-argument hooks remain compatible.

The synchronous callback receives the fully enriched `LogEvent`. Return the mutated event or a
replacement with valid required fields; return `null` to drop it and its attachment uploads.
Only the returned event reaches the console, memory buffer, offline storage, and transport.
The hook receives complete message and attribute strings, including extracted error metadata;
message and attribute length limits apply only after it returns. Hook exceptions, invalid results, and accidental
async callbacks drop silently; recursive Pulse logging from inside the callback is ignored.
Without the hook, capture behaves as before.

The hook runs once when an event is captured, including lifecycle events emitted during initialization.
Retries and previously queued events are not processed again, so installing a new hook does not
sanitize an old offline queue. Use the returned event's IDs consistently if changing them: attachment
reservations use its `client_event_id` and `user_id`. Attachment contents and filenames, identity and
user-property requests, feedback bodies, and questionnaire answers do not pass through this hook.
The feedback audit log does. Redaction rules for messages and attributes belong to the application;
the example above demonstrates explicit error policy and metadata selection.

## Metrics and operations

`startOperation` measures something with a beginning and an end. It emits `metric:<slug>:start` now
and exactly one terminal event later, both carrying the same `tracking_id`:

```ts
const operation = Pulse.startOperation("image-upload", { source: "camera" });

try {
  await upload(file);
  operation.complete({ bytes: String(file.size) });
} catch (err) {
  operation.fail(err);
}
```

`operation.cancel()` records work the user abandoned, which is not the same as a failure. Finishing
is idempotent: a late `complete()` after a `fail()` is ignored. For a measurement you already have,
use `Pulse.recordMetric("cold-start", { duration_ms: "820" })`.

Metric names are slugs: `^[a-z0-9-]+$`. Anything else is lowercased and normalised for you, with one
warning so you can fix the name.

## Funnels

```ts
Pulse.step("onboarding_email");
Pulse.step("onboarding_verify", { attempt: "2" });
Pulse.step("onboarding_done");
```

Each call logs `step:<name>` at info level. Use the same names every time and the server can draw
the drop-off between them.

## Identity

Every browser gets an anonymous id at `configure()` time and events are attributed to it right away.
When the person signs in, `setUser` flushes what is buffered, claims the anonymous history
server-side, and then switches the id — so the session that led to the sign-up is not orphaned.

```ts
await Pulse.setUser(user.id);

Pulse.currentUserId; // the id now stamped on events
Pulse.sessionId; // current session, e.g. to send to your own backend

Pulse.clearUser({ newAnonymousId: true }); // sign-out on a shared device
```

Call `setUser` on every page load where you know who the user is; the claim is idempotent.

The promise waits for the flush and the claim request attempts. Those retry with exponential
backoff, so against an endpoint that is failing or hanging the await can take a couple of minutes.
When the browser is offline nothing is attempted: `setUser` returns straight away and the claim is
retried on the next `configure()`. Don't await it on a sign-in path that has to stay responsive:

```ts
void Pulse.setUser(userId); // fire and forget; the id is switched when the claim settles
```

## User properties

```ts
await Pulse.setUserProperties({
  plan: "pro",
  company: "Acme",
  trial_ends: "", // an empty value deletes the property
});
```

Buffered events are flushed first, so the properties attach to the same id those events carry.
The promise resolves once the attempt finishes, not once the server has accepted the properties:
a rejected request is dropped, and an unreachable one is retried a few times with backoff and then
dropped. Neither throws — turn on `debug` to see the drops.

Like `setUser`, the promise waits for the request attempts, and the retry backoff means it can take
a couple of minutes when the endpoint is failing or hanging. Offline it returns straight away
without sending. Use `void Pulse.setUserProperties({ ... })` when the caller does not need to wait.

## Feedback

```ts
const receipt = await Pulse.sendFeedback(message, {
  name: form.name,
  email: form.email,
});

console.log(receipt.id, receipt.createdAt);
```

Feedback is a single attempt with no retry — someone is waiting on the result — so handle the
rejection and let them try again. Messages are trimmed and capped at 4000 characters.

## Questionnaires

Fetch a questionnaire by slug, render it however you like, and save the answers. The SDK ships the
data and the answer bookkeeping; the form is yours.

```ts
import { Pulse, type PulseQuestionnaire } from "@synonymdev/pubky-pulse-web";

const result = await Pulse.fetchQuestionnaire("nps-q3");

if (result.ineligibleReason) {
  // "already_responded" | "globally_dismissed" | "inactive" — not an error
  return;
}

showSurvey(result.questionnaire!, result.inProgress?.answers);
```

Being ineligible is a normal outcome. An unknown slug or a failed request throws a
`PulseQuestionnaireError` with a `reason` you can branch on.

The answer helpers are pure functions over a plain object, so they work with React state, a Svelte
store or bare DOM alike:

```tsx
import {
  Pulse,
  collected,
  createAnswerStore,
  firstUnansweredIndex,
  hasAllRequired,
  isAnswered,
  setAnswer,
  type PulseQuestionnaire,
  type PulseQuestionnaireAnswers,
  type PulseQuestionnaireAnswerStore,
} from "@synonymdev/pubky-pulse-web";

function Survey({ questionnaire, draft }: { questionnaire: PulseQuestionnaire; draft?: PulseQuestionnaireAnswers }) {
  const [answers, setAnswers] = useState<PulseQuestionnaireAnswerStore>(() =>
    createAnswerStore(draft),
  );
  const [index, setIndex] = useState(() => firstUnansweredIndex(answers, questionnaire.schema));

  const question = questionnaire.schema.questions[index];

  function answer(value: string | string[] | number) {
    const next = setAnswer(answers, question.id, value);
    setAnswers(next);
    // Always send the full accumulated set; a draft save is cheap.
    void Pulse.saveQuestionnaireResponse(
      questionnaire.slug,
      collected(next, questionnaire.schema),
      false,
    );
  }

  async function submit() {
    const receipt = await Pulse.saveQuestionnaireResponse(
      questionnaire.slug,
      collected(answers, questionnaire.schema),
      true,
    );
    if (receipt.wasSubmitted) showThanks();
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>{question.title}</h2>
      {question.subtitle && <p>{question.subtitle}</p>}
      {/* render by question.type: text, single_choice, multi_choice, rating, nps */}
      <button type="button"
              disabled={question.required && !isAnswered(answers, question)}
              onClick={() => setIndex(index + 1)}>
        Next
      </button>
      <button type="submit" disabled={!hasAllRequired(answers, questionnaire.schema)}>
        Submit
      </button>
    </form>
  );
}
```

`await Pulse.dismissQuestionnaires()` opts the current user out of every questionnaire and returns
the timestamp the server recorded.

## Attachments

Attach a `Blob`, a `File` or a `Uint8Array` to a single event. The file is hashed and uploaded out
of band; uploading does not hold up the event's network batch. Accepted typed-array data is copied
synchronously into a bounded snapshot before it is queued.

```ts
Pulse.error(err, "import failed", { rows: "1200" }, {
  attachments: [{ data: file, filename: "import.csv", contentType: "text/csv" }],
});
```

Uploads need `crypto.subtle`, which browsers only expose in a secure context. Over plain HTTP they
are skipped with a debug note; the event still goes out.

The browser limit is **5 MiB per file**, reduced intentionally from the earlier 2 GiB ceiling. Across
active and pending attachments, one loaded SDK module admits **20 files and 20 MiB of payload**,
including work retained across disable/reinitialization. New excess files are dropped before reading
or hashing; each enqueue inspects at most the first 20 entries. Server quotas can be smaller; server
wire formats and the Node.js, Swift and Android SDK limits are unchanged.

Metadata is snapshotted when accepted. Filenames over 1,024 UTF-16 code units or content types over
255 are rejected, without truncation. `Uint8Array` data is copied so a small subarray cannot retain a
large backing buffer or change after enqueue. Blob sizes are checked before reading; Blob uploads
still use the original Blob as the request body. The payload budget is not a total browser heap cap:
hashing and platform operations can hold additional working memory.

`Pulse.flush()` and `Pulse.shutdown()` wait up to 120 seconds for attachments. Each background item
also has a 120-second waiting deadline, with PUT requests limited to 80 seconds. A noncancelable
Blob read, hash, or request may outlive that wait: its payload reservation remains occupied until the
underlying operation settles. Stop drops pending items and aborts requests; canceled items do not
advance to later upload stages. Remaining accepted background work can continue after a flush returns.

## Network tracking

```ts
Pulse.init({
  // …
  networkTracking: { urlMode: "origin" },
  propagateSessionTo: ["https://api.example.com"],
});
```

`networkTracking` defaults to `false`. `true` or `{ urlMode: "path" }` retains the existing
behavior: credentials, query and fragment are stripped but paths remain. `{ urlMode: "origin" }`
keeps only protocol, hostname and port for HTTP(S), resolving relative URLs against the page.
Malformed or non-HTTP(S) URLs omit `_http_url`; the raw value is never used as an origin fallback.
The mode applies before `beforeSend`, buffering, console or offline persistence, including failures.

The `sdk:network_request` event reports available method, status and duration: debug for 2xx/3xx, warn for
other responses, error with status `0` when the request fails — a network failure, a timeout, or an
abort with a custom reason — and debug with status `0` when the request is intentionally cancelled
and rejects with a default `AbortError`. The failure event's `beforeSend` hint carries the original
rejection as `originalException`, so apps can classify further. SDK endpoint requests remain excluded.
The application's request URL, body and headers are unchanged except for explicitly requested
session propagation; response and rejection values retain their identity and normal fetch behavior.
Origin hostnames may themselves contain identifiers. This is not a general PII guarantee: app
redaction may still be needed. Removing paths also groups network issues more broadly by host/method.

Only requests made through the global `fetch` are wrapped. `XMLHttpRequest`, `navigator.sendBeacon`
and libraries that use their own XHR adapter (axios in its default browser build, say) are invisible
to both the events and the header below.

`propagateSessionTo` lists URL prefixes that receive the `X-Pulse-Session-Id` header, and works
whether or not `networkTracking` is on — the same `fetch` wrapper is installed when either is set.
Only list origins you control: the header should not leak to third parties. Propagation and metadata
are best effort when an input or host API cannot be safely inspected. Method metadata is captured
only when the underlying fetch or another wrapper reads `init.method`, preserving getter receiver,
read count and native conversion order. Primitive string methods, including ordinary POSTs, are
reported; methods requiring extra coercion or never read by a wrapper can omit `_http_method`.

Instrumentation forwards `RequestInit` through a distinct object to observe reads safely. Tracking
alone forwards wrapper writes/deletions to the original options; propagation uses local overrides.
Inherited/non-enumerable fields, streams and abort signals remain available. Explicitly freezing a
propagation facade can skip the optional header. Code relying on options-object identity or exotic
Proxy reflection needs integration testing; universal Proxy transparency is not promised. Treat the
header as optional at the receiving API.

## Flush and shutdown

Batches are sent every `flushIntervalMs`, or as soon as `flushThreshold` events are buffered. You
rarely need to intervene, but both are available:

```ts
await Pulse.flush(); // attempt queued events and wait within the attachment deadline
await Pulse.shutdown(); // flush, then remove every page hook the SDK installed
```

When the page is hidden or unloaded the SDK flushes on its own with a `keepalive` request and parks
whatever does not fit — including the batch that was still waiting out a retry — in an offline queue
in `localStorage`, which is drained on the next page load. Events logged while the browser reports
itself offline queue up rather than fail.

That queue is shared by every tab on the origin, so the SDK serialises its reads and writes with the
[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). The unload path has
no turn left in which to wait for a lock, so it writes its leftovers to a key of its own that the
next flush folds back in and removes. While a `Retry-After` the server asked for is still running it
sends nothing at all and parks everything instead, so a page merely going hidden cannot talk the SDK
out of the delay.

A failed request is retried with exponential backoff, one second doubling to thirty. A `Retry-After`
header on a `429` or a `503` extends that wait — it never shortens it — to at most a minute. A batch
still undelivered after six attempts is parked. Ingest deduplicates on the event id, so a batch that
was both parked and sent is counted once.

Event resource limits also apply independently of event counts: **128 KiB of serialized JSON per
event**, **4 MiB in the queued event buffer**, and a **1 MiB offline queue budget**. A separate
in-flight batch can retain up to **2.5 MiB**; these payload limits are not a total heap cap. The oldest
buffered events are dropped to make room; an oversized event is dropped before attachment scheduling. At most 100
own attributes are inspected, and keys longer than 256 UTF-16 code units are skipped. `beforeSend`
still receives full message and admitted attribute strings; string truncation and the event byte
check happen after the hook returns.

Offline storage keeps bounded payloads across the shared key and unload spill keys. An unload write
cannot rewrite the shared key without its lock, so fresh events may be dropped when it fills the
budget. Cross-tab aggregate limits are best effort during concurrent unloads; storage quota failures
can also discard telemetry. Increasing `maxBufferSize` does not increase these byte limits.

## Configuration

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `endpoint` | `string` | `https://ingest.pubkypulse.com` | Pubky's hosted ingest host; a trailing slash is stripped. Self-hosters must set their own server URL explicitly. |
| `apiKey` | `string` | — | Client key with `pulse_client_` prefix. Required by `configure`; absent/null/blank disables `init`. |
| `enabled` | `boolean` | `true` | `init` only: false stops tracking without flushing new telemetry. |
| `bundleId` | `string` | Not sent | Optional legacy identifier for older servers. Updated servers identify the app from the client key alone. |
| `appVersion` | `string` | — | Version reported with every event. |
| `isDev` | `boolean` | `true` on `localhost`, `127.0.0.1` or `file:` | Marks events as development traffic. |
| `debug` | `boolean` | `false` | Print the SDK's own diagnostics to the console. |
| `consoleLogging` | `boolean` | `true` | Mirror logged events to the console. |
| `compressionEnabled` | `boolean` | `true` | gzip request bodies where the browser supports it. |
| `captureUnhandled` | `boolean` | `true` | Capture uncaught errors and unhandled rejections. |
| `trackPageViews` | `boolean` | `true` | Emit screen events for History API navigations. |
| `screenNameForPath` | `(pathname: string) => string` | Raw pathname | Map automatic screen names; a thrown error or blank/non-string result ends the previous screen and clears default attribution. |
| `ignoreErrors` | `(string \| RegExp)[]` | `[]` | Filter exception/error logger messages before hooks and output. |
| `beforeSend` | `(event: LogEvent, hint: PulseEventHint) => LogEvent \| null` | Not set | Transform or drop enriched events before output, buffering, and attachment scheduling. Synchronous only; failures drop silently. |
| `networkTracking` | `boolean \| { urlMode?: "path" \| "origin" }` | `false` | Emit an event per `fetch`; true and an empty object preserve sanitized paths. |
| `propagateSessionTo` | `string[]` | `[]` | URL prefixes that receive `X-Pulse-Session-Id`. |
| `flushIntervalMs` | `number` | `5000` | Milliseconds between automatic flushes. |
| `flushThreshold` | `number` | `20` | Buffered events that trigger an immediate flush. |
| `maxBufferSize` | `number` | `10000` | Buffered event count ceiling; the separate 4 MiB byte cap can drop oldest events sooner. |
| `sessionTimeoutMs` | `number` | `1800000` | Idle time after which a new session starts. |
| `supportedLanguages` | `string[]` | not sent | The locales your app ships. Written through to the app record on the server and used for localization-gap analysis. Set it explicitly; the SDK never derives it from the browser. |

Invalid values throw at `configure()` time with a `Pubky Pulse: …` message, so a typo surfaces on
the first page load. `init()` catches these failures and returns a diagnostic status instead.

## Server setup

1. In your Pulse dashboard, create an app with platform `web`. Its client key identifies the app;
   you do not need to copy an app identifier into the SDK configuration.
2. Add the site's origin to the app's allowed origins in the dashboard, including the development
   port (`http://localhost:5173`, say). `CORS_ORIGINS` configures the dashboard itself.
3. Copy the app's client key. It starts with `pulse_client_`, is meant to ship in your bundle and is
   public: it is ingest-scoped, so it can write events, feedback and user data for this one app and
   read that app's questionnaire specs, and it cannot read back events, metrics or project data.
   Never put a server key (`pulse_secret_…`) in a browser.

## Browser support and SSR

Any evergreen browser — Chrome, Edge, Firefox and Safari — is supported; the build targets ES2020.
Three features degrade rather than break:

- **gzip** needs `CompressionStream`. Where it is missing, bodies are sent as plain JSON. Bodies
  under 512 bytes and the unload path are never compressed anyway.
- **Attachments** need `crypto.subtle`, which requires a secure context (HTTPS or `localhost`).
  Elsewhere uploads are skipped and the event is still sent.
- **Cross-tab queue locking** needs the Web Locks API. Without it the offline queue is written
  unlocked, which is what every earlier version did: correct in one tab, and able to lose parked
  events only when two tabs happen to flush at the same instant.

The package is safe to import on the server. `init()` returns a disabled SSR result before
validation or side effects; `captureException()` is quiet there. `configure()` validates its configuration first, then
checks for `window` and, when there is none, returns without installing anything — so a Next.js or
SvelteKit server render with a valid configuration does no work. An invalid configuration still
throws during a server render, exactly as it would in the browser. Log calls made before a successful
`configure()` are ignored, so shared code that logs on both sides needs no guard of its own.

## Development

```sh
npm ci
npm run build
npm test
```

`npm run build` type-checks with `tsc --noEmit` and then bundles ESM, CJS and type declarations into
`dist/` with tsup. `npm test` runs the vitest suite against hand-written browser globals — no jsdom.

## License

MIT. See [LICENSE](./LICENSE).
