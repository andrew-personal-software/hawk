import test from 'node:test'
import assert from 'node:assert/strict'
import { renderUnits } from '../src/quadlet.ts'
import { renderSite } from '../src/caddy.ts'
import type { App } from '../src/types.ts'
import { dodoSpec } from './config.test.ts'

const Q = '/etc/containers/systemd'
const app: App = {
  name: 'dodo', port: 3420, health: '/api/version', uid: 990, gid: 991,
  spec: { ...structuredClone(dodoSpec), workers: { w: ['node', 'worker.js', 'a b'] }, envFiles: ['/etc/dodo/x.env'] },
}

test('unit paths', () =>
  assert.deepEqual([...renderUnits(app, 'blue').keys()].sort(), [
    `${Q}/dodo-blue.container`, `${Q}/dodo-cleanup.container`, `${Q}/dodo-green.container`, `${Q}/dodo-w.container`,
    '/etc/systemd/system/dodo-cleanup.timer'].sort()))

test('slot images and ports', () => {
  const u = renderUnits(app, 'blue')
  assert.match(u.get(`${Q}/dodo-blue.container`)!, /^Image=localhost\/dodo:blue$/m)
  assert.match(u.get(`${Q}/dodo-blue.container`)!, /^PublishPort=127\.0\.0\.1:3420:3000$/m)
  assert.match(u.get(`${Q}/dodo-green.container`)!, /^Image=localhost\/dodo:green$/m)
  assert.match(u.get(`${Q}/dodo-green.container`)!, /^PublishPort=127\.0\.0\.1:4420:3000$/m)
  assert.match(u.get(`${Q}/dodo-w.container`)!, /^Image=localhost\/dodo:live$/m)
  assert.doesNotMatch(u.get(`${Q}/dodo-w.container`)!, /PublishPort/)
})

for (const live of ['blue', 'green'] as const) {
  test(`only the live slot (${live}) has [Install]`, () => {
    const u = renderUnits(app, live)
    const idle = live === 'blue' ? 'green' : 'blue'
    assert.match(u.get(`${Q}/dodo-${live}.container`)!, /\[Install\]\nWantedBy=multi-user\.target/)
    assert.doesNotMatch(u.get(`${Q}/dodo-${idle}.container`)!, /\[Install\]|WantedBy/)
    assert.match(u.get(`${Q}/dodo-w.container`)!, /\[Install\]\nWantedBy=multi-user\.target/)
  })
}

test('job and timer', () => {
  const u = renderUnits(app, 'blue')
  const job = u.get(`${Q}/dodo-cleanup.container`)!
  assert.match(job, /^Restart=no$/m)
  assert.doesNotMatch(job, /\[Install\]/)
  assert.match(job, /^Image=localhost\/dodo:live$/m)
  const timer = u.get('/etc/systemd/system/dodo-cleanup.timer')!
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00$/m)
  assert.match(timer, /^Persistent=true$/m)
  assert.match(timer, /^Unit=dodo-cleanup\.service$/m)
})

test('every container has the shared options', () => {
  for (const [path, text] of renderUnits(app, 'blue')) {
    if (!path.endsWith('.container')) continue
    for (const line of ['OnFailure=hawk-notify@%N.service', 'SuccessExitStatus=143', 'TimeoutStopSec=20', 'User=990:991',
      'Network=hawk.network', 'Volume=/var/lib/dodo:/data', 'EnvironmentFile=/etc/hawk/db/dodo.env', 'Environment=PORT=3000',
      'ReadOnly=true', 'Tmpfs=/tmp', 'DropCapability=ALL', 'NoNewPrivileges=true', 'EnvironmentFile=/etc/dodo/x.env',
      'Environment=NODE_ENV=production', 'Environment=DODO_FILES=/data/files', 'Tmpfs=/app/.next/cache'])
      assert.ok(text.split('\n').includes(line), `${path} is missing ${line}`)
    assert.match(text, /^ContainerName=dodo-(blue|green|w|cleanup)$/m)
  }
})

test('Exec quotes arguments with spaces', () =>
  assert.match(renderUnits(app, 'blue').get(`${Q}/dodo-w.container`)!, /^Exec=node worker\.js "a b"$/m))

test('renderSite', () =>
  assert.equal(renderSite('dodo', 'andrewminghanjiang.com', 4420), 'dodo.andrewminghanjiang.com {\n\timport tailnet\n\treverse_proxy 127.0.0.1:4420\n}'))

test('quote refuses control characters', async () => {
  const { quote } = await import('../src/quadlet.ts')
  assert.throws(() => quote('a\nb'), /control/)
})

test('notify mounts the notify socket dir read-only', async () => {
  const { containerLines } = await import('../src/quadlet.ts')
  const { runFlags } = await import('../src/release.ts')
  const on: App = { ...app, spec: { notify: true } }
  const off: App = { ...app, spec: {} }
  assert.ok(containerLines(on).includes('Volume=/run/hawk-notify:/run/hawk-notify:ro'))
  assert.ok(runFlags(on).join(' ').includes('-v /run/hawk-notify:/run/hawk-notify:ro'))
  assert.ok(!containerLines(off).join('\n').includes('hawk-notify'))
  assert.ok(!runFlags(off).join(' ').includes('hawk-notify'))
})
