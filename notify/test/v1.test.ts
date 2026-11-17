import test from 'node:test'
import assert from 'node:assert/strict'
import { toCore, fromCore } from '../src/api/v1.ts'
import type { Invalid } from '../src/api/v1.ts'
import type { MessageView } from '../src/core.ts'

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
    [{ ...ok, link: ['https://x.y'] }, 'link'],
    [{ ...ok, link: 'https://x.y/' + 'a'.repeat(1989) }, 'link'],
    [{ ...ok, thread: '' }, 'thread'],
    [{ ...ok, key: 'k'.repeat(201) }, 'key'],
    [{ ...ok, title: 5 }, 'title'],
  ]
  for (const [input, field] of cases) assert.equal((toCore(input) as Invalid).field, field, JSON.stringify(input))
})
test('topic: 250 chars accepted, 251 rejected', () => {
  const topic = (n: number) => 'a.' + 'b'.repeat(n - 2)
  assert.equal(toCore({ ...ok, topic: topic(250) }).ok, true)
  assert.equal((toCore({ ...ok, topic: topic(251) }) as Invalid).field, 'topic')
})
test('a 2000-char link is accepted', () => {
  const link = 'https://x.y/' + 'a'.repeat(1988)
  assert.equal(link.length, 2000)
  assert.equal(toCore({ ...ok, link }).ok, true)
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
