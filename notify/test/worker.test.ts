import test from 'node:test'
import assert from 'node:assert/strict'
import type { Core, Env, Platform, Result } from '../src/core.ts'
import { openDb, insertMessage, getMessage, getState, queuedCount } from '../src/db.ts'
import { tick, startWorker } from '../src/worker.ts'
import { makeSlack } from '../src/platforms/slack.ts'
import type { WorkerDeps } from '../src/worker.ts'

const c: Core = { topic: 'a.b', title: 'T', level: 'info' }

function setup(results: Result[], env: Env = { SLACK_BOT_TOKEN: 'x' }) {
  const sent: [string, string][] = []
  const emails: [string, string][] = []
  const logs: string[] = []
  const clock = { t: 0 }
  const platform: Platform = {
    name: 'slack',
    label: 'Slack',
    configured: (e) => !!e.SLACK_BOT_TOKEN,
    async send(core, target) {
      sent.push([core.title, target])
      return results.shift() ?? { kind: 'ok' }
    },
  }
  const d: WorkerDeps = {
    db: openDb(':memory:'), platform, env, now: () => clock.t, defaultTarget: '#hawk',
    alert: async (s, t) => { emails.push([s, t]); return true },
    log: (line) => { logs.push(line) },
  }
  return { d, sent, emails, clock, logs }
}

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
test('down email copy and status-change logs', async () => {
  const { d, emails, logs, clock } = setup([{ kind: 'auth', error: 'invalid_auth' }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0); insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); await tick(d); clock.t = 60_000; await tick(d)
  assert.deepEqual(emails, [['hawk: Slack is down',
    'Slack is down since 1970-01-01T00:00:00.000Z.\nReason: invalid_auth\nQueued: 2 messages. They will be sent when Slack is back.']])
  assert.deepEqual(logs, ['notify: slack down: invalid_auth', 'notify: slack up'])
})
test('a failed email is retried on the next tick', async () => {
  const { d, emails } = setup([{ kind: 'auth', error: 'x' }])
  let ok = false
  d.alert = async (s, t) => { emails.push([s, t]); return ok }
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); await tick(d); ok = true; await tick(d); await tick(d)
  assert.equal(emails.length, 2)
})
test('a poison message fails permanently and leaves slack up', async () => {
  const { d } = setup([])
  d.platform = makeSlack(async () => Response.json({ ok: true, ts: '1' }))
  const poison = { ...c, link: ['https://x.y'] } as unknown as Core
  const id = insertMessage(d.db, poison, 'v1', { slack: '#a' }, 0).id
  await tick(d)
  assert.equal(getMessage(d.db, id)!.status, 'failed')
  const s = getState(d.db, 'slack'); assert.equal(s.status, 'up'); assert.equal(s.failingSince, null)
})
test('permanent clears failingSince: a blip two days later is not an outage', async () => {
  const { d, emails, clock } = setup([{ kind: 'transient', error: 'net' }, { kind: 'permanent', error: 'not_in_channel' }, { kind: 'ok' }, { kind: 'transient', error: 'blip' }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0); insertMessage(d.db, c, 'v1', { slack: '#b' }, 0)
  await tick(d); clock.t = 1000; await tick(d)
  assert.equal(getState(d.db, 'slack').failingSince, null)
  clock.t = 2 * 86_400_000; await tick(d); await tick(d)
  assert.equal(getState(d.db, 'slack').status, 'up'); assert.equal(emails.length, 0)
})
test('retry_after clears failingSince', async () => {
  const { d, clock } = setup([{ kind: 'transient', error: 'net' }, { kind: 'retry_after', seconds: 1 }])
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); clock.t = 5000; await tick(d)
  assert.equal(getState(d.db, 'slack').failingSince, null)
})
test('bad token after no_token is a new outage: a second email with the real reason', async () => {
  const { d, emails, logs, clock } = setup([{ kind: 'auth', error: 'invalid_auth' }], {})
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); assert.deepEqual(emails.map((e) => e[0]), ['hawk: Slack is not set up'])
  clock.t = 3_700_000; d.env.SLACK_BOT_TOKEN = 'bad'
  await tick(d); await tick(d); await tick(d)
  assert.deepEqual(emails.map((e) => e[0]), ['hawk: Slack is not set up', 'hawk: Slack is down'])
  assert.match(emails[1][1], /Reason: invalid_auth/)
  const s = getState(d.db, 'slack'); assert.equal(s.reason, 'invalid_auth'); assert.equal(s.downSince, 3_700_000)
  assert.deepEqual(logs, ['notify: slack down: no_token', 'notify: slack down: invalid_auth'])
})
test('transient after no_token takes the transient reason and a new downSince', async () => {
  const { d, logs, clock } = setup([{ kind: 'transient', error: 'net' }], {})
  insertMessage(d.db, c, 'v1', { slack: '#a' }, 0)
  await tick(d); clock.t = 1000; d.env.SLACK_BOT_TOKEN = 'x'; await tick(d)
  const s = getState(d.db, 'slack'); assert.equal(s.reason, 'net'); assert.equal(s.downSince, 1000)
  assert.deepEqual(logs, ['notify: slack down: no_token', 'notify: slack down: net'])
})
test('startWorker: stop() cancels the sleep', async () => {
  const { d, emails } = setup([], {})
  const w = startWorker(d)
  await new Promise((r) => setImmediate(r))
  await w.stop()
  assert.equal(emails.length, 1)
})
