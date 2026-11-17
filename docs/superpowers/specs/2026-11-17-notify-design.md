# hawk notify: design

Task: HAWK-8. Discord is the first platform (was HAWK-9). Follow-ups: SPAR-51 (sparrow sends), BUDGIE-11 (budgie sends), TASK-8 (replies).

## Why

Two copies of "send a message" exist today: `hawk notify` (`bin/hawk:184`, curl to Resend) and budgie's
`ResendSender` (`newsletter/src/newsletter/emailer.py`). Each new service would add a third. The services use
three languages (bash, TypeScript, Python), so a shared package would have to be written three times.

hawk becomes the one place that sends messages. A service says what happened. hawk decides where it goes and
how it looks there. Later, bot runs for one-shot sparrow tasks will send their status and "blocked" messages
through it, and a separate agent session service will handle replies (TASK-8).

## Goals

- One local HTTP API on the box that any service calls with plain JSON.
- Routing is config in the hawk repo. Services never name a platform, channel or secret.
- Discord first. The Slack adapter stays in the code, unused, and a platform is one adapter file with no change to callers or to the queue.
- Messages survive hawk restarts and Discord outages (a queue). They wait and go to Discord when it is back.
- Notifications arrive only in Discord. Email is used for one thing: one alert that Discord is down.
- No email storm. hawk keeps state on whether Discord is down and whether the down alert was sent.
- The queue is easy to extend for threads (one Slack thread per sparrow task) later.
- Callers keep working when the contract changes (versioned API).

## Non-goals (this task)

- Sending from sparrow or budgie (SPAR-51, BUDGIE-11).
- Replies, or any inbound chat events (TASK-8, in the agent session service).
- Discord adapter.
- Slack threads. `thread` is accepted and stored, but not used yet.
- Email as a channel for normal messages.
- Moving gatus alerts onto the service. Gatus keeps its own Resend alerting for now.
- A UI for messages on the hawk page.

## Anti-goals

- A failed or slow send must never break the caller. Callers get an answer fast; delivery is async.
- No message is silently lost: it reaches Discord, or stays queued, or is `failed` with a journal error.
- No email storm: at most one "Discord is down" email per outage.
- No secrets outside `/etc/hawk/hawk.env`.
- Not reachable from other machines.

## Constraints

- Box: `andrewsserver`, Ubuntu, Node 24 at `/usr/bin/node`. Node 24 runs `.ts` files directly (type
  stripping), and has `node:sqlite`.
- `install.sh` rsyncs the checkout to `/opt/hawk` and excludes `node_modules`. Nothing runs `pnpm install`
  on the box for hawk. So: **no npm dependencies, no build step.**
- Ports in use: 3400 (gatus), 3401 (mlflow), 3417–3419 (apps). `install.sh` checks for duplicates.
- Repo rules: keep code simple, few comments, docblocks under 12 lines.

## Decisions (made with the user)

- HTTP API, not a package. No JSON Schema file and no zod: one TypeScript type plus a small hand-written check.
- Routing is config-driven, in hawk.
- Bodies are markdown. hawk converts per channel. (Markdown in, not HTML in.)
- Discord first, via a bot token (`POST /channels/{id}/messages`), not webhooks. Slack (`chat.postMessage`) is kept, unused.
- Queue, not synchronous sends.
- Discord only. Discord fails → messages stay queued until Discord is back. No per-message email.
- State, per platform, records whether it is down and whether the down alert went out. One email per outage.
- One delivery row per message per target, and one worker per platform, so platforms never block each other.
- A 429 is not an outage.
- Versioned API in the path; one core message inside; one translator per version.
- `thread` field in v1. The queue does not act on it yet, but must be easy to extend for it.

## API v1

Listens on `127.0.0.1:3402` only. No auth (box-local).

```
POST /v1/messages
{
  "topic":  "sparrow.task.status",  // required. <service>.<event>, lowercase, [a-z0-9.-], max 250 chars
  "title":  "HAWK-8: in-progress → done", // required. Plain text, 1–150 chars
  "body":   "markdown",              // optional. Max 40,000 chars
  "level":  "info",                  // optional. info | warn | error. Default info
  "link":   "https://...",           // optional. http(s) URL
  "thread": "HAWK-8",                // optional. 1–100 chars. Same value = same chat thread
  "key":    "sparrow:HAWK-8:done:…"  // optional. 1–200 chars. Dedup key
}
```

Responses:

- `202 {"id": "msg_…", "status": "queued"}`: saved; delivery happens later.
- `200 {"id": "msg_…", "status": "<current>"}`: `key` was seen before. Nothing new is queued; this is the first
  message's id and status.
- `400 {"error": {"code": "invalid", "field": "<name>", "message": "…"}}`: first failing field.
- `400 {"error": {"code": "invalid_json", "message": "…"}}`.
- `413` for a request over 64 KB.

Unknown fields are ignored (forward compatible).

```
GET /v1/messages/{id}
200 {"id", "topic", "status": "queued|sent|failed", "created": "<ISO>",
     "deliveries": [
       {"platform": "discord", "target": "<channel id>", "status": "queued|sent|failed",
        "attempts": 2, "error": "<last error>"|null, "sent": "<ISO>"|null}
     ]}
404 {"error": {"code": "not_found", "message": "…"}}

GET /healthz
200 {"version": "<contents of /opt/hawk/COMMIT>"}
```

A message's `status` comes from its deliveries: `sent` when all are sent, `failed` when none are queued and at
least one failed, else `queued`. A delivery waiting out an outage stays `queued`. `failed` means the platform
refused that delivery for good (see Delivery). Keys are kept as long as their rows (30 days).

## Versions

- `src/core.ts` holds the core message type. The queue, router and adapters use only the core.
- `src/api/v1.ts` exports `toCore(json)` (validate + map) and `fromCore(row)` (response shape).
- The message row stores the core message as JSON plus `api_version`, so `GET /vN/messages/{id}` can format it.
- The core only grows. A new core field gets a default in each older `toCore()`.
- Additive optional fields go into the current version. Only a breaking change (remove, rename, change meaning,
  make required) adds `/v2/` with its own file. Old versions keep working until no caller uses them.
- Each request logs `api_version` and `topic` to the journal, so you can see who still uses an old version.

## Routing config

`notify/routes.ts` in the repo (a `.ts` file: typed, can hold comments, no parser). Shape:

```ts
export default {
  default: { discord: '<channel id>' },    // topic with no route; also gets the notices below
  routes: {
    'hawk.*':              { discord: '<channel id>' },
    'sparrow.task.status': { discord: '<channel id>' },
    'budgie.daily':        { discord: '<channel id>' },
    // Slack still works: { slack: '#budgie' } with SLACK_BOT_TOKEN set.
  },
}
```

- A route maps each platform to one target. A route with two platforms makes two deliveries.
- Exact match wins, then the longest `prefix.*` match, then `default`.
- A test loads `routes.ts` and fails CI if a route names a platform with no adapter.
- Changing routes = a PR, then `hawk-update`.

## Platform adapters

Each platform is one file in `src/platforms/` that exports one object:

```ts
type Result =
  | { kind: 'ok'; ref?: string }               // ref: platform message id (for threads later)
  | { kind: 'retry_after'; seconds: number }   // rate limited (429)
  | { kind: 'transient'; error: string }       // network, timeout, 5xx
  | { kind: 'auth'; error: string }            // bad or missing token
  | { kind: 'permanent'; error: string }       // will never work for this delivery

type Platform = {
  name: 'discord'                              // or 'slack'
  configured(env): boolean                     // token present?
  send(core, target, env): Promise<Result>     // renders, then posts
}
```

The worker only sees `Result`. Each adapter maps its own errors into it. `src/platforms/index.ts` lists the
adapters. Adding a platform = one new file, one line in that list, a token in `hawk.env`, and `discord:` targets in
`routes.ts`.

## Delivery

`POST` saves one `messages` row and one `deliveries` row per target from the route, all `queued` with
`next_at = now`, and wakes the workers.

There is **one worker loop per platform**. Each sends one delivery at a time, oldest first. A 429 or outage on
one platform never holds up another. Volume is low, so this stays far under Discord and Slack channel rate limits.

Order is decided in one function, `nextDelivery(db, platform, now)`. Nothing else picks rows. This is the
extension point for threads (see "Threads (later)").

1. If the platform is `down`, its worker only sends probes (see "Platform state"). Otherwise it sends
   `nextDelivery()`.
2. `ok` → delivery `sent`, store the time and `ref`.
3. `retry_after` → that platform's worker pauses for that long. Not a failure. Not toward an outage.
4. `transient` → the delivery stays `queued` with backoff `next_at`: 5 s, 15 s, 30 s, 60 s, then every 60 s.
   Counts toward an outage.
5. `auth` → the platform is unusable. Mark it `down` at once. The delivery stays `queued`.
6. `permanent` → the delivery is `failed`, the error is stored and logged to the journal. hawk posts one short
   notice to that platform's `default` target: `could not post <topic> to <target>: <error>`. If that also
   fails, or the default has no target on that platform, journal only. Not an outage.
7. On start, deliveries left mid-send go back to `queued`.

Slack mapping (in `slack.ts`): HTTP 429 → `retry_after` (`Retry-After` header); network, 10 s timeout, 5xx,
`internal_error`, `service_unavailable`, `fatal_error`, `request_timeout` → `transient`; `invalid_auth`,
`not_authed`, `token_revoked`, `account_inactive` → `auth`; anything else → `permanent`.

Queued deliveries are never dropped. They wait for their platform.

## Platform state

This is what stops an email storm. One row per platform in a `platform_state` table, so it survives restarts:

| Field | Meaning |
|---|---|
| `platform` | `discord` (or `slack`) |
| `status` | `up` or `down` |
| `reason` | last error, or `no_token` |
| `failing_since` | first transient failure in the current run of failures, or null |
| `down_since` | when it was marked down, or null |
| `next_probe_at` | when to try the platform again while down |
| `alert_sent_at` | when the last "<platform> is down" email went out, or null |

Rules, per platform:

- `transient` → set `failing_since` if null. When `now - failing_since >= 5 min` → `status = down`.
- `auth` → `status = down` at once.
- `status = down` → send **one** email, "hawk: <Platform> is down" (reason, since when, how many deliveries
  queued), unless `alert_sent_at` is within the last hour (stops flapping from sending more). Set
  `alert_sent_at` only when Resend accepts it; if Resend fails, retry with the same backoff. No other email is
  ever sent.
- While down: no normal sends on that platform. Every 60 s, probe by sending its oldest queued delivery.
- Any `ok` → clear `failing_since`. If it was `down`: `status = up`, then post one notice to that platform's
  default target, "<Platform> was unreachable from <down_since> to <now>. <n> messages were delayed.", then send
  the queue in order. No "back" email.

## No token

Platform tokens (`DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`) are optional, so `hawk-update` (which runs
`install.sh </dev/null`) never breaks before a token exists. `install.sh` warns when one is missing; it does not
`die`. A platform with no token (`configured()` is false) but with targets in `routes.ts` is `down` with reason
`no_token`: its deliveries queue, and the same one-email rule sends "hawk: <Platform> is not set up". Adding the
token and restarting `hawk-notifyd` turns it on and its queue drains.

## Threads (later)

`thread` is accepted, validated and stored in `messages.thread`, but not used yet. To add threads later:

- add a `threads(thread, platform, target, ref)` table;
- in `nextDelivery()`, skip a delivery whose message's `thread` has an older delivery to the same target still
  `queued`, so the first one creates the thread;
- in each adapter, post into the thread when a `threads` row exists (Slack: `thread_ts = ref`), and save the
  `ref` from `ok` when not.

Nothing else changes: not the API, the tables above, or the outage logic.

## Rendering

Hand-written, for this markdown subset: paragraphs, `#` headings, `**bold**`, `*italic*`/`_italic_`, `` `code` ``,
fenced code, `[text](url)`, bare URLs, `-`/`*`/`1.` lists, `>` quotes. Anything else passes through as text.
`src/markdown.ts` parses it once into a small tree; each adapter renders the tree its own way.

- **Slack**: `text` = title (notification preview). `blocks` = a section with the title (bold) and a `level`
  prefix (`:warning:` warn, `:rotating_light:` error), the body as `mrkdwn` sections split at paragraph breaks
  into chunks of ≤3000 chars, and `link` as a last section. Max 50 blocks per message; more is split into more
  messages, sent one after another 1 s apart, each titled `<title> (i/n)`, with the link in the last one. A failure
  part-way returns that failure and the retry posts every part again, so earlier parts can repeat. Convert: `**x**`→`*x*`, `*x*`/`_x_`→`_x_`, `[t](u)`→`<u|t>`, headings → bold
  line, escape `&`, `<`, `>`.
- **Discord**: markdown almost as is, in `content` (≤2000 chars), with `allowed_mentions: {parse: []}`. Header
  line `<prefix>**<title>**` (prefix `⚠️ ` warn, `🚨 ` error), then the body. Convert: `**x**`, `*x*`/`_x_`→`*x*`,
  `[t](u)`→`[t](u)` with `)`→`%29` and space→`%20` in `u`, heading → `### t`, quote `> `, fence, `- `/`1.` lists;
  escape `\ * _ ~ ` + "`" + ` | [ ]` in text. Longer messages are packed by block into parts titled `(i/n)`, sent 1 s
  apart; a block over budget is cut at the last newline or space, else at the budget, and may misrender at the cut
  (all the information matters more than clean rendering). `link` is `[Open](url)` at the end of the last part,
  or its own final part holding the raw url when it does not fit. Errors: 429 → `retry_after` (body
  `retry_after`), 401 → `auth`, 5xx and network → `transient`, other 4xx → `permanent`. A bot must connect to the
  gateway once before it can send: `notify/scripts/discord-identify.ts`.
- **Email** is only the down alert: plain text from a fixed template, through Resend.

## Storage

`/var/lib/hawk-notify/notify.db` (`node:sqlite`, WAL). Tables: `messages`, `deliveries`, `platform_state`.
Once a day, delete messages older than 30 days whose deliveries are all `sent` or `failed` (and their deliveries).

## Files and install

```
notify/
  routes.ts
  src/
    main.ts        // http server + one worker per platform
    core.ts        // core type
    api/v1.ts      // toCore / fromCore
    db.ts          // schema, queue queries, nextDelivery()
    worker.ts      // loop, backoff, platform state
    route.ts       // topic → { platform: target }
    markdown.ts    // tiny parser shared by adapters
    alert.ts       // the down email (Resend)
    platforms/
      index.ts     // list of adapters
      slack.ts     // (kept, unused)
      discord.ts   // render + send + error mapping
  test/            // node:test
systemd/hawk-notifyd.service
```

- `hawk-notifyd.service`: `ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning
  /opt/hawk/notify/src/main.ts`, `DynamicUser=true`, `StateDirectory=hawk-notify`,
  `EnvironmentFile=/etc/hawk/hawk.env`, `Restart=on-failure`, `OnFailure=hawk-notify@%N.service`, hardening like
  `mlflow.service`.
- `install.sh`: add `NOTIFY_PORT=3402` to the duplicate-port check; install and enable the unit; restart it
  when `/opt/hawk/notify` changes; ask for `DISCORD_BOT_TOKEN` on first install (blank allowed), and warn, not
  fail, when it is missing.
- `hawk notify <message>`: POST `{topic: "hawk.alert", title: <message>, level: "error"}` to the service. If the
  service does not answer, the alert system itself is down: email directly through Resend like today, **at most
  once per 30 minutes** (a stamp file in `hawk-notify@`'s `StateDirectory`). Other alerts in that window go to
  the journal only.
- CI: run `node --test notify/test` in `check.yml`, beside shellcheck.

## Discord setup (one time, by the user)

Developer Portal → New Application → Bot → Reset Token, into `/etc/hawk/hawk.env` as `DISCORD_BOT_TOKEN`. OAuth2
URL Generator: scope `bot`, permissions View Channels + Send Messages; add the bot to the server. Run
`notify/scripts/discord-identify.ts` once. Paste the channel IDs into `routes.ts`. No privileged intents.

## Left to the builder

- Internal names, SQL schema details, id format (any sortable unique id with the `msg_` prefix).
- Exact markdown edge cases inside the listed subset.
- Test scope: the v1 check, routing match order, markdown → Discord and Slack, worker backoff, platform state and the one-email
  rule, with a fake clock and fake senders. No live Discord, Slack or Resend calls in tests.
