import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { openDb } from '../src/db.ts'
import { createServer } from '../src/server.ts'

const routes = { default: { slack: '#d' }, routes: { 'a.*': { slack: '#a' }, 'a.b.*': { slack: '#ab' }, 'a.b.c': { slack: '#exact' } } }
const server = createServer({ db: openDb(':memory:'), routes, known: new Set(['slack']), now: Date.now, version: 'test', log: () => {} })
let base = ''
const post = (body: unknown) => fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify(body) })

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => { server.close() })

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
test('no known platform still inserts a sent message', async () => {
  const lines: string[] = []
  const s = createServer({ db: openDb(':memory:'), routes: { default: { discord: '1' }, routes: {} }, known: new Set(['slack']), now: Date.now, version: 't', log: (l) => lines.push(l) })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  const r = await fetch(`${b}/v1/messages`, { method: 'POST', body: JSON.stringify({ topic: 'x.y', title: 'T' }) })
  const { id } = await r.json()
  assert.equal(r.status, 202)
  assert.equal((await (await fetch(`${b}/v1/messages/${id}`)).json()).status, 'sent')
  assert.ok(lines.includes('notify: no known platform for x.y'))
  s.close()
})
