import test from 'node:test'
import assert from 'node:assert/strict'
import type { Core } from '../src/core.ts'
import { render, mapResponse, makeSlack } from '../src/platforms/slack.ts'
import { platforms } from '../src/platforms/index.ts'
import routes from '../routes.ts'

test('render: title section with level prefix, body, link', () => {
  const p = render({ topic: 'a.b', title: 'T <1>', level: 'error', body: '**b** [x](https://u.v)', link: 'https://l.m' })
  assert.equal(p.text, 'T &lt;1&gt;')
  assert.deepEqual(p.blocks.map((b) => b.text.text), [':rotating_light: *T &lt;1&gt;*', '*b* <https://u.v|x>', '<https://l.m|Open>'])
})
test('render: warn prefix, info none, heading → bold line, italic → _x_', () => {
  assert.equal(render({ topic: 'a.b', title: 'T', level: 'warn' }).blocks[0].text.text, ':warning: *T*')
  assert.equal(render({ topic: 'a.b', title: 'T', level: 'info', body: '# H\n\n*i*' }).blocks[1].text.text, '*H*\n\n_i_')
})
test('render: quote, code, lists, inline code, escaping in text and link text', () => {
  const body = '> q1\n> q2\n\n```js\na<b\n```\n\n- x\n- y\n\n1. a\n2. b\n\n`c&d` [a<b](https://u.v)'
  assert.equal(
    render({ topic: 'a.b', title: 'T', level: 'info', body }).blocks[1].text.text,
    '> q1\n> q2\n\n```a&lt;b```\n\n• x\n• y\n\n1. a\n2. b\n\n`c&amp;d` <https://u.v|a&lt;b>',
  )
})
test('render: | < > in link urls are percent-encoded', () => {
  const p = render({ topic: 'a.b', title: 'T', level: 'info', body: '[x](https://u.v/a|b<c>d)', link: 'https://l.m/?q=a|b<c>' })
  assert.deepEqual(p.blocks.map((b) => b.text.text), ['*T*', '<https://u.v/a%7Cb%3Cc%3Ed|x>', '<https://l.m/?q=a%7Cb%3Cc%3E|Open>'])
})
test('render: long body splits at paragraphs into sections ≤ 3000', () => {
  const body = Array.from({ length: 10 }, () => 'p'.repeat(1000)).join('\n\n')
  const secs = render({ topic: 'a.b', title: 'T', level: 'info', body }).blocks.slice(1)
  assert.ok(secs.length > 1 && secs.every((b) => b.text.text.length <= 3000))
})
test('render: hard split never cuts inside an entity or link', () => {
  const body = 'a'.repeat(2998) + '&<>' + ' [x y](https://u.v) ' + 'b'.repeat(5000)
  const secs = render({ topic: 'a.b', title: 'T', level: 'info', body }).blocks.slice(1).map((b) => b.text.text)
  assert.ok(secs.length > 1 && secs.every((s) => s.length <= 3000))
  for (const s of secs) {
    assert.ok(!/&[a-z]{0,3}$/.test(s), s.slice(-10))
    assert.equal((s.match(/</g) ?? []).length - (s.match(/&lt;/g) ?? []).length, (s.match(/>/g) ?? []).length - (s.match(/&gt;/g) ?? []).length)
  }
})
test('render: escaped worst case stays ≤ 50 blocks of ≤ 3000', () => {
  const p = render({ topic: 'a.b', title: 'T', level: 'info', body: '&<>'.repeat(13333), link: 'https://l.m' })
  assert.ok(p.blocks.length <= 50 && p.blocks.every((b) => b.text.text.length <= 3000))
  assert.equal(p.blocks[p.blocks.length - 2].text.text, '_(truncated)_')
  assert.equal(p.blocks[p.blocks.length - 1].text.text, '<https://l.m|Open>')
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
  assert.equal(ok.configured({ SLACK_BOT_TOKEN: '' }), false)
  assert.equal(ok.configured({ SLACK_BOT_TOKEN: 'x' }), true)
})
test('send: a render throw is permanent and never fetches', async () => {
  let calls = 0
  const s = makeSlack(async () => { calls++; return Response.json({ ok: true }) })
  const poison = { topic: 'a.b', title: 'T', level: 'info', link: ['https://x.y'] } as unknown as Core
  const r = await s.send(poison, '#c', { SLACK_BOT_TOKEN: 'x' })
  assert.equal(r.kind, 'permanent')
  assert.match((r as { error: string }).error, /^render: /)
  assert.equal(calls, 0)
})
test('every platform in routes.ts has an adapter', () => {
  const names = new Set(platforms.map((p) => p.name))
  for (const t of [routes.default, ...Object.values(routes.routes)])
    for (const p of Object.keys(t)) assert.ok(names.has(p), `no adapter for "${p}"`)
})
