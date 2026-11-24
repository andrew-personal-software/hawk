import test from 'node:test'
import assert from 'node:assert/strict'
import { commitSubjects, linkTasks, SPARROW_TOKEN_FILE, taskKeys } from '../src/tasks.ts'
import { fakeSys } from './fake.ts'

test('taskKeys', () =>
  assert.deepEqual(taskKeys(['fix(modal-ui): close on escape (SPAR-12) (#40)', 'feat: x (HAWK-3)', 'docs: y', 'fix(SPAR-9): z', 'chore: a (SPAR-12)']),
    ['SPAR-12', 'HAWK-3']))

test('commitSubjects with no previous tag reads only the tag commit', async () => {
  const f = fakeSys({ answer: (c) => { if (c.args[0] === 'describe') throw new Error('no tag'); return 'feat: first (DODO-1)\n' } })
  assert.deepEqual(await commitSubjects('1.0.0', f.sys), ['feat: first (DODO-1)'])
  assert.deepEqual(f.calls.map((c) => c.args), [['describe', '--tags', '--abbrev=0', '--match', 'v*', 'v1.0.0^'], ['log', '-1', '--format=%s', 'v1.0.0']])
})

test('commitSubjects reads the range from the previous tag', async () => {
  const f = fakeSys({ answer: (c) => (c.args[0] === 'describe' ? 'v1.1.0\n' : 'a\nb\n') })
  assert.deepEqual(await commitSubjects('1.2.0', f.sys), ['a', 'b'])
  assert.deepEqual(f.calls[1].args, ['log', '--format=%s', 'v1.1.0..v1.2.0'])
})

const base = { app: 'dodo', version: '1.2.0', url: 'https://u' }

test('linkTasks ok: comment then done', async () => {
  const f = fakeSys()
  assert.deepEqual(await linkTasks({ ...base, keys: ['SPAR-1'], ok: true }, f.sys), { updated: ['SPAR-1'], unknown: [] })
  assert.deepEqual(f.posts, [
    { url: 'http://127.0.0.1:3417/api/tasks/SPAR-1', json: { op: { type: 'addComment', author: 'hawk', body: 'dodo 1.2.0 deployed: https://u' } } },
    { url: 'http://127.0.0.1:3417/api/tasks/SPAR-1', json: { op: { type: 'setStatus', status: 'done' } } }])
})

test('linkTasks failed: comment only', async () => {
  const f = fakeSys()
  await linkTasks({ ...base, keys: ['SPAR-1'], ok: false, error: 'boom' }, f.sys)
  assert.deepEqual(f.posts.map((p) => p.json), [{ op: { type: 'addComment', author: 'hawk', body: 'dodo 1.2.0 deploy failed: boom' } }])
})

test('linkTasks 404 → unknown, no setStatus', async () => {
  const f = fakeSys()
  const sys = { ...f.sys, post: async (url: string, json: unknown) => { f.posts.push({ url, json }); return { status: url.endsWith('X-1') ? 404 : 200, body: '' } } }
  assert.deepEqual(await linkTasks({ ...base, keys: ['X-1', 'SPAR-2'], ok: true }, sys), { updated: ['SPAR-2'], unknown: ['X-1'] })
  assert.equal(f.posts.filter((p) => p.url.endsWith('X-1')).length, 1)
})

test('linkTasks throws on other errors', async () => {
  const f = fakeSys({ post: async () => ({ status: 500, body: 'no' }) })
  await assert.rejects(linkTasks({ ...base, keys: ['SPAR-1'], ok: true }, f.sys), /500 for SPAR-1/)
})

test('linkTasks sends the token from SPARROW_TOKEN_FILE', async () => {
  const f = fakeSys()
  f.files.set(SPARROW_TOKEN_FILE, 't\n')
  await linkTasks({ ...base, keys: ['SPAR-1'], ok: true }, f.sys)
  assert.deepEqual(f.posts.map((p) => p.headers), [{ authorization: 'Bearer t' }, { authorization: 'Bearer t' }])
})

test('linkTasks without a token file sends no headers', async () => {
  const f = fakeSys()
  await linkTasks({ ...base, keys: ['SPAR-1'], ok: false }, f.sys)
  assert.deepEqual(f.posts.map((p) => p.headers), [undefined])
})
