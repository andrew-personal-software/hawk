# hawk notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local HTTP service in hawk (`hawk-notifyd`) that queues messages from any service and delivers them to Slack, with one "Slack is down" email per outage.

**Architecture:** One Node 24 process, plain `.ts` run directly. `POST /v1/messages` → `toCore()` → one `messages` row + one `deliveries` row per routed target in SQLite → one worker loop per platform sends through a platform adapter that returns a `Result`. Per-platform state in `platform_state` drives the outage email.

**Tech Stack:** Node 24 (type stripping, `node:sqlite`, `node:http`, `node:test`, global `fetch`), bash, systemd. Dev only: `typescript` + `@types/node` for `tsc --noEmit` in CI.

**Spec:** `docs/superpowers/specs/2026-11-17-notify-design.md` (task HAWK-8).

## Global Constraints

- No runtime npm dependencies and no build step. The box runs `/usr/bin/node /opt/hawk/notify/src/main.ts`. Dev dependencies are fine (CI only; `install.sh` excludes `node_modules`).
- Type stripping only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type`.
- Listen on `127.0.0.1:3402` only. Add `NOTIFY_PORT=3402` to the duplicate-port check in `install.sh`.
- DB: `$STATE_DIRECTORY/notify.db` (systemd sets it to `/var/lib/hawk-notify`); `NOTIFY_DB` env overrides it for local runs. WAL mode.
- Secrets only in `/etc/hawk/hawk.env`: `SLACK_BOT_TOKEN` (optional), `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`.
- v1 limits: `topic` matches `^[a-z0-9-]+(\.[a-z0-9-]+)+$`; `title` 1–150 chars; `body` ≤ 40,000 chars; `level` ∈ `info|warn|error` (default `info`); `link` is an `http:`/`https:` URL; `thread` 1–100 chars; `key` 1–200 chars; request ≤ 64 KB.
- Backoff for `transient`: 5 s, 15 s, 30 s, 60 s, then every 60 s. Outage after 5 min of transient failures. Probe every 60 s while down. Down email suppressed when the last one was < 1 hour ago. Slack request timeout 10 s.
- Slack sections ≤ 3000 chars; ≤ 50 blocks per message.
- Times are stored as epoch ms integers; the API returns ISO strings (`new Date(ms).toISOString()`).
- Repo rules: simple code, few comments, docblocks under 12 lines. Conventional commits.
- Work on branch `feat/hawk-notify`. Never commit to `main`.

## Review Focus

- **Restart during an outage** must not send a second down email: the state is in SQLite. Test: `tick` with a fresh `WorkerDeps` over the same DB sends no email (Task 6).
- **Same `key`, different content** returns the first message unchanged and queues nothing new. Test in Task 5.
- **Recovery notice fails** (default target broken) must still mark the platform `up` and keep draining the queue. Test in Task 6.
- **A body full of `&`, `<`, `>`** grows when escaped and could pass 50 blocks: the payload must stay valid (≤ 50 blocks, each ≤ 3000 chars). Test in Task 4.
- **Bad request shapes** (not JSON, a JSON array, `null`, > 64 KB, unknown path) return 4xx with the error shape, never 500. Test in Task 7.

---

## File Structure

```
notify/
  routes.ts               topic → { platform: target } config (user-edited)
  tsconfig.json           typecheck only
  src/
    core.ts               Core, Level, Env, Result, Platform, MessageView, DeliveryView
    api/v1.ts             toCore(), fromCore()
    route.ts              Routes type, resolve()
    markdown.ts           parse() → Block[]
    platforms/slack.ts    render(), mapResponse(), slack: Platform
    platforms/index.ts    platforms: Platform[]
    db.ts                 openDb(), queue + state queries
    alert.ts              makeAlert() (Resend)
    worker.ts             tick(), startWorker()
    server.ts             createServer()
    main.ts               wiring, signals
  test/*.test.ts          node:test
systemd/hawk-notifyd.service
systemd/hawk-notify@.service   (modify: StateDirectory)
bin/hawk                       (modify: cmd_notify)
install.sh                     (modify)
.github/workflows/check.yml    (modify: notify job)
package.json                   (modify: scripts, devDeps)
README.md                      (modify: Alerts section)
```

---

### Task 1: Core types, v1 translator, tooling

**Files:**
- Create: `notify/src/core.ts`, `notify/src/api/v1.ts`, `notify/tsconfig.json`, `notify/test/v1.test.ts`
- Modify: `package.json`, `.github/workflows/check.yml`

**Interfaces:**
- Produces (`core.ts`):
  ```ts
  export type Level = 'info' | 'warn' | 'error'
  export type Core = { topic: string; title: string; level: Level; body?: string; link?: string; thread?: string; key?: string }
  export type Env = Record<string, string | undefined>
  export type Result =
    | { kind: 'ok'; ref?: string }
    | { kind: 'retry_after'; seconds: number }
    | { kind: 'transient'; error: string }
    | { kind: 'auth'; error: string }
    | { kind: 'permanent'; error: string }
  export type Platform = {
    name: string                     // 'slack'
    label: string                    // 'Slack', used in emails and notices
    configured(env: Env): boolean
    send(msg: Core, target: string, env: Env): Promise<Result>
  }
  export type Status = 'queued' | 'sent' | 'failed'
  export type DeliveryView = { platform: string; target: string; status: Status; attempts: number; error: string | null; sentAt: number | null }
  export type MessageView = { id: string; topic: string; created: number; apiVersion: string; core: Core; status: Status; deliveries: DeliveryView[] }
  ```
- Produces (`api/v1.ts`):
  ```ts
  export type Invalid = { ok: false; field: string; message: string }
  export function toCore(json: unknown): { ok: true; core: Core } | Invalid
  export function fromCore(m: MessageView): object   // the v1 GET body
  ```

- [ ] **Step 1: Tooling.** Create branch `feat/hawk-notify`. `pnpm add -D typescript@5.9 @types/node@24`. In `package.json` add scripts `"test": "node --test 'notify/test/*.test.ts'"` and `"typecheck": "tsc -p notify"`. `notify/tsconfig.json`: `strict`, `noEmit`, `module`/`moduleResolution` `nodenext`, `target` `es2024`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `types: ["node"]`, `include: ["src", "test", "routes.ts"]`. In `check.yml` add job `notify`: checkout, `pnpm/action-setup`, `actions/setup-node@v7` with `node-version: 24` and pnpm cache, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.

- [ ] **Step 2: Write the failing tests** in `notify/test/v1.test.ts`:

```ts
const ok = { topic: 'sparrow.task.status', title: 'HAWK-8: ready → done' }
test('minimal message gets level info', () => {
  assert.deepEqual(toCore(ok), { ok: true, core: { ...ok, level: 'info' } })
})
test('all fields map through; unknown fields are dropped', () => {
  const r = toCore({ ...ok, body: '**x**', level: 'error', link: 'https://a.b/c', thread: 'HAWK-8', key: 'k1', extra: 1 })
  assert.deepEqual(r, { ok: true, core: { ...ok, body: '**x**', level: 'error', link: 'https://a.b/c', thread: 'HAWK-8', key: 'k1' } })
})
test('first failing field is reported', () => {
  const cases: [unknown, string][] = [
    [{ title: 't' }, 'topic'],
    [{ ...ok, topic: 'Sparrow.Task' }, 'topic'],
    [{ ...ok, topic: 'sparrow' }, 'topic'],
    [{ ...ok, title: '' }, 'title'],
    [{ ...ok, title: 'x'.repeat(151) }, 'title'],
    [{ ...ok, body: 'x'.repeat(40001) }, 'body'],
    [{ ...ok, level: 'fatal' }, 'level'],
    [{ ...ok, link: 'ftp://a.b' }, 'link'],
    [{ ...ok, link: 'not a url' }, 'link'],
    [{ ...ok, thread: '' }, 'thread'],
    [{ ...ok, key: 'k'.repeat(201) }, 'key'],
    [{ ...ok, title: 5 }, 'title'],
  ]
  for (const [input, field] of cases) assert.equal((toCore(input) as Invalid).field, field, JSON.stringify(input))
})
test('non-object input is invalid with field ""', () => {
  for (const v of [null, [], 'x', 3]) assert.deepEqual(toCore(v), { ok: false, field: '', message: 'expected a JSON object' })
})
test('fromCore shape', () => {
  const m: MessageView = { id: 'msg_1', topic: 't.x', created: 0, apiVersion: 'v1', core: { topic: 't.x', title: 'a', level: 'info' }, status: 'sent',
    deliveries: [{ platform: 'slack', target: '#hawk', status: 'sent', attempts: 1, error: null, sentAt: 1000 }] }
  assert.deepEqual(fromCore(m), { id: 'msg_1', topic: 't.x', status: 'sent', created: '1970-01-01T00:00:00.000Z',
    deliveries: [{ platform: 'slack', target: '#hawk', status: 'sent', attempts: 1, error: null, sent: '1970-01-01T00:00:01.000Z' }] })
})
```

- [ ] **Step 3: Run** `pnpm test`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** `core.ts` and `api/v1.ts`. Check fields in the order `topic, title, body, level, link, thread, key`; a field of the wrong type fails as that field. Validate `link` with `new URL()` and its `protocol`.
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck`. Expected: PASS, no type errors.
- [ ] **Step 6: Commit** `feat(notify): core types and the v1 message check`.

---

### Task 2: Routing

**Files:**
- Create: `notify/src/route.ts`, `notify/routes.ts`, `notify/test/route.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Targets = Record<string, string>          // platform name → target
  export type Routes = { default: Targets; routes: Record<string, Targets> }
  export function resolve(routes: Routes, topic: string): Targets
  ```
- `notify/routes.ts`: `export default { ... } satisfies Routes` with the spec's values: default `{ slack: '#hawk' }`; routes `'hawk.*'` → `#hawk`, `'sparrow.task.status'` → `#sparrow`, `'budgie.daily'` → `#budgie`; keep the commented Discord example line.

- [ ] **Step 1: Write the failing tests:**

```ts
const r: Routes = { default: { slack: '#d' }, routes: {
  'a.*': { slack: '#a' }, 'a.b.*': { slack: '#ab' }, 'a.b.c': { slack: '#exact' } } }
test('exact beats prefix', () => assert.deepEqual(resolve(r, 'a.b.c'), { slack: '#exact' }))
test('longest prefix wins', () => assert.deepEqual(resolve(r, 'a.b.x'), { slack: '#ab' }))
test('shorter prefix', () => assert.deepEqual(resolve(r, 'a.z'), { slack: '#a' }))
test('prefix needs a dot boundary', () => assert.deepEqual(resolve(r, 'ab.c'), { slack: '#d' }))
test('no match → default', () => assert.deepEqual(resolve(r, 'z.y'), { slack: '#d' }))
```

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolve()`: `'p.*'` matches a topic that starts with `p + '.'`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notify): route topics to platform targets`.

---

### Task 3: Markdown parser

**Files:**
- Create: `notify/src/markdown.ts`, `notify/test/markdown.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Inline =
    | { t: 'text'; v: string } | { t: 'code'; v: string }
    | { t: 'bold'; c: Inline[] } | { t: 'italic'; c: Inline[] }
    | { t: 'link'; url: string; c: Inline[] }
  export type Block =
    | { t: 'para'; c: Inline[] } | { t: 'heading'; c: Inline[] } | { t: 'quote'; c: Inline[] }
    | { t: 'code'; v: string } | { t: 'list'; ordered: boolean; items: Inline[][] }
  export function parse(md: string): Block[]
  ```

- [ ] **Step 1: Write the failing tests:**

```ts
const txt = (v: string) => ({ t: 'text', v })
test('paragraphs split on blank lines', () =>
  assert.deepEqual(parse('a\nb\n\nc'), [{ t: 'para', c: [txt('a\nb')] }, { t: 'para', c: [txt('c')] }]))
test('heading', () => assert.deepEqual(parse('## Hi'), [{ t: 'heading', c: [txt('Hi')] }]))
test('inline marks', () => assert.deepEqual(parse('**b** *i* _j_ `c` [t](https://x.y)'), [{ t: 'para', c: [
  { t: 'bold', c: [txt('b')] }, txt(' '), { t: 'italic', c: [txt('i')] }, txt(' '), { t: 'italic', c: [txt('j')] }, txt(' '),
  { t: 'code', v: 'c' }, txt(' '), { t: 'link', url: 'https://x.y', c: [txt('t')] }] }]))
test('bare url becomes a link', () => assert.deepEqual(parse('see https://x.y/z ok'), [{ t: 'para', c: [
  txt('see '), { t: 'link', url: 'https://x.y/z', c: [txt('https://x.y/z')] }, txt(' ok')] }]))
test('lists', () => assert.deepEqual(parse('- a\n* b\n\n1. c\n2. d'), [
  { t: 'list', ordered: false, items: [[txt('a')], [txt('b')]] }, { t: 'list', ordered: true, items: [[txt('c')], [txt('d')]] }]))
test('quote', () => assert.deepEqual(parse('> q\n> r'), [{ t: 'quote', c: [txt('q\nr')] }]))
test('fenced code keeps its text raw', () => assert.deepEqual(parse('```\n**x**\n```'), [{ t: 'code', v: '**x**' }]))
test('unclosed marks stay text', () => assert.deepEqual(parse('a **b'), [{ t: 'para', c: [txt('a **b')] }]))
```

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `parse()`. Line-based block pass (fence, heading, list, quote, else paragraph), then an inline pass. Merge adjacent text nodes.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notify): parse the markdown subset`.

---

### Task 4: Slack adapter

**Files:**
- Create: `notify/src/platforms/slack.ts`, `notify/src/platforms/index.ts`, `notify/test/slack.test.ts`

**Interfaces:**
- Consumes: `Core`, `Env`, `Result`, `Platform` (Task 1); `parse`, `Block` (Task 3); `Routes` and `notify/routes.ts` (Task 2).
- Produces:
  ```ts
  export type SlackPayload = { text: string; blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[] }
  export function render(msg: Core): SlackPayload
  export function mapResponse(status: number, retryAfter: string | null, body: unknown): Result
  export function makeSlack(fetchImpl?: typeof fetch): Platform   // name 'slack', label 'Slack'
  export const slack: Platform                                    // makeSlack()
  // platforms/index.ts
  export const platforms: Platform[]                              // [slack]
  ```

- [ ] **Step 1: Write the failing tests:**

```ts
test('render: title section with level prefix, body, link', () => {
  const p = render({ topic: 'a.b', title: 'T <1>', level: 'error', body: '**b** [x](https://u.v)', link: 'https://l.m' })
  assert.equal(p.text, 'T <1>')
  assert.deepEqual(p.blocks.map((b) => b.text.text), [':rotating_light: *T &lt;1&gt;*', '*b* <https://u.v|x>', '<https://l.m|Open>'])
})
test('render: warn prefix, info none, heading → bold line, italic → _x_', () => {
  assert.equal(render({ topic: 'a.b', title: 'T', level: 'warn' }).blocks[0].text.text, ':warning: *T*')
  assert.equal(render({ topic: 'a.b', title: 'T', level: 'info', body: '# H\n\n*i*' }).blocks[1].text.text, '*H*\n\n_i_')
})
test('render: long body splits at paragraphs into sections ≤ 3000', () => {
  const body = Array.from({ length: 10 }, () => 'p'.repeat(1000)).join('\n\n')
  const secs = render({ topic: 'a.b', title: 'T', level: 'info', body }).blocks.slice(1)
  assert.ok(secs.length > 1 && secs.every((b) => b.text.text.length <= 3000))
})
test('render: escaped worst case stays ≤ 50 blocks of ≤ 3000', () => {
  const p = render({ topic: 'a.b', title: 'T', level: 'info', body: '&<>'.repeat(13333) })
  assert.ok(p.blocks.length <= 50 && p.blocks.every((b) => b.text.text.length <= 3000))
})
test('mapResponse', () => {
  assert.deepEqual(mapResponse(200, null, { ok: true, ts: '1.2' }), { kind: 'ok', ref: '1.2' })
  assert.deepEqual(mapResponse(429, '7', {}), { kind: 'retry_after', seconds: 7 })
  assert.deepEqual(mapResponse(429, null, {}), { kind: 'retry_after', seconds: 30 })
  assert.equal(mapResponse(503, null, null).kind, 'transient')
  for (const e of ['internal_error', 'service_unavailable', 'fatal_error', 'request_timeout'])
    assert.deepEqual(mapResponse(200, null, { ok: false, error: e }), { kind: 'transient', error: e })
  for (const e of ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'])
    assert.deepEqual(mapResponse(200, null, { ok: false, error: e }), { kind: 'auth', error: e })
  for (const e of ['channel_not_found', 'not_in_channel', 'something_new'])
    assert.deepEqual(mapResponse(200, null, { ok: false, error: e }), { kind: 'permanent', error: e })
  assert.equal(mapResponse(200, null, 'not json').kind, 'transient')
})
test('send posts to chat.postMessage with the token; network error → transient', async () => {
  let seen: [string, RequestInit] | undefined
  const ok = makeSlack(async (url, init) => { seen = [String(url), init!]; return Response.json({ ok: true, ts: '9' }) })
  assert.deepEqual(await ok.send({ topic: 'a.b', title: 'T', level: 'info' }, '#c', { SLACK_BOT_TOKEN: 'xoxb' }), { kind: 'ok', ref: '9' })
  assert.equal(seen![0], 'https://slack.com/api/chat.postMessage')
  assert.equal((seen![1].headers as Record<string, string>).authorization, 'Bearer xoxb')
  assert.equal(JSON.parse(seen![1].body as string).channel, '#c')
  const down = makeSlack(async () => { throw new TypeError('fetch failed') })
  assert.equal((await down.send({ topic: 'a.b', title: 'T', level: 'info' }, '#c', { SLACK_BOT_TOKEN: 'x' })).kind, 'transient')
  assert.equal(ok.configured({}), false)
  assert.equal(ok.configured({ SLACK_BOT_TOKEN: 'x' }), true)
})
test('every platform in routes.ts has an adapter', () => {
  const names = new Set(platforms.map((p) => p.name))
  for (const t of [routes.default, ...Object.values(routes.routes)])
    for (const p of Object.keys(t)) assert.ok(names.has(p), `no adapter for "${p}"`)
})
```

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Escape `&`, `<`, `>` in text nodes before adding marks. Inline: bold `*x*`, italic `_x_`, code `` `x` ``, link `<url|text>`. Blocks: para as is; heading → `*text*`; quote → each line `> `; code → ```` ```v``` ````; list → `• item` / `1. item`. Join blocks with `\n\n`, then pack into sections ≤ 3000 at block breaks; hard-split any single piece over 3000 at a newline or space where possible, never inside `&…;` or `<…>`. Superseded after review: more than 48 body sections split into more payloads (see the spec). Link section `<link|Open>`. `send`: `fetch` with `method: 'POST'`, headers `authorization`, `content-type: application/json; charset=utf-8`, `signal: AbortSignal.timeout(10_000)`; any thrown error → `{ kind: 'transient', error: String(err) }`; else `mapResponse(res.status, res.headers.get('retry-after'), await res.json().catch(() => null))`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notify): slack adapter`.

---

### Task 5: Database

**Files:**
- Create: `notify/src/db.ts`, `notify/test/db.test.ts`

**Interfaces:**
- Consumes: `Core`, `MessageView`, `Status` (Task 1); `Targets` (Task 2).
- Produces:
  ```ts
  import type { DatabaseSync } from 'node:sqlite'
  export type Db = DatabaseSync
  export type DeliveryRow = { id: number; messageId: string; platform: string; target: string; attempts: number; core: Core }
  export type PlatformState = {
    platform: string; status: 'up' | 'down'; reason: string | null; failingSince: number | null
    downSince: number | null; nextProbeAt: number | null; alertSentAt: number | null; pausedUntil: number | null
  }
  export function openDb(path: string): Db                         // ':memory:' in tests
  export function insertMessage(db: Db, core: Core, apiVersion: string, targets: Targets, now: number): { id: string; created: boolean }
  export function getMessage(db: Db, id: string): MessageView | null
  export function nextDelivery(db: Db, platform: string, now: number): DeliveryRow | null   // oldest queued with next_at <= now
  export function oldestQueued(db: Db, platform: string): DeliveryRow | null               // ignores next_at (probes)
  export function queuedCount(db: Db, platform: string): number
  export function markSent(db: Db, id: number, now: number, ref?: string): void
  export function markRetry(db: Db, id: number, nextAt: number, error: string): void       // attempts + 1
  export function markFailed(db: Db, id: number, error: string): void                      // attempts + 1
  export function getState(db: Db, platform: string): PlatformState                       // default: up, all null
  export function saveState(db: Db, s: PlatformState): void
  export function prune(db: Db, now: number): number                                        // messages deleted
  ```
- Tables: `messages(id TEXT PK, created INT, api_version TEXT, topic TEXT, key TEXT UNIQUE, thread TEXT, core TEXT)`, `deliveries(id INTEGER PK, message_id TEXT, platform TEXT, target TEXT, status TEXT, attempts INT, next_at INT, error TEXT, sent_at INT, ref TEXT)`, `platform_state(platform TEXT PK, ...PlatformState fields)`. `pausedUntil` is the 429 pause (an addition to the spec's table).
- Ids: `msg_` + `now.toString(36).padStart(9, '0')` + 8 hex chars from `crypto.randomBytes(4)`.
- No `sending` status: a delivery stays `queued` until its result is saved, so a crash mid-send leaves it `queued` (this is how the spec's "back to queued on start" holds).

- [ ] **Step 1: Write the failing tests:**

```ts
const c = (o: Partial<Core> = {}): Core => ({ topic: 'a.b', title: 'T', level: 'info', ...o })
test('insert makes one delivery per target and reads back', () => {
  const db = openDb(':memory:')
  const { id, created } = insertMessage(db, c({ thread: 'H-1' }), 'v1', { slack: '#a', discord: '1' }, 1000)
  assert.ok(created && id.startsWith('msg_'))
  const m = getMessage(db, id)!
  assert.equal(m.status, 'queued'); assert.equal(m.deliveries.length, 2); assert.equal(m.core.thread, 'H-1')
})
test('same key, different content → first message, nothing new queued', () => {
  const db = openDb(':memory:')
  const a = insertMessage(db, c({ key: 'k' }), 'v1', { slack: '#a' }, 1)
  const b = insertMessage(db, c({ key: 'k', title: 'other' }), 'v1', { slack: '#a' }, 2)
  assert.deepEqual(b, { id: a.id, created: false })
  assert.equal(getMessage(db, a.id)!.core.title, 'T'); assert.equal(queuedCount(db, 'slack'), 1)
})
test('nextDelivery: oldest due first, per platform', () => {
  const db = openDb(':memory:')
  insertMessage(db, c({ title: '1' }), 'v1', { slack: '#a' }, 1)
  insertMessage(db, c({ title: '2' }), 'v1', { slack: '#a' }, 2)
  const d1 = nextDelivery(db, 'slack', 10)!
  assert.equal(d1.core.title, '1')
  markRetry(db, d1.id, 100, 'x')
  assert.equal(nextDelivery(db, 'slack', 10)!.core.title, '2')
  assert.equal(oldestQueued(db, 'slack')!.core.title, '1')
  assert.equal(nextDelivery(db, 'discord', 10), null)
})
test('status rolls up from deliveries', () => {
  const db = openDb(':memory:')
  const { id } = insertMessage(db, c(), 'v1', { slack: '#a', x: '#b' }, 1)
  const ids = db.prepare('SELECT id FROM deliveries ORDER BY id').all().map((r) => r.id as number)
  markSent(db, ids[0], 5, 'ts'); assert.equal(getMessage(db, id)!.status, 'queued')
  markFailed(db, ids[1], 'nope'); assert.equal(getMessage(db, id)!.status, 'failed')
})
test('state defaults to up and round-trips', () => {
  const db = openDb(':memory:')
  assert.equal(getState(db, 'slack').status, 'up')
  saveState(db, { ...getState(db, 'slack'), status: 'down', alertSentAt: 7 })
  assert.equal(getState(db, 'slack').alertSentAt, 7)
})
test('prune deletes only finished messages older than 30 days', () => {
  const db = openDb(':memory:')
  const day = 86_400_000
  const old = insertMessage(db, c(), 'v1', { slack: '#a' }, 0).id
  const stuck = insertMessage(db, c(), 'v1', { slack: '#a' }, 0).id
  markSent(db, getDeliveryId(db, old), 1)
  assert.equal(prune(db, 31 * day), 1)
  assert.equal(getMessage(db, old), null); assert.ok(getMessage(db, stuck))
})
```
(`getDeliveryId` is a test helper: `SELECT id FROM deliveries WHERE message_id = ?`.)

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `new DatabaseSync(path)`, `PRAGMA journal_mode = WAL`, `CREATE TABLE IF NOT EXISTS`. `insertMessage` runs in `BEGIN IMMEDIATE … COMMIT`; it looks up `key` first. Status roll-up as in the spec.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notify): sqlite queue and platform state`.

---

### Task 6: Worker and down alert

**Files:**
- Create: `notify/src/worker.ts`, `notify/src/alert.ts`, `notify/test/worker.test.ts`, `notify/test/alert.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 5 `db.ts` functions.
- Produces:
  ```ts
  // alert.ts
  export type Alert = (subject: string, text: string) => Promise<boolean>     // true when Resend accepted it
  export function makeAlert(env: Env, fetchImpl?: typeof fetch): Alert
  // worker.ts
  export type WorkerDeps = {
    db: Db; platform: Platform; env: Env; now: () => number
    alert: Alert; defaultTarget: string | undefined; log: (line: string) => void
  }
  export async function tick(d: WorkerDeps): Promise<number>     // one step; returns ms to wait before the next
  export function startWorker(d: WorkerDeps): { stop(): Promise<void> }
  ```
- `tick` rules (all from the spec; S = `getState`, saved with `saveState` after each change):
  1. `!configured(env)` → if S is not already down with `reason 'no_token'`, set `down`, `reason 'no_token'`, `downSince = now`. Then the alert rule. Return 60 000.
  2. `pausedUntil > now` → return `pausedUntil - now`.
  3. Alert rule (runs every tick while down, so a failed email is retried on the next 60 s probe tick): send when `status = down` and (`alertSentAt` is null or `alertSentAt < downSince`) and not (`alertSentAt` not null and `now - alertSentAt < 3 600 000`). On `true` set `alertSentAt = now`.
  4. Down: if `nextProbeAt > now` return the difference; else probe with `oldestQueued` (none → `nextProbeAt = now + 60 000`, return 60 000). Up: `nextDelivery`; none → return 1000.
  5. Log `notify: <platform> up` / `notify: <platform> down: <reason>` on each change of `status`. Send and apply the result:
     - `ok`: `markSent`. Clear `failingSince`. If S was down: `n = queuedCount` taken **before** `markSent`; set `up`, clear `reason`, `downSince`, `nextProbeAt`; then `platform.send` the notice; a non-`ok` notice is only logged. Return 0.
     - `retry_after`: `pausedUntil = now + seconds * 1000`. Delivery untouched.
     - `transient`: `markRetry(id, now + BACKOFF[min(attempts, 4)], error)` with `BACKOFF = [5, 15, 30, 60, 60] * 1000`. `failingSince ??= now`. If up and `now - failingSince >= 300 000` → `down`, `reason = error`, `downSince = now`. If down → `nextProbeAt = now + 60 000`.
     - `auth`: `markRetry(id, now, error)`. Set `down`, `reason = error`, `downSince ??= now`, `nextProbeAt = now + 60 000`.
     - After any send, return 0.
     - `permanent`: `markFailed`; log `notify: <platform> <target> failed: <error>`; if `defaultTarget` and `target !== defaultTarget`, `platform.send` the failure notice (non-`ok` only logged).
- Exact copy (`<Label>` = `platform.label`, times ISO):
  - Down email subject `hawk: <Label> is down`, text `<Label> is down since <downSince>.\nReason: <reason>\nQueued: <n> messages. They will be sent when <Label> is back.`
  - No-token subject `hawk: <Label> is not set up`, text `The <Label> token is not set in /etc/hawk/hawk.env.\nQueued: <n> messages. They will be sent once it is set and hawk-notifyd restarts.`
  - Recovery notice: core `{ topic: 'hawk.notify', level: 'info', title: '<Label> was unreachable from <downSince> to <now>. <n> messages were delayed.' }` to `defaultTarget`.
  - Failure notice: core `{ topic: 'hawk.notify', level: 'warn', title: 'could not post <topic> to <target>: <error>' }`.
- `makeAlert`: POST `https://api.resend.com/emails`, `authorization: Bearer RESEND_API_KEY`, body `{ from: EMAIL_FROM, to: [EMAIL_TO], subject, text: text + '\n(on ' + os.hostname() + ')' }`, 10 s timeout; returns `res.ok`, `false` on throw or missing env.
- `startWorker`: loop `await tick(d)` then sleep that long (cap 60 000); on a thrown error log it and sleep 5000; `stop()` ends the loop and resolves after the current tick.

- [ ] **Step 1: Write the failing tests** in `worker.test.ts`. Helper `setup(results: Result[], env = { SLACK_BOT_TOKEN: 'x' })` returns `{ d, sent, emails, clock }` where the fake platform (`name 'slack'`, `label 'Slack'`) shifts from `results` (default `ok`) and records `[core.title, target]`, `alert` records `[subject, text]` and returns `true`, `clock.t` is the time, `defaultTarget '#hawk'`.

```ts
test('ok → sent', async () => {
  const { d, sent } = setup([]); const id = insertMessage(d.db, c, 'v1', { slack: '#a' }, 0).id
  await tick(d); assert.equal(getMessage(d.db, id)!.status, 'sent'); assert.deepEqual(sent, [['T', '#a']])
})
test('transient backs off 5s, 15s, 30s, 60s, 60s', async () => {
  const { d, clock } = setup(Array(5).fill({ kind: 'transient', error: 'net' }))
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  const gaps: number[] = []
  for (let i = 0; i < 5; i++) { await tick(d); const r = d.db.prepare('SELECT next_at FROM deliveries').get()!; gaps.push((r.next_at as number) - clock.t); clock.t = r.next_at as number }
  assert.deepEqual(gaps, [5000, 15000, 30000, 60000, 60000])
})
test('5 min of transient → down, one email; restart does not resend', async () => {
  const { d, clock, emails } = setup(Array(20).fill({ kind: 'transient', error: 'net' }))
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  while (clock.t < 400_000) { clock.t += await tick(d) || 1 }
  assert.equal(getState(d.db, 'slack').status, 'down'); assert.equal(emails.length, 1)
  assert.equal(emails[0][0], 'hawk: Slack is down')
  const fresh = { ...d, alert: async (s: string, t: string) => { emails.push([s, t]); return true } }
  await tick(fresh); assert.equal(emails.length, 1)
})
test('429 pauses, is not an outage, delivery untouched', async () => {
  const { d } = setup([{ kind: 'retry_after', seconds: 7 }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); assert.equal(await tick(d), 7000)
  const s = getState(d.db, 'slack'); assert.equal(s.status, 'up'); assert.equal(s.failingSince, null)
})
test('auth → down at once and an email', async () => {
  const { d, emails } = setup([{ kind: 'auth', error: 'invalid_auth' }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); await tick(d)
  assert.equal(getState(d.db, 'slack').reason, 'invalid_auth'); assert.equal(emails.length, 1)
})
test('while down: no sends until probe time; recovery posts notice with n and drains', async () => {
  const { d, sent, clock } = setup([{ kind: 'auth', error: 'invalid_auth' }])
  insertMessage(d.db, { ...c, title: '1' }, 'v1', { slack: '#a' }, 0)
  insertMessage(d.db, { ...c, title: '2' }, 'v1', { slack: '#a' }, 0)
  await tick(d); sent.length = 0
  clock.t += 30_000; await tick(d); assert.equal(sent.length, 0)
  clock.t += 30_000; await tick(d)
  assert.equal(sent[0][0], '1'); assert.match(sent[1][0], /^Slack was unreachable from .* 2 messages were delayed\.$/); assert.equal(sent[1][1], '#hawk')
  await tick(d); assert.equal(sent[2][0], '2'); assert.equal(getState(d.db, 'slack').status, 'up')
})
test('recovery notice failing still marks up and drains', async () => {
  const { d, clock } = setup([{ kind: 'auth', error: 'x' }, { kind: 'ok' }, { kind: 'permanent', error: 'channel_not_found' }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0); insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); clock.t = 60_000; await tick(d); await tick(d)
  assert.equal(getState(d.db, 'slack').status, 'up'); assert.equal(queuedCount(d.db, 'slack'), 0)
})
test('permanent → failed and a notice to the default target', async () => {
  const { d, sent } = setup([{ kind: 'permanent', error: 'not_in_channel' }])
  const id = insertMessage(d.db, c, 'v1', { slack: '#a' }, 0).id
  await tick(d)
  assert.equal(getMessage(d.db, id)!.status, 'failed')
  assert.deepEqual(sent[1], ['could not post a.b to #a: not_in_channel', '#hawk'])
})
test('no token → down no_token, one "not set up" email, no sends', async () => {
  const { d, sent, emails } = setup([], {})
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); await tick(d)
  assert.equal(sent.length, 0); assert.equal(emails.length, 1); assert.equal(emails[0][0], 'hawk: Slack is not set up')
})
test('flapping: second outage within an hour sends no email', async () => {
  const { d, emails, clock } = setup([{ kind: 'auth', error: 'x' }, { kind: 'ok' }, { kind: 'ok' }, { kind: 'auth', error: 'x' }])
  for (let i = 0; i < 3; i++) insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); clock.t = 60_000; await tick(d); clock.t = 120_000; await tick(d); await tick(d)
  assert.equal(emails.length, 1)
})
```

`alert.test.ts`: with a fake fetch, assert the URL, `authorization: Bearer k`, body `from`/`to`/`subject`, text ends with `(on <hostname>)`; `false` when the fetch throws; `false` and no fetch when `RESEND_API_KEY` is missing.

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `alert.ts` and `worker.ts` per the rules above.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notify): delivery worker and the one-email outage alert`.

---

### Task 7: HTTP server and main

**Files:**
- Create: `notify/src/server.ts`, `notify/src/main.ts`, `notify/test/server.test.ts`

**Interfaces:**
- Consumes: `toCore`, `fromCore` (Task 1); `resolve`, `Routes` (Task 2); `platforms` (Task 4); `insertMessage`, `getMessage`, `openDb`, `prune` (Task 5); `startWorker` (Task 6).
- Produces:
  ```ts
  export type ServerDeps = { db: Db; routes: Routes; known: Set<string>; now: () => number; version: string; log: (line: string) => void }
  export function createServer(d: ServerDeps): import('node:http').Server
  ```
- Behaviour: `POST /v1/messages` → read body (> 65 536 bytes → keep reading and discard the rest, then `413 {"error":{"code":"too_large","message":"…"}}`), `JSON.parse` (fail → `400 invalid_json`), `toCore` (fail → `400 invalid` with `field`), targets = `resolve()` filtered to `known` platforms (log any dropped), `insertMessage(…, 'v1', …)`, log `notify: v1 <topic>`, reply `202 {id, status: 'queued'}` or, when `created` is false, `200 {id, status}` with the current status. `GET /v1/messages/:id` → `fromCore` or `404 not_found`. `GET /healthz` → `{version}`. Anything else → `404 not_found`. A thrown error → `500 internal`. All replies are JSON.
- `main.ts`: `PORT = Number(process.env.NOTIFY_PORT ?? 3402)`; DB path `process.env.NOTIFY_DB ?? path.join(process.env.STATE_DIRECTORY ?? '.', 'notify.db')`; `version` = trimmed `../../COMMIT` relative to `import.meta.url`, else `'dev'`; `routes` = default import of `../routes.ts`; start one worker per platform in `platforms` that appears in any route target (`defaultTarget = routes.default[platform.name]`); `prune` at start and every 24 h; listen on `127.0.0.1`; on `SIGTERM`/`SIGINT` close the server, stop workers, close the DB, exit 0.

- [ ] **Step 1: Write the failing tests.** Start `createServer` on port 0 with an in-memory DB, `known = new Set(['slack'])`, and the routes from Task 2's test.

```ts
test('POST queues and GET reads back', async () => {
  const r = await post({ topic: 'a.b.c', title: 'T' }); assert.equal(r.status, 202)
  const { id } = await r.json(); const g = await fetch(`${base}/v1/messages/${id}`)
  const m = await g.json(); assert.equal(m.status, 'queued'); assert.deepEqual(m.deliveries.map((x: any) => x.target), ['#exact'])
})
test('repeat key → 200 with the first id', async () => {
  const a = await (await post({ topic: 'a.b', title: 'T', key: 'k' })).json()
  const b = await post({ topic: 'a.b', title: 'X', key: 'k' })
  assert.equal(b.status, 200); assert.equal((await b.json()).id, a.id)
})
test('bad requests are 4xx with the error shape', async () => {
  const raw = (body: string) => fetch(`${base}/v1/messages`, { method: 'POST', body })
  assert.deepEqual([(await raw('{')).status, (await raw('null')).status, (await raw('[]')).status], [400, 400, 400])
  assert.equal((await (await raw('{')).json()).error.code, 'invalid_json')
  assert.equal((await (await raw('{"title":"t"}')).json()).error.field, 'topic')
  assert.equal((await raw('x'.repeat(70_000))).status, 413)
  assert.equal((await fetch(`${base}/v1/messages/nope`)).status, 404)
  assert.equal((await fetch(`${base}/v2/messages`, { method: 'POST', body: '{}' })).status, 404)
})
test('healthz', async () => assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { version: 'test' }))
```

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `server.ts` and `main.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Smoke run** `NOTIFY_DB=/tmp/n.db NOTIFY_PORT=3402 node notify/src/main.ts &`, then `curl -s -XPOST localhost:3402/v1/messages -d '{"topic":"hawk.test","title":"hi"}'`. Expected: `{"id":"msg_…","status":"queued"}`; the log shows the Slack `no_token` state (no token set). Stop the process.
- [ ] **Step 6: Commit** `feat(notify): http api and service entry point`.

---

### Task 8: Install, systemd, `hawk notify`, docs

**Files:**
- Create: `systemd/hawk-notifyd.service`
- Modify: `install.sh`, `bin/hawk` (`cmd_notify`, usage line 7), `systemd/hawk-notify@.service`, `README.md`

**Interfaces:**
- Consumes: `notify/src/main.ts` (Task 7), env names from Global Constraints.

- [ ] **Step 1: `systemd/hawk-notifyd.service`:** header comment in the style of `mlflow.service` (`# Message service at 127.0.0.1:3402 …`). `Description=hawk: notify service`, `Wants`/`After=network-online.target`, `OnFailure=hawk-notify@%N.service`. `[Service]`: `DynamicUser=true`, `StateDirectory=hawk-notify`, `EnvironmentFile=/etc/hawk/hawk.env`, `ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/hawk/notify/src/main.ts`, `Restart=on-failure`, `RestartSec=5`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`. `[Install] WantedBy=multi-user.target`.
- [ ] **Step 2: `install.sh`:** add `NOTIFY_PORT=3402` beside the other ports and to the `dupes` check and its message. Take a checksum of `$HAWK/notify` before the rsync (`tar -C "$HAWK" -cf - notify 2>/dev/null | sha256sum`) and after; set `restart_notify=1` when they differ or `hawk-notifyd.service` changed. First-install prompt: `read -rsp "Slack bot token (xoxb-…, blank to set later): " slack` and write `SLACK_BOT_TOKEN=%s`. After the required-keys loop: `grep -q '^SLACK_BOT_TOKEN=.' "$ETC/hawk.env" || echo "warning: no SLACK_BOT_TOKEN in $ETC/hawk.env. Messages queue until it is set. Fix it: sudo -e $ETC/hawk.env"`. In the systemd step: `systemctl enable hawk-notifyd`, restart when `restart_notify` or not active, wait up to 30 s for `curl -fsS -m 2 http://127.0.0.1:$NOTIFY_PORT/healthz`, else `die "hawk-notifyd did not start. See journalctl -u hawk-notifyd"`. Update the header comment and the final `Done.` text to mention it.
- [ ] **Step 3: `systemd/hawk-notify@.service`:** add `StateDirectory=hawk-notify-fallback`.
- [ ] **Step 4: `cmd_notify` in `bin/hawk`:** build `{topic: "hawk.alert", title: ($m | .[0:150]), body: ("on " + $host), level: "error"}` with `jq` and `curl -fsS -m 5 --data-binary @- http://127.0.0.1:3402/v1/messages`. On failure: stamp `${STATE_DIRECTORY:-/var/lib/hawk-notify-fallback}/last-email` (`mkdir -p` the dir). If the stamp is newer than 30 minutes (`find "$stamp" -mmin -30`), print `hawk notify: service down, email skipped (one sent in the last 30 min): <message>` to stderr and return 0. Else send today's Resend email with subject `hawk: notify service down: <message>`, then `touch` the stamp. Update usage line 7: `hawk notify <message>  send to the notify service (email if it is down, at most once per 30 min)`.
- [ ] **Step 5: README.md:** in "What it does", replace the Alerts bullet: alerts and app messages go to Slack through `hawk-notifyd` (`POST http://127.0.0.1:3402/v1/messages`, routes in `notify/routes.ts`); email only for "Slack is down" (once per outage) and when `hawk-notifyd` itself is down (once per 30 min); healthchecks.io and gatus emails unchanged. Add `SLACK_BOT_TOKEN` to the first-run list with the Slack setup from the spec (app with `chat:write`, install, invite the bot to each channel). Add a short "Send a message" block with the v1 request example from the spec.
- [ ] **Step 6: Verify** `shellcheck bin/hawk bin/hawk-update install.sh caddy/setup.sh scripts/ship.sh && pnpm typecheck && pnpm test`. Expected: no output from shellcheck, tests PASS.
- [ ] **Step 7: Commit** `feat: install hawk-notifyd and send hawk alerts through it`.
- [ ] **Step 8: Ship — ask the user first.** On their yes: `pnpm ship --task HAWK-8`. Then on the box: `sudo hawk notify "hello from hawk"` → `curl -s localhost:3402/v1/messages/<id>` shows the Slack delivery (`sent`, or `queued` with `no_token` and one "Slack is not set up" email when no token is set yet). `systemctl stop hawk-notifyd; sudo hawk notify a; sudo hawk notify b` → one email only; `systemctl start hawk-notifyd`.
