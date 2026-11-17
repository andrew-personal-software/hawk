import test from 'node:test'
import assert from 'node:assert/strict'
import type { Core } from '../src/core.ts'
import { render, mapResponse, makeDiscord } from '../src/platforms/discord.ts'
import { platforms } from '../src/platforms/index.ts'
import routes from '../routes.ts'

const msg = (o: Partial<Core> = {}): Core => ({ topic: 'a.b', title: 'T', level: 'info', ...o })
const first = (o: Partial<Core>) => render(msg(o))[0].content

test('render: header with level prefix', () => {
  assert.equal(first({}), '**T**')
  assert.equal(first({ level: 'warn' }), '⚠️ **T**')
  assert.equal(first({ level: 'error' }), '🚨 **T**')
  assert.equal(first({ body: 'x' }), '**T**\nx')
})
test('render: escapes markdown characters in title and text', () => {
  assert.equal(first({ title: 'a*b_c~d|e[f]g`h\\i', body: 'a*b_c~d|e[f]g`h\\i' }),
    '**a\\*b\\_c\\~d\\|e\\[f\\]g\\`h\\\\i**\na\\*b\\_c\\~d\\|e\\[f\\]g\\`h\\\\i')
})
test('render: bold, italic, code, link, heading, quote, list, fence', () => {
  const body = '**b** *i* _j_ `c` [a b](https://u.v/x)\n\n# H\n\n> q1\n> q2\n\n```js\na*b\n```\n\n- x\n- y\n\n1. a\n2. b'
  assert.equal(first({ body }),
    '**T**\n**b** *i* *j* `c` [a b](https://u.v/x)\n\n### H\n\n> q1\n> q2\n\n```\na*b\n```\n\n- x\n- y\n\n1. a\n2. b')
})
test('render: link urls escape ) and space', () => {
  assert.equal(first({ link: 'https://l.m/a b)' }), '**T**\n\n[Open](https://l.m/a%20b%29)')
  assert.equal(first({ body: '[x](https://u.v/a)' }), '**T**\n[x](https://u.v/a)')
  assert.equal(first({ body: 'see https://u.v/a.' }), '**T**\nsee https://u.v/a.')
})
test('render: allowed_mentions on every part', () => {
  const parts = render(msg({ body: 'a'.repeat(5000), link: 'https://l.m' }))
  assert.ok(parts.length > 1)
  for (const p of parts) assert.deepEqual(p.allowed_mentions, { parse: [] })
})
test('render: a 40000-char body splits into numbered parts ≤ 2000, nothing lost', () => {
  const parts = render(msg({ body: 'a'.repeat(40000) }))
  assert.ok(parts.length > 20)
  assert.ok(parts.every((p) => p.content.length <= 2000))
  assert.deepEqual(parts.map((p) => p.content.split('\n')[0]), parts.map((_, i) => `**T** (${i + 1}/${parts.length})`))
  assert.equal(parts.map((p) => p.content.split('\n').slice(1).join('\n')).join(''), 'a'.repeat(40000))
})
test('render: hard split prefers the last space or newline, dropping it', () => {
  const body = ('word '.repeat(600)).trim()
  const parts = render(msg({ body }))
  assert.ok(parts.length > 1 && parts.every((p) => p.content.length <= 2000))
  const rejoined = parts.map((p) => p.content.split('\n').slice(1).join('\n')).join(' ')
  assert.equal(rejoined, body)
})
test('render: blocks pack together up to the budget', () => {
  const body = ['p', 'q', 'r'].map((c) => c.repeat(900)).join('\n\n')
  const parts = render(msg({ body }))
  assert.deepEqual(parts.map((p) => p.content), [
    `**T** (1/2)\n${'p'.repeat(900)}\n\n${'q'.repeat(900)}`,
    `**T** (2/2)\n${'r'.repeat(900)}`,
  ])
})
test('render: link fits in the last part, or becomes its own final part with the raw url', () => {
  const small = render(msg({ body: 'x', link: 'https://l.m' }))
  assert.equal(small.length, 1)
  assert.equal(small[0].content.split('\n').at(-1), '[Open](https://l.m)')
  const url = 'https://l.m/' + 'z'.repeat(1990 - 12)
  assert.equal(url.length, 1990)
  const big = render(msg({ title: 't'.repeat(100), body: 'b'.repeat(1500), link: url }))
  assert.equal(big.length, 2)
  assert.equal(big[0].content.split('\n')[0], `**${'t'.repeat(100)}** (1/2)`)
  assert.equal(big[1].content, url)
  assert.ok(big.every((p) => p.content.length <= 2000))
})
test('render: 100+ parts keep every part ≤ 2000', () => {
  const body = Array(110).fill('a'.repeat(1986)).join('\n\n')
  const parts = render(msg({ body }))
  assert.ok(parts.length > 99, String(parts.length))
  assert.ok(parts.every((p) => p.content.length <= 2000))
})
test('mapResponse', () => {
  assert.deepEqual(mapResponse(200, { id: '77' }), { kind: 'ok', ref: '77' })
  assert.deepEqual(mapResponse(204, null), { kind: 'ok', ref: undefined })
  assert.deepEqual(mapResponse(200, { id: 5 }), { kind: 'ok', ref: undefined })
  assert.deepEqual(mapResponse(429, { retry_after: 1.2 }), { kind: 'retry_after', seconds: 2 })
  assert.deepEqual(mapResponse(429, { retry_after: 7 }), { kind: 'retry_after', seconds: 7 })
  for (const b of [{}, null, { retry_after: 0 }, { retry_after: -1 }, { retry_after: 'x' }, { retry_after: Infinity }])
    assert.deepEqual(mapResponse(429, b), { kind: 'retry_after', seconds: 30 })
  assert.deepEqual(mapResponse(401, { message: '401: Unauthorized' }), { kind: 'auth', error: 'http 401: 401: Unauthorized' })
  assert.deepEqual(mapResponse(401, null), { kind: 'auth', error: 'http 401: unauthorized' })
  assert.deepEqual(mapResponse(503, null), { kind: 'transient', error: 'http 503' })
  assert.deepEqual(mapResponse(403, { code: 50013, message: 'Missing Permissions' }), { kind: 'permanent', error: 'http 403: 50013 Missing Permissions' })
  assert.deepEqual(mapResponse(404, { message: 'Unknown Channel' }), { kind: 'permanent', error: 'http 404: Unknown Channel' })
  assert.deepEqual(mapResponse(400, null), { kind: 'permanent', error: 'http 400' })
})
test('send posts to the channel with Bot auth and user-agent; network error → transient', async () => {
  let seen: [string, RequestInit] | undefined
  const ok = makeDiscord(async (url, init) => { seen = [String(url), init!]; return Response.json({ id: '9' }) })
  assert.deepEqual(await ok.send(msg(), '123/4', { DISCORD_BOT_TOKEN: 'tok' }), { kind: 'ok', ref: '9' })
  assert.equal(seen![0], 'https://discord.com/api/v10/channels/123%2F4/messages')
  assert.equal(seen![1].method, 'POST')
  const h = seen![1].headers as Record<string, string>
  assert.equal(h.authorization, 'Bot tok')
  assert.equal(h['content-type'], 'application/json')
  assert.equal(h['user-agent'], 'DiscordBot (hawk-notify, 1.0)')
  assert.deepEqual(JSON.parse(seen![1].body as string), { content: '**T**', allowed_mentions: { parse: [] } })
  const down = makeDiscord(async () => { throw new TypeError('fetch failed') })
  assert.equal((await down.send(msg(), '1', { DISCORD_BOT_TOKEN: 'x' })).kind, 'transient')
  assert.equal(ok.name, 'discord')
  assert.equal(ok.label, 'Discord')
  assert.equal(ok.configured({}), false)
  assert.equal(ok.configured({ DISCORD_BOT_TOKEN: '' }), false)
  assert.equal(ok.configured({ DISCORD_BOT_TOKEN: 'x' }), true)
})
test('send: a render throw is permanent and never fetches', async () => {
  let calls = 0
  const d = makeDiscord(async () => { calls++; return Response.json({ id: '1' }) })
  const r = await d.send({ topic: 'a.b', title: 'T', level: 'info', link: ['https://x.y'] } as unknown as Core, '1', { DISCORD_BOT_TOKEN: 'x' })
  assert.equal(r.kind, 'permanent')
  assert.match((r as { error: string }).error, /^render: /)
  assert.equal(calls, 0)
})
test('send: parts in order 1 s apart, first id is the ref, stops at the first failure', async () => {
  const m = msg({ body: 'a'.repeat(5000) })
  const n = render(m).length
  const bodies: string[] = []
  const waits: number[] = []
  const all = makeDiscord(async (_u, init) => { bodies.push(init!.body as string); return Response.json({ id: String(bodies.length) }) }, async (ms) => { waits.push(ms) })
  assert.deepEqual(await all.send(m, '1', { DISCORD_BOT_TOKEN: 'x' }), { kind: 'ok', ref: '1' })
  assert.deepEqual(bodies.map((b) => JSON.parse(b).content), render(m).map((p) => p.content))
  assert.deepEqual(waits, Array(n - 1).fill(1000))
  let calls = 0
  const half = makeDiscord(async () => (++calls === 1 ? Response.json({ id: '1' }) : Response.json({ code: 50013, message: 'Missing Permissions' }, { status: 403 })), async () => {})
  assert.deepEqual(await half.send(m, '1', { DISCORD_BOT_TOKEN: 'x' }), { kind: 'permanent', error: 'http 403: 50013 Missing Permissions' })
  assert.equal(calls, 2)
})
test('every platform in routes.ts has an adapter', () => {
  const names = new Set(platforms.map((p) => p.name))
  for (const t of [routes.default, ...Object.values(routes.routes)])
    for (const p of Object.keys(t)) assert.ok(names.has(p), `no adapter for "${p}"`)
})
test('routes guard: every discord target is a real channel id (fails until pasted)', () => {
  for (const t of [routes.default, ...Object.values(routes.routes)] as Record<string, string>[])
    if (t.discord !== undefined) assert.match(t.discord, /^\d{17,20}$/, `discord target "${t.discord}" is not a channel id`)
})
