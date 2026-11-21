import test from 'node:test'
import assert from 'node:assert/strict'
import type { Core } from '../src/core.ts'
import {
  openDb, insertMessage, getMessage, nextDelivery, oldestQueued, queuedCount,
  markSent, markRetry, markFailed, getState, saveState, prune,
} from '../src/db.ts'
import type { Db } from '../src/db.ts'

const c = (o: Partial<Core> = {}): Core => ({ topic: 'a.b', title: 'T', level: 'info', ...o })
const getDeliveryId = (db: Db, messageId: string): number =>
  db.prepare('SELECT id FROM deliveries WHERE message_id = ?').get(messageId)!.id as number

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
test('nextDelivery: a thread waits for its older queued delivery to the same target', () => {
  const db = openDb(':memory:')
  insertMessage(db, c({ title: '1', thread: 'H' }), 'v1', { slack: '#a' }, 1)
  insertMessage(db, c({ title: '2', thread: 'H' }), 'v1', { slack: '#a' }, 2)
  insertMessage(db, c({ title: '3', thread: 'H' }), 'v1', { slack: '#b' }, 3)
  const d1 = nextDelivery(db, 'slack', 10)!
  markRetry(db, d1.id, 100, 'x')
  assert.equal(nextDelivery(db, 'slack', 10)!.core.title, '3')
  markSent(db, d1.id, 10, 'ts')
  assert.equal(nextDelivery(db, 'slack', 10)!.core.title, '2')
})
