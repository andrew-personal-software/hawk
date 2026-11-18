import test from 'node:test'
import assert from 'node:assert/strict'
import { DeployError, out, release, rollback } from '../src/release.ts'
import { renderUnits } from '../src/quadlet.ts'
import type { App, AppSpec } from '../src/types.ts'
import { dodoSpec } from './config.test.ts'
import { fakeSys, RUNNER_UID, type Call } from './fake.ts'

out.log = () => {}
const D = 'andrewminghanjiang.com'
const STATE = '/var/lib/hawk/apps/dodo.json'
const SITE = '/etc/caddy/sites/dodo.caddy'
const app: App = { name: 'dodo', port: 3420, health: '/api/version', uid: 990, gid: 991, spec: dodoSpec }

const manifest = (c: Call) =>
  c.cmd === 'tar' ? JSON.stringify([{ RepoTags: ['localhost/dodo:1.1.0'] }]) : c.cmd === 'id' ? `${RUNNER_UID}\n` : ''

function setup(o: { state?: object; spec?: AppSpec; version?: string; answer?: (c: Call) => string; health?: string } = {}) {
  const version = o.version ?? '1.1.0'
  const f = fakeSys({
    answer: (c) => (o.answer ? o.answer(c) : manifest(c)),
    get: async (url) => { f.log.push(`get ${url}`); return { status: 200, body: o.health ?? JSON.stringify({ version }) } },
  })
  if (o.state) f.files.set(STATE, JSON.stringify(o.state))
  f.files.set(`/var/lib/hawk-images/dodo-${version}.json`, JSON.stringify(o.spec ?? dodoSpec))
  f.files.set(`/var/lib/hawk-images/dodo-${version}.tar`, '')
  return f
}
const blue = { slot: 'blue', version: '1.0.0', previous: null, at: '2026-11-17T00:00:00.000Z' }
const at = (log: string[], s: string) => { const i = log.findIndex((l) => l.includes(s)); assert.ok(i >= 0, `no "${s}" in log`); return i }
const step = async (p: Promise<unknown>) => { try { await p } catch (e) { assert.ok(e instanceof DeployError); return e.step } assert.fail('no error') }

test('happy path blue@1.0.0 → green@1.1.0', async () => {
  const f = setup({ state: blue })
  const s = await release(app, '1.1.0', f.sys, D)
  assert.deepEqual({ ...s, at: undefined }, { slot: 'green', version: '1.1.0', previous: '1.0.0', at: undefined })
  assert.deepEqual(JSON.parse(f.files.get(STATE)!).slot, 'green')
  assert.match(f.files.get(SITE)!, /reverse_proxy 127\.0\.0\.1:4420/)
  assert.equal(f.files.get('/etc/hawk/apps/dodo.json'), JSON.stringify(dodoSpec))
  assert.ok(!f.files.has('/var/lib/hawk-images/dodo-1.1.0.tar'))
  const L = f.log
  const order = ['lock hawk-dodo', 'podman load -i /var/lib/hawk-images/dodo-1.1.0.tar', 'pg_dump', 'podman run --rm',
    'write /etc/containers/systemd/dodo-blue.container', 'podman tag localhost/dodo:1.1.0 localhost/dodo:green', 'systemctl restart dodo-green',
    'get http://127.0.0.1:4420/api/version', `write ${SITE}`, 'systemctl reload caddy', `write ${STATE}`, 'sleep 5000',
    'systemctl stop dodo-blue', 'podman tag localhost/dodo:1.1.0 localhost/dodo:live', 'podman image prune -f', 'unlock hawk-dodo']
  for (let i = 1; i < order.length; i++) assert.ok(at(L, order[i - 1]) < at(L, order[i]), `${order[i - 1]} before ${order[i]}`)
  assert.match(f.files.get('/etc/containers/systemd/dodo-green.container')!, /\[Install\]/)
  assert.doesNotMatch(f.files.get('/etc/containers/systemd/dodo-blue.container')!, /\[Install\]/)
})

test('migrate runs the new image with the shared options', async () => {
  const f = setup({ state: blue })
  await release(app, '1.1.0', f.sys, D)
  const m = f.calls.find((c) => c.args[0] === 'run')!
  const a = m.args.join(' ')
  for (const s of ['--rm', '--network hawk', '--user 990:991', '-v /var/lib/dodo:/data', '--env-file /etc/hawk/db/dodo.env', '--read-only',
    '--cap-drop ALL', '--tmpfs /app/.next/cache', '-e NODE_ENV=production'])
    assert.ok(a.includes(s), `missing ${s}`)
  assert.ok(a.endsWith('localhost/dodo:1.1.0 node dist/migrate.js'), a)
})

test('first deploy: blue, nothing stopped, previous null', async () => {
  const f = setup()
  const s = await release(app, '1.1.0', f.sys, D)
  assert.equal(s.slot, 'blue')
  assert.equal(s.previous, null)
  assert.ok(!f.log.some((l) => l.startsWith('run systemctl stop')))
  assert.match(f.files.get(SITE)!, /127\.0\.0\.1:3420/)
})

test('migrate fails → live slot untouched, site never written', async () => {
  const f = setup({ state: blue, answer: (c) => { if (c.args[0] === 'run') throw new Error('migration 3 failed'); return manifest(c) } })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'migrate')
  assert.ok(!f.log.some((l) => l.includes('systemctl restart dodo-green')))
  assert.ok(!f.files.has(SITE))
  assert.equal(f.files.get(STATE), JSON.stringify(blue))
  assert.ok(f.log.at(-1)!.startsWith('unlock'))
})

test('health never shows the new version → idle stopped, site and state untouched', async () => {
  const f = setup({ state: blue, health: '{"version":"1.0.0"}' })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'health')
  assert.equal(f.log.filter((l) => l.startsWith('get ')).length, 30)
  assert.ok(f.log.includes('run systemctl stop dodo-green'))
  assert.ok(!f.files.has(SITE))
  assert.equal(f.files.get(STATE), JSON.stringify(blue))
})

test('old slot will not stop → state already says green', async () => {
  const f = setup({ state: blue, answer: (c) => { if (c.cmd === 'systemctl' && c.args.join(' ') === 'stop dodo-blue') throw new Error('timeout'); return manifest(c) } })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'stop')
  assert.deepEqual(JSON.parse(f.files.get(STATE)!).slot, 'green')
  assert.equal(JSON.parse(f.files.get(STATE)!).version, '1.1.0')
})

test('busy lock → no other calls', async () => {
  const f = setup({ state: blue })
  const sys = { ...f.sys, lock: () => { throw new Error('busy') } }
  assert.equal(await step(release(app, '1.1.0', sys, D)), 'lock')
  assert.deepEqual(f.log, [])
})

test('downtime: live slot stops before migrate', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, downtime: true } })
  await release(app, '1.1.0', f.sys, D)
  assert.ok(at(f.log, 'systemctl stop dodo-blue') < at(f.log, 'podman run --rm'))
})

test('workers restart on the live image', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, workers: { w: ['node', 'w.js'] } } })
  await release(app, '1.1.0', f.sys, D)
  assert.ok(at(f.log, 'podman tag localhost/dodo:1.1.0 localhost/dodo:live') < at(f.log, 'systemctl restart dodo-w'))
})

test('prune keeps the 3 newest version tags', async () => {
  const f = setup({ state: blue, answer: (c) => (c.args[0] === 'images' ? '1.0.0\n1.10.0\n1.9.0\n1.1.0\nblue\nlive\n0.9.0\n' : manifest(c)) })
  await release(app, '1.1.0', f.sys, D)
  const rmi = f.calls.filter((c) => c.args[0] === 'rmi').map((c) => c.args.at(-1))
  assert.deepEqual(rmi, ['localhost/dodo:1.0.0', 'localhost/dodo:0.9.0'])
})

test('rollback green@1.1.0 → blue@1.0.0', async () => {
  const f = setup()
  f.files.set(STATE, JSON.stringify({ slot: 'green', version: '1.1.0', previous: '1.0.0', at: '' }))
  const sys = { ...f.sys, get: async () => ({ status: 200, body: '{"version":"1.0.0"}' }) }
  const s = await rollback(app, undefined, sys, D)
  assert.deepEqual({ ...s, at: '' }, { slot: 'blue', version: '1.0.0', previous: '1.1.0', at: '' })
  assert.ok(f.log.includes('run podman image exists localhost/dodo:1.0.0'))
  assert.ok(f.log.includes('run podman tag localhost/dodo:1.0.0 localhost/dodo:blue'))
  assert.ok(!f.calls.some((c) => c.args[0] === 'run' || c.args[0] === 'load' || c.args.includes('pg_dump')))
})

test('rollback with no state fails', async () => {
  const f = setup()
  assert.equal(await step(rollback(app, undefined, f.sys, D)), 'state')
})

test('a tar whose manifest names another image is refused before podman load', async () => {
  const f = setup({ state: blue, answer: (c) => (c.cmd === 'tar' ? JSON.stringify([{ RepoTags: ['docker.io/library/postgres:17'] }]) : '') })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'load')
  assert.ok(!f.calls.some((c) => c.args[0] === 'load'))
})

test('old slot will not stop → [Install] already moved to the new slot', async () => {
  const f = setup({ state: blue, answer: (c) => { if (c.cmd === 'systemctl' && c.args.join(' ') === 'stop dodo-blue') throw new Error('timeout'); return manifest(c) } })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'stop')
  assert.match(f.files.get('/etc/containers/systemd/dodo-green.container')!, /\[Install\]/)
  assert.doesNotMatch(f.files.get('/etc/containers/systemd/dodo-blue.container')!, /\[Install\]/)
})

const failMigrate = (c: Call) => { if (c.args[0] === 'run') throw new Error('migration 3 failed'); return manifest(c) }

test('downtime: migrate fails → the old slot and workers start again', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, downtime: true, workers: { w: ['node', 'w.js'] } }, answer: failMigrate })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'migrate')
  assert.ok(at(f.log, 'podman run --rm') < at(f.log, 'systemctl start dodo-blue'))
  assert.ok(f.log.includes('run systemctl start dodo-w'))
})

test('downtime: backup fails → the old slot starts again', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, downtime: true }, answer: (c) => { if (c.args.includes('pg_dump')) throw new Error('disk full'); return manifest(c) } })
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'backup')
  assert.ok(f.log.includes('run systemctl start dodo-blue'))
})

test('migrate fails → spec and unit files keep the old release', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, env: { NEW: '1' } }, answer: failMigrate })
  f.files.set('/etc/hawk/apps/dodo.json', JSON.stringify(dodoSpec))
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'migrate')
  assert.equal(f.files.get('/etc/hawk/apps/dodo.json'), JSON.stringify(dodoSpec))
  assert.ok(!f.log.some((l) => l.startsWith('write /etc/containers/systemd/')))
})

const IMG = '/var/lib/hawk-images/dodo-1.1.0'
for (const [what, file, st] of [
  ['a symlinked json', 'json', { file: false, uid: RUNNER_UID }],
  ['a symlinked tar', 'tar', { file: false, uid: RUNNER_UID }],
  ['a json not owned by hawk-runner', 'json', { file: true, uid: 0 }],
] as const)
  test(`${what} is refused before it is read`, async () => {
    const f = setup({ state: blue }), reads: string[] = []
    const sys = { ...f.sys, lstat: (p: string) => (p === `${IMG}.${file}` ? st : f.sys.lstat(p)), read: (p: string) => { reads.push(p); return f.sys.read(p) } }
    assert.equal(await step(release(app, '1.1.0', sys, D)), 'load')
    assert.ok(!f.calls.some((c) => c.cmd === 'tar' || c.args[0] === 'load'))
    assert.deepEqual(reads.filter((p) => p.startsWith(IMG)), [])
  })

test('a json that does not parse does not show its text in the error', async () => {
  const f = setup({ state: blue })
  f.files.set(`${IMG}.json`, 'root:$6$secret:19000:0:99999:7:::')
  await assert.rejects(release(app, '1.1.0', f.sys, D), (e: Error) => !e.message.includes('root') && /not valid JSON/.test(e.message))
})

test('health fails → spec and unit files go back to the old release', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, env: { NEW: '1' }, workers: { w: ['node', 'w.js'] } }, health: '{"version":"1.0.0"}' })
  const old = new Map([['/etc/hawk/apps/dodo.json', JSON.stringify(dodoSpec)], ...renderUnits(app, 'blue')])
  for (const [p, t] of old) f.files.set(p, t)
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'health')
  for (const [p, t] of old) assert.equal(f.files.get(p), t, p)
  assert.ok(!f.files.has('/etc/containers/systemd/dodo-w.container'))
  assert.equal(f.log.at(-2), 'run systemctl daemon-reload')
})

test('old slot will not stop → new spec and units stay', async () => {
  const f = setup({ state: blue, spec: { ...dodoSpec, env: { NEW: '1' } }, answer: (c) => { if (c.cmd === 'systemctl' && c.args.join(' ') === 'stop dodo-blue') throw new Error('timeout'); return manifest(c) } })
  f.files.set('/etc/hawk/apps/dodo.json', JSON.stringify(dodoSpec))
  assert.equal(await step(release(app, '1.1.0', f.sys, D)), 'stop')
  assert.match(f.files.get('/etc/hawk/apps/dodo.json')!, /NEW/)
  assert.match(f.files.get('/etc/containers/systemd/dodo-green.container')!, /NEW=1/)
})
