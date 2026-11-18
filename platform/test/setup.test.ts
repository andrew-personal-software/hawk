import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { build, setup } from '../src/setup.ts'
import { HAWK } from '../src/config.ts'
import { out } from '../src/release.ts'
import { dodoSpec } from './config.test.ts'
import { fakeSys } from './fake.ts'

out.log = () => {}
const D = 'andrewminghanjiang.com'

function box(spec: unknown = dodoSpec) {
  const f = fakeSys({ answer: (c) => (c.cmd === 'id' ? '990\n' : '') })
  f.files.set(`${HAWK}/apps/dodo.env`, 'PORT=3420\nHEALTH=/api/version\nRUNTIME=podman\n')
  f.files.set('/src/dodo/deploy/hawk.json', JSON.stringify(spec))
  return f
}

test('setup writes the one release sudoers rule', async () => {
  const f = box()
  await setup('dodo', '/src/dodo', f.sys, D)
  const tmp = [...f.files.keys()].find((k) => k.startsWith('/etc/sudoers.d/hawk-dodo'))!
  assert.equal(f.files.get(tmp), 'hawk-runner ALL=(root) NOPASSWD: /usr/local/bin/hawk release dodo *\n')
  assert.ok(f.calls.some((c) => c.cmd === 'visudo' && c.args.join(' ') === `-cqf ${tmp}`))
  assert.ok(f.calls.some((c) => c.cmd === 'mv' && c.args[1] === '/etc/sudoers.d/hawk-dodo'))
})

test('setup with no state writes units for blue and points caddy at blue', async () => {
  const f = box()
  await setup('dodo', '/src/dodo', f.sys, D)
  assert.match(f.files.get('/etc/containers/systemd/dodo-blue.container')!, /\[Install\]/)
  assert.doesNotMatch(f.files.get('/etc/containers/systemd/dodo-green.container')!, /\[Install\]/)
  assert.equal(f.files.get('/etc/hawk/apps/dodo.json'), JSON.stringify(dodoSpec))
  assert.ok(f.calls.some((c) => c.cmd === `${HAWK}/caddy/setup.sh` && c.args.join(' ') === 'dodo 127.0.0.1:3420'))
  assert.ok(f.calls.some((c) => c.cmd === 'systemctl' && c.args.join(' ') === 'enable --now dodo-cleanup.timer'))
})

test('setup with a bad hawk.json throws before any write or command', async () => {
  const f = box({ web: { command: [] } })
  await assert.rejects(setup('dodo', '/src/dodo', f.sys, D), /web\.command/)
  assert.deepEqual(f.log.filter((l) => !l.startsWith('get')), [])
})

test('setup with no checkout uses the stored spec', async () => {
  const f = box()
  f.files.set('/etc/hawk/apps/dodo.json', JSON.stringify({ web: dodoSpec.web }))
  await setup('dodo', undefined, f.sys, D)
  assert.ok(!f.files.has('/etc/containers/systemd/dodo-cleanup.container'))
})

const main = (...args: string[]) => {
  try {
    return { code: 0, out: execFileSync('node', ['platform/src/main.ts', ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { status: number; stderr: string }
    return { code: err.status, out: err.stderr }
  }
}
test('main release with a bad version', () => assert.deepEqual(main('release', 'dodo', '1.2'), { code: 1, out: 'error: version must look like 1.2.3\n' }))
test('main with an unknown command', () => assert.equal(main('nope').code, 1))

test('setup takes the app lock, so it cannot race a release', async () => {
  const f = box()
  const sys = { ...f.sys, lock: () => { throw new Error('busy') } }
  await assert.rejects(setup('dodo', '/src/dodo', sys, D), /busy/)
  assert.ok(!f.files.has('/etc/containers/systemd/dodo-blue.container'))
  assert.ok(!f.calls.some((c) => c.cmd.endsWith('caddy/setup.sh')))
})

test('build removes tars left by older failed releases of this app', async () => {
  const f = box()
  for (const p of ['dodo-1.0.0.tar', 'dodo-1.0.0.json', 'dodo-0.9.0.tar', 'spire-1.0.0.tar']) f.files.set(`/var/lib/hawk-images/${p}`, '')
  await build('dodo', '/src/dodo', '1.1.0', f.sys)
  assert.deepEqual(f.sys.list('/var/lib/hawk-images').sort(), ['dodo-1.1.0.json', 'spire-1.0.0.tar'])
  assert.ok(f.log.indexOf('remove /var/lib/hawk-images/dodo-1.0.0.tar') < f.log.findIndex((l) => l.includes('podman save')))
})

test('build prunes podman storage older than a week, also when the build fails', async () => {
  for (const fail of [false, true]) {
    const f = fakeSys({ answer: (c) => { if (fail && c.args[0] === 'build') throw new Error('build failed'); return '' } })
    f.files.set('/src/dodo/deploy/hawk.json', JSON.stringify(dodoSpec))
    await build('dodo', '/src/dodo', '1.1.0', f.sys).catch(() => {})
    assert.deepEqual(f.calls.at(-1)!.args, ['system', 'prune', '-f', '--filter', 'until=168h'])
  }
})
