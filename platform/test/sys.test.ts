import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locks, realSys } from '../src/sys.ts'

const skip = spawnSync('flock', ['-h']).error ? 'no flock on this machine' : false
locks.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawk-lock-'))
const file = (name: string) => `${locks.dir}/${name}.lock`

test('lock: a held lock is busy until released', { skip }, () => {
  const unlock = realSys.lock('a')
  assert.throws(() => realSys.lock('a'), /busy/)
  unlock()
  realSys.lock('a')()
})

// Two takers that both remove a stale file can both win. Taking it must never replace the file.
test('lock: a stale lock file is taken in place, not removed', { skip }, () => {
  fs.writeFileSync(file('b'), '999999')
  const ino = fs.statSync(file('b')).ino
  const unlock = realSys.lock('b')
  assert.equal(fs.statSync(file('b')).ino, ino)
  unlock()
  assert.equal(fs.statSync(file('b')).ino, ino)
})

test('lock: a holder killed with -9 frees the lock', { skip }, async () => {
  const src = path.resolve(import.meta.dirname, '../src/sys.ts')
  const child = spawn('node', ['-e', `import(${JSON.stringify(src)}).then((m) => { m.locks.dir = ${JSON.stringify(locks.dir)}; m.realSys.lock('c'); console.log('held'); setInterval(() => {}, 1000) })`])
  await new Promise<void>((r) => child.stdout.on('data', () => r()))
  assert.throws(() => realSys.lock('c'), /busy/)
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  realSys.lock('c')()
})
