import test from 'node:test'
import assert from 'node:assert/strict'
import { backupApp, pruneList } from '../src/backup.ts'
import type { App } from '../src/types.ts'
import { fakeSys } from './fake.ts'

const app: App = { name: 'dodo', port: 3420, health: '/api/version', uid: 1, gid: 1, spec: {} }

test('pruneList keeps the newest by stamp', () => {
  const dumps = Array.from({ length: 9 }, (_, i) => `dodo-2026111${i}T030000Z.dump`)
  const tars = ['dodo-20261110T030000Z-files.tar.gz', 'dodo-20261111T030000Z-files.tar.gz']
  const shuffled = [...dumps.slice(4), ...tars, ...dumps.slice(0, 4), 'dodo-pre-postgres.db']
  assert.deepEqual(pruneList(shuffled, '.dump', 7), [dumps[1], dumps[0]])
  assert.deepEqual(pruneList(shuffled, '-files.tar.gz', 7), [])
})

test('backupApp dumps to .tmp then renames; no tar for an empty volume; no prune', async () => {
  const f = fakeSys()
  for (let i = 0; i < 9; i++) f.files.set(`/var/backups/dodo/dodo-2026110${i}T030000Z.dump`, '')
  const out = await backupApp(app, f.sys, { prune: false })
  const dump = f.calls[0]
  assert.deepEqual(dump.args, ['exec', 'postgres', 'pg_dump', '-Fc', '-U', 'postgres', '-d', 'apps', '-n', 'dodo'])
  assert.equal(dump.opts!.stdoutFile, '/var/backups/dodo/dodo-20261118T120000Z.dump.tmp')
  assert.deepEqual(f.calls[1], { cmd: 'mv', args: ['/var/backups/dodo/dodo-20261118T120000Z.dump.tmp', '/var/backups/dodo/dodo-20261118T120000Z.dump'], opts: undefined })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(out, ['/var/backups/dodo/dodo-20261118T120000Z.dump'])
  assert.ok(!f.log.some((l) => l.startsWith('remove')))
})

test('backupApp tars a non-empty volume and prunes', async () => {
  const f = fakeSys({ answer: (c) => { if (c.cmd === 'mv') f.files.set(c.args[1], ''); return '' } })
  f.files.set('/var/lib/dodo/files', '')
  for (let i = 0; i < 9; i++) f.files.set(`/var/backups/dodo/dodo-2026110${i}T030000Z.dump`, '')
  const sys = { ...f.sys, list: (d: string) => (d === '/var/lib/dodo' ? ['files'] : f.sys.list(d)) }
  const out = await backupApp(app, sys, { prune: true })
  assert.deepEqual(f.calls[2].args, ['-czf', '/var/backups/dodo/dodo-20261118T120000Z-files.tar.gz.tmp', '-C', '/var/lib/dodo', '.'])
  assert.equal(out[1], '/var/backups/dodo/dodo-20261118T120000Z-files.tar.gz')
  assert.deepEqual(f.log.filter((l) => l.startsWith('remove')), [2, 1, 0].map((i) => `remove /var/backups/dodo/dodo-2026110${i}T030000Z.dump`))
})

test('backupApp removes the .tmp when pg_dump fails', async () => {
  const f = fakeSys({ answer: (c) => { if (c.args.includes('pg_dump')) { f.files.set(c.opts!.stdoutFile!, 'half'); throw new Error('pg_dump exited 1') } return '' } })
  await assert.rejects(backupApp(app, f.sys, { prune: false }), /pg_dump/)
  assert.deepEqual([...f.files.keys()].filter((k) => k.endsWith('.tmp')), [])
})
