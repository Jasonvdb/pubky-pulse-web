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

Pulse.configure({
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_…",
  bundleId: "com.example.web",
  appVersion: "1.4.0",
});

Pulse.info("signed_up", { plan: "pro" });
```

Calls made before `configure()` are ignored (one console note, then silence), so a stray log during
startup can never throw.

## Use it in your environment

### Static page

```html
<script type="module">
  import { Pulse } from "https://esm.sh/@synonymdev/pubky-pulse-web";

  Pulse.configure({
    endpoint: "https://pulse.example.com",
    apiKey: "pulse_client_…",
    bundleId: "com.example.web",
  });

  document.querySelector("#buy").addEventListener("click", () => {
    Pulse.info("buy_clicked");
  });
</script>
```

There is a runnable version of this in [`examples/vanilla/index.html`](./examples/vanilla/index.html):
build the package with `npm run build`, then serve the repository over HTTP — `npx serve .` or
`python3 -m http.server` — and open `http://localhost:3000/examples/vanilla/index.html` (port 8000
for `http.server`). The page imports the built SDK as a module, so opening it straight from disk
over `file://` leaves it dead. Fill in your key and bundle id there and watch the events stream;
the origin you serve it from is the one that has to be in the server's `CORS_ORIGINS`.

### React

No provider and no context — `Pulse` is a module singleton. Configure once in your root component.

```tsx
import { useEffect } from "react";
import { Pulse } from "@synonymdev/pubky-pulse-web";

export function App() {
  useEffect(() => {
    Pulse.configure({
      endpoint: import.meta.env.VITE_PULSE_ENDPOINT,
      apiKey: import.meta.env.VITE_PULSE_KEY,
      bundleId: "com.example.web",
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
      endpoint: process.env.NEXT_PUBLIC_PULSE_ENDPOINT!,
      apiKey: process.env.NEXT_PUBLIC_PULSE_KEY!,
      bundleId: "com.example.web",
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
with `/api`. Read it in your route handlers with the
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
  import { PUBLIC_PULSE_ENDPOINT, PUBLIC_PULSE_KEY } from "$env/static/public";

  onMount(() => {
    Pulse.configure({
      endpoint: PUBLIC_PULSE_ENDPOINT,
      apiKey: PUBLIC_PULSE_KEY,
      bundleId: "com.example.web",
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
          endpoint: environment.pulseEndpoint,
          apiKey: environment.pulseKey,
          bundleId: "com.example.web",
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
`popstate`, emitting a screen event whenever `location.pathname` changes. Hash-only changes are
ignored.

For anything the URL does not describe — a modal, a wizard step, a tab — name it yourself:

```ts
Pulse.trackScreen("Checkout / Payment");
```

`trackScreen` also sets the default `screen_name` for the events that follow, until the next screen
change.

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
a rejected request is dropped and an unreachable one is parked for a later retry, neither of which
throws. Turn on `debug` to see those drops.

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

`networkTracking` wraps `window.fetch` and logs an `sdk:network_request` event per call with the
method, the URL (query string stripped), the status and the duration — debug for 2xx/3xx, warn for
anything else, error when the request throws. Requests to your Pulse endpoint are skipped.

`propagateSessionTo` lists URL prefixes that receive the `X-Pulse-Session-Id` header, and works
whether or not `networkTracking` is on. Only list origins you control: the header should not leak to
third parties.

## Flush and shutdown

Batches are sent every `flushIntervalMs`, or as soon as `flushThreshold` events are buffered. You
rarely need to intervene, but both are available:

```ts
await Pulse.flush(); // send everything buffered, including attachments
await Pulse.shutdown(); // flush, then remove every page hook the SDK installed
```

When the page is hidden or unloaded the SDK flushes on its own with a `keepalive` request and parks
whatever does not fit in an offline queue in `localStorage`, which is drained on the next page load.
Events logged while the browser reports itself offline queue up rather than fail.

## Configuration

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `endpoint` | `string` | — | **Required.** Pulse server URL; a trailing slash is stripped. |
| `apiKey` | `string` | — | **Required.** Client key, must start with `pulse_client_`. |
| `bundleId` | `string` | — | **Required.** Bundle id of the Pulse app receiving the events. |
| `appVersion` | `string` | — | Version reported with every event. |
| `isDev` | `boolean` | `true` on `localhost`, `127.0.0.1` or `file:` | Marks events as development traffic. |
| `debug` | `boolean` | `false` | Print the SDK's own diagnostics to the console. |
| `consoleLogging` | `boolean` | `true` | Mirror logged events to the console. |
| `compressionEnabled` | `boolean` | `true` | gzip request bodies where the browser supports it. |
| `captureUnhandled` | `boolean` | `true` | Capture uncaught errors and unhandled rejections. |
| `trackPageViews` | `boolean` | `true` | Emit screen events for History API navigations. |
| `networkTracking` | `boolean` | `false` | Emit an event per `fetch` call. |
| `propagateSessionTo` | `string[]` | `[]` | URL prefixes that receive `X-Pulse-Session-Id`. |
| `flushIntervalMs` | `number` | `5000` | Milliseconds between automatic flushes. |
| `flushThreshold` | `number` | `20` | Buffered events that trigger an immediate flush. |
| `maxBufferSize` | `number` | `10000` | Buffered events kept before the oldest are dropped. |
| `sessionTimeoutMs` | `number` | `1800000` | Idle time after which a new session starts. |
| `supportedLanguages` | `string[]` | `navigator.languages` | Overrides the reported language list. |

Invalid values throw at `configure()` time with a `Pubky Pulse: …` message, so a typo surfaces on
the first page load rather than silently dropping your data.

## Server setup

1. In your Pulse dashboard, create an app with platform `web` and give it a bundle id — the same
   string you pass as `bundleId`.
2. Add the site's origin to the server's `CORS_ORIGINS`, including the port you use in development
   (`http://localhost:5173`, say). Without it the browser blocks every request.
3. Copy the app's client key. It starts with `pulse_client_`, is public and write-only, and is meant
   to ship in your bundle. Never put a server key (`pulse_secret_…`) in a browser.

## Browser support and SSR

Any evergreen browser — Chrome, Edge, Firefox and Safari — is supported; the build targets ES2020.
Two features degrade rather than break:

- **gzip** needs `CompressionStream`. Where it is missing, bodies are sent as plain JSON. Bodies
  under 512 bytes and the unload path are never compressed anyway.
- **Attachments** need `crypto.subtle`, which requires a secure context (HTTPS or `localhost`).
  Elsewhere uploads are skipped and the event is still sent.

The package is safe to import on the server. `configure()` checks for `window` and, when there is
none, returns without installing anything — so a Next.js or SvelteKit server render does no work and
throws nothing. Log calls made before a successful `configure()` are ignored, so shared code that
logs on both sides needs no guard of its own.

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
