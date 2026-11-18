import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureDb, ensureSql } from '../src/db.ts'
import { fakeSys } from './fake.ts'

test('ensureSql makes the role, schema and search_path', () => {
  const sql = ensureSql('dodo', 'ab12')
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS dodo AUTHORIZATION dodo/)
  assert.match(sql, /ALTER ROLE dodo SET search_path = dodo, public/)
  assert.match(sql, /GRANT CONNECT ON DATABASE apps TO dodo/)
  assert.match(sql, /CREATE ROLE dodo LOGIN PASSWORD 'ab12'/)
  assert.match(sql, /ALTER ROLE dodo LOGIN PASSWORD 'ab12'/)
})
test('ensureSql rejects a bad app name', () => assert.throws(() => ensureSql('x;drop', 'ab')))
test('ensureSql rejects a bad password', () => assert.throws(() => ensureSql('dodo', "a'b")))

test('ensureDb makes a password once and feeds the SQL to psql', async () => {
  const f = fakeSys()
  await ensureDb('dodo', f.sys)
  const env = f.files.get('/etc/hawk/db/dodo.env')!
  const m = /^DATABASE_URL=postgres:\/\/dodo:([0-9a-f]{64})@postgres:5432\/apps\n$/.exec(env)
  assert.ok(m, env)
  assert.deepEqual(f.calls[0].args, ['exec', '-i', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'apps'])
  assert.match(f.calls[0].opts!.input!, new RegExp(`PASSWORD '${m[1]}'`))
  await ensureDb('dodo', f.sys)
  assert.equal(f.files.get('/etc/hawk/db/dodo.env'), env)
})
