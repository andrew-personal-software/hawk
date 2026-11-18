import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAppEnv, parseSpec, slotPort } from '../src/config.ts'
import type { App } from '../src/types.ts'

export const dodoSpec = {
  web: { command: ['node', 'node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0', '-p', '3000'] },
  migrate: ['node', 'dist/migrate.js'],
  jobs: { cleanup: { command: ['node', 'dist/cleanup.js'], schedule: '*-*-* 03:30:00' } },
  env: { NODE_ENV: 'production', DODO_FILES: '/data/files' },
  tmpfs: ['/app/.next/cache'],
}

test('parseSpec accepts dodo spec unchanged', () => assert.deepEqual(parseSpec(structuredClone(dodoSpec), 'dodo'), dodoSpec))

const bad: [string, unknown, RegExp][] = [
  ['worker name', { workers: { Bad: ['x'] } }, /workers\.Bad/],
  ['DATABASE_URL', { env: { DATABASE_URL: 'x' } }, /env\.DATABASE_URL/],
  ['PORT', { env: { PORT: '1' } }, /env\.PORT/],
  ['env file outside /etc/<app>', { envFiles: ['/etc/other/x.env'] }, /envFiles\[0\]/],
  ['empty web command', { web: { command: [] } }, /web\.command/],
  ['empty job schedule', { jobs: { cleanup: { command: ['x'], schedule: '' } } }, /jobs\.cleanup\.schedule/],
  ['relative tmpfs', { tmpfs: ['tmp'] }, /tmpfs\[0\]/],
  ['bad env key', { env: { 'a-b': 'x' } }, /env\.a-b/],
  ['not an object', [], /spec/],
]
for (const [name, json, re] of bad) test(`parseSpec rejects ${name}`, () => assert.throws(() => parseSpec(json, 'dodo'), re))

test('parseSpec allows env files under /etc/<app>/', () =>
  assert.deepEqual(parseSpec({ envFiles: ['/etc/dodo/dodo.env'] }, 'dodo'), { envFiles: ['/etc/dodo/dodo.env'] }))

test('parseAppEnv reads podman runtime', () =>
  assert.deepEqual(parseAppEnv('PORT=3420\nHEALTH=/api/version\nRUNTIME=podman\n'), { port: 3420, health: '/api/version', runtime: 'podman' }))
test('parseAppEnv defaults to systemd and strips quotes', () =>
  assert.deepEqual(parseAppEnv('# c\nPORT=3420\nSERVICES="dodo"\nHEALTH="/api/version"\n'), { port: 3420, health: '/api/version', runtime: 'systemd' }))
test('parseAppEnv needs PORT', () => assert.throws(() => parseAppEnv('HEALTH=/x\n'), /PORT/))

const app: App = { name: 'dodo', port: 3420, health: '/api/version', uid: 1, gid: 1, spec: {} }
test('slotPort', () => { assert.equal(slotPort(app, 'blue'), 3420); assert.equal(slotPort(app, 'green'), 4420) })
