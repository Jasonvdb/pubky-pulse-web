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

Configure once, as early in the page's life as you can, then log from anywhere.

```ts
import { Pulse } from "@synonymdev/pubky-pulse-web";

Pulse.configure({ apiKey: "pulse_client_…" });

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

Calls made before `configure()` are ignored (one console note, then silence), so a stray log during
startup can never throw.

## Use it in your environment

### Static page

```html
<script type="module">
  import { Pulse } from "https://esm.sh/@synonymdev/pubky-pulse-web";

  Pulse.configure({ apiKey: "pulse_client_…" });

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
the origin you serve it from is the one that has to be in the server's `CORS_ORIGINS`.

### React

No provider and no context — `Pulse` is a module singleton. Configure once in your root component.

```tsx
import { useEffect } from "react";
import { Pulse } from "@synonymdev/pubky-pulse-web";

export function App() {
  useEffect(() => {
    Pulse.configure({
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

`configure()` needs `window`, so it lives in a client component. On the server it is a no-op, which
means an accidental import from a server component will not crash the render.

```tsx
// app/pulse-provider.tsx
"use client";

import { useEffect } from "react";
import { Pulse } from "@synonymdev/pubky-pulse-web";

export function PulseProvider({ userId }: { userId?: string }) {
  useEffect(() => {
    Pulse.configure({
      apiKey: process.env.NEXT_PUBLIC_PULSE_KEY!,
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
    Pulse.configure({
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
        Pulse.configure({
          apiKey: environment.pulseKey,
          appVersion: environment.version,
        });
      },
    },
  ],
};
```

### Any other framework

There is nothing framework-specific in the package: import `Pulse`, call `configure()` once after
the page has a `window`, and log from anywhere. That is the whole integration.

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

For routes containing identifiers, supply a synchronous `screenNameForPath` callback during
initialization. The SDK still observes navigation, so no framework-specific route observer is
needed:

```ts
Pulse.configure({
  apiKey: "pulse_client_YOUR_KEY",
  screenNameForPath(pathname) {
    if (pathname.startsWith("/profile/")) return "profile";
    if (pathname.startsWith("/post/")) return "post";
    if (pathname.startsWith("/collections/")) return "collections";
    if (pathname.startsWith("/invite/")) return "invite";
    return "other";
  },
});
```

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

Pass the error itself, not just a message, and the SDK extracts the type, the stack and up to five
levels of `cause` for you:

```ts
try {
  await pay(order);
} catch (err) {
  Pulse.error(err, "checkout failed", { order_id: order.id });
}
```

`Pulse.error(message, attributes?)` still works when you have no error object. Uncaught exceptions
and unhandled promise rejections are captured automatically while `captureUnhandled` is on, tagged
with `_unhandled`, and re-thrown as usual — the SDK never swallows an error.

## Filtering and sanitizing events

Configure `beforeSend` to apply your application's capture policy to manual logs and automatic
errors, network requests, screens, sessions, and metrics in one place:

```ts
Pulse.configure({
  apiKey: "pulse_client_…",
  beforeSend(event) {
    if (event.message === "ResizeObserver loop limit exceeded") return null;
    if (event.custom_attributes?._http_url) {
      event.custom_attributes._http_url = new URL(event.custom_attributes._http_url).origin;
    }
    return event;
  },
});
```

The synchronous callback receives the fully enriched `LogEvent`. Return the mutated event or a
replacement with valid required fields; return `null` to drop it and its attachment uploads.
Only the returned event reaches the console, memory buffer, offline storage, and transport.
Message and attribute length limits still apply. Hook exceptions, invalid results, and accidental
async callbacks drop silently; recursive Pulse logging from inside the callback is ignored.
Without the hook, capture behaves as before.

The hook runs once when an event is captured, including lifecycle events emitted by `configure()`.
Retries and previously queued events are not processed again, so installing a new hook does not
sanitize an old offline queue. Use the returned event's IDs consistently if changing them: attachment
reservations use its `client_event_id` and `user_id`. Attachment contents and filenames, identity and
user-property requests, feedback bodies, and questionnaire answers do not pass through this hook.
The feedback audit log does. Redaction rules for messages and attributes belong to the application;
the example above only demonstrates error filtering and URL reduction.

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
of band, so the event itself is never delayed.

```ts
Pulse.error(err, "import failed", { rows: "1200" }, {
  attachments: [{ data: file, filename: "import.csv", contentType: "text/csv" }],
});
```

Uploads need `crypto.subtle`, which browsers only expose in a secure context. Over plain HTTP they
are skipped with a debug note; the event still goes out. `Pulse.flush()` waits for the upload queue.

## Network tracking

```ts
Pulse.configure({
  // …
  networkTracking: true,
  propagateSessionTo: ["https://api.example.com"],
});
```

`networkTracking` wraps the global `fetch` and logs an `sdk:network_request` event per call with the
method, the URL (query string stripped), the status and the duration — debug for 2xx/3xx, warn for
anything else, error when the request throws. Requests to your Pulse endpoint are skipped.

Only requests made through the global `fetch` are wrapped. `XMLHttpRequest`, `navigator.sendBeacon`
and libraries that use their own XHR adapter (axios in its default browser build, say) are invisible
to both the events and the header below.

`propagateSessionTo` lists URL prefixes that receive the `X-Pulse-Session-Id` header, and works
whether or not `networkTracking` is on — the same `fetch` wrapper is installed when either is set.
Only list origins you control: the header should not leak to third parties.

## Flush and shutdown

Batches are sent every `flushIntervalMs`, or as soon as `flushThreshold` events are buffered. You
rarely need to intervene, but both are available:

```ts
await Pulse.flush(); // send everything buffered, including attachments
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

## Configuration

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `endpoint` | `string` | `https://ingest.pubkypulse.com` | Pubky's hosted ingest host; a trailing slash is stripped. Self-hosters must set their own server URL explicitly. |
| `apiKey` | `string` | — | **Required.** Client key, must start with `pulse_client_`. |
| `bundleId` | `string` | Not sent | Optional legacy identifier for older servers. Updated servers identify the app from the client key alone. |
| `appVersion` | `string` | — | Version reported with every event. |
| `isDev` | `boolean` | `true` on `localhost`, `127.0.0.1` or `file:` | Marks events as development traffic. |
| `debug` | `boolean` | `false` | Print the SDK's own diagnostics to the console. |
| `consoleLogging` | `boolean` | `true` | Mirror logged events to the console. |
| `compressionEnabled` | `boolean` | `true` | gzip request bodies where the browser supports it. |
| `captureUnhandled` | `boolean` | `true` | Capture uncaught errors and unhandled rejections. |
| `trackPageViews` | `boolean` | `true` | Emit screen events for History API navigations. |
| `screenNameForPath` | `(pathname: string) => string` | Raw pathname | Map automatic screen names; a thrown error or blank/non-string result ends the previous screen and clears default attribution. |
| `beforeSend` | `(event: LogEvent) => LogEvent \| null` | Not set | Transform or drop enriched events before output, buffering, and attachment scheduling. Synchronous only; failures drop silently. |
| `networkTracking` | `boolean` | `false` | Emit an event per `fetch` call. |
| `propagateSessionTo` | `string[]` | `[]` | URL prefixes that receive `X-Pulse-Session-Id`. |
| `flushIntervalMs` | `number` | `5000` | Milliseconds between automatic flushes. |
| `flushThreshold` | `number` | `20` | Buffered events that trigger an immediate flush. |
| `maxBufferSize` | `number` | `10000` | Buffered events kept before the oldest are dropped. |
| `sessionTimeoutMs` | `number` | `1800000` | Idle time after which a new session starts. |
| `supportedLanguages` | `string[]` | not sent | The locales your app ships. Written through to the app record on the server and used for localization-gap analysis. Set it explicitly; the SDK never derives it from the browser. |

Invalid values throw at `configure()` time with a `Pubky Pulse: …` message, so a typo surfaces on
the first page load rather than silently dropping your data.

## Server setup

1. In your Pulse dashboard, create an app with platform `web`. Its client key identifies the app;
   you do not need to copy an app identifier into the SDK configuration.
2. Add the site's origin to the server's `CORS_ORIGINS`, including the port you use in development
   (`http://localhost:5173`, say). Without it the browser blocks every request.
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

The package is safe to import on the server. `configure()` validates its configuration first, then
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
