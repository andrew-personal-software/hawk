import { backupApp } from './backup.ts'
import { renderSite } from './caddy.ts'
import { parseSpec, slotPort } from './config.ts'
import { dbEnvPath } from './db.ts'
import { renderUnits } from './quadlet.ts'
import type { App, AppState, Slot, Sys } from './types.ts'

export class DeployError extends Error {
  step: string
  constructor(step: string, message: string) {
    super(`${step}: ${message}`)
    this.step = step
  }
}

export const out = { log: (s: string) => console.log(s) }
export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/
export const statePath = (app: string) => `/var/lib/hawk/apps/${app}.json`
const IMAGES = '/var/lib/hawk-images'
const other = (s: Slot): Slot => (s === 'blue' ? 'green' : 'blue')
const image = (app: App, tag: string) => `localhost/${app.name}:${tag}`

async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  out.log(`==> ${name}`)
  try {
    return await fn()
  } catch (e) {
    if (e instanceof DeployError) throw e
    throw new DeployError(name, e instanceof Error ? e.message : String(e))
  }
}

export function readState(app: string, sys: Sys): AppState | null {
  const text = sys.read(statePath(app))
  return text ? (JSON.parse(text) as AppState) : null
}

/** Writes the app's units for this live slot. Reloads systemd and enables new timers when any changed. */
export async function writeUnits(app: App, live: Slot, sys: Sys): Promise<void> {
  let changed = false
  for (const [path, text] of renderUnits(app, live)) changed = sys.write(path, text) || changed
  if (!changed) return
  await sys.run('systemctl', ['daemon-reload'])
  for (const job of Object.keys(app.spec.jobs ?? {})) await sys.run('systemctl', ['enable', '--now', `${app.name}-${job}.timer`])
}

/** podman run flags matching the Quadlet units, for one-off containers. */
export function runFlags(app: App): string[] {
  const s = app.spec
  return [
    '--rm', '--network', 'hawk', '--user', `${app.uid}:${app.gid}`, '-v', `/var/lib/${app.name}:/data`,
    '--env-file', dbEnvPath(app.name), ...(s.envFiles ?? []).flatMap((f) => ['--env-file', f]),
    '-e', 'PORT=3000', ...Object.entries(s.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '--read-only', '--tmpfs', '/tmp', ...(s.tmpfs ?? []).flatMap((t) => ['--tmpfs', t]),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  ]
}

async function healthy(app: App, slot: Slot, version: string, sys: Sys): Promise<boolean> {
  const url = `http://127.0.0.1:${slotPort(app, slot)}${app.health}`
  for (let i = 0; i < 30; i++) {
    if (i > 0) await sys.sleep(1000)
    const r = await sys.get(url)
    try { if (r.status === 200 && JSON.parse(r.body).version === version) return true } catch {}
  }
  return false
}

/** Starts `version` on the idle slot, moves traffic to it, stops the old one. Shared by release and rollback. */
async function cutover(app: App, version: string, prev: AppState | null, sys: Sys, domain: string): Promise<AppState> {
  const old = prev?.slot ?? null
  const next: Slot = old ? other(old) : 'blue'
  const state: AppState = { slot: app.spec.web ? next : (old ?? 'blue'), version, previous: prev?.version ?? null, at: sys.now().toISOString() }
  if (app.spec.web) {
    await step('start', async () => {
      await sys.run('podman', ['tag', image(app, version), image(app, next)])
      await sys.run('systemctl', ['restart', `${app.name}-${next}`])
    })
    await step('health', async () => {
      if (await healthy(app, next, version, sys)) return
      await sys.run('systemctl', ['stop', `${app.name}-${next}`])
      throw new Error(`${app.health} on the ${next} slot did not answer version ${version} in 30 s. See journalctl -u ${app.name}-${next}`)
    })
    await step('switch', async () => {
      const site = `/etc/caddy/sites/${app.name}.caddy`
      const before = sys.read(site)
      sys.write(site, `${renderSite(app.name, domain, slotPort(app, next))}\n`)
      try {
        await sys.run('systemctl', ['reload', 'caddy'])
      } catch (e) {
        if (before !== null) sys.write(site, before)
        await sys.run('systemctl', ['stop', `${app.name}-${next}`]).catch(() => {})
        throw e
      }
    })
  }
  await step('state', () => sys.write(statePath(app.name), `${JSON.stringify(state)}\n`))
  if (app.spec.web && old) {
    await step('drain', () => sys.sleep(5000))
    await step('stop', () => sys.run('systemctl', ['stop', `${app.name}-${old}`]))
  }
  await step('live', async () => {
    await sys.run('podman', ['tag', image(app, version), image(app, 'live')])
    for (const w of Object.keys(app.spec.workers ?? {})) await sys.run('systemctl', ['restart', `${app.name}-${w}`])
  })
  await step('units', () => writeUnits(app, state.slot, sys))
  await step('prune', async () => {
    const tags = (await sys.run('podman', ['images', '--format', '{{.Tag}}', `localhost/${app.name}`])).split('\n').filter((t) => VERSION.test(t))
    const byNewest = [...new Set(tags)].sort((a, b) => cmpVersion(b, a))
    for (const t of byNewest.slice(3)) if (t !== version) await sys.run('podman', ['rmi', image(app, t)])
    await sys.run('podman', ['image', 'prune', '-f'])
  })
  return state
}

const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

async function locked<T>(app: App, sys: Sys, fn: () => Promise<T>): Promise<T> {
  const unlock = await step('lock', () => sys.lock(`hawk-${app.name}`))
  try { return await fn() } finally { unlock() }
}

/** Deploys a built image (from /var/lib/hawk-images) with no downtime. See README "Deploy flow". */
export async function release(app: App, version: string, sys: Sys, domain: string): Promise<AppState> {
  if (!VERSION.test(version)) throw new DeployError('version', 'version must look like 1.2.3')
  return locked(app, sys, async () => {
    const prev = readState(app.name, sys)
    const tar = `${IMAGES}/${app.name}-${version}.tar`, json = `${IMAGES}/${app.name}-${version}.json`
    app = await step('load', async () => {
      const text = sys.read(json)
      if (text === null) throw new Error(`no ${json}. Run hawk build first`)
      const spec = parseSpec(JSON.parse(text), app.name)
      sys.write(`/etc/hawk/apps/${app.name}.json`, `${JSON.stringify(spec)}`, 0o644)
      await sys.run('podman', ['load', '-i', tar])
      sys.remove(tar)
      sys.remove(json)
      return { ...app, spec }
    })
    await step('units', () => writeUnits(app, prev?.slot ?? 'blue', sys))
    if (app.spec.downtime && prev)
      await step('downtime', async () => {
        if (app.spec.web) await sys.run('systemctl', ['stop', `${app.name}-${prev.slot}`])
        for (const w of Object.keys(app.spec.workers ?? {})) await sys.run('systemctl', ['stop', `${app.name}-${w}`])
      })
    await step('backup', () => backupApp(app, sys, { prune: false }))
    const migrate = app.spec.migrate
    if (migrate) await step('migrate', () => sys.run('podman', ['run', ...runFlags(app), image(app, version), ...migrate]))
    return cutover(app, version, prev, sys, domain)
  })
}

/** Moves traffic back to an older image (default: the previous release). Does not touch the DB. */
export async function rollback(app: App, version: string | undefined, sys: Sys, domain: string): Promise<AppState> {
  return locked(app, sys, async () => {
    const prev = await step('state', () => {
      const s = readState(app.name, sys)
      if (!s) throw new Error(`${app.name} has no deploy yet`)
      return s
    })
    const to = version ?? prev.previous
    if (!to || !VERSION.test(to)) throw new DeployError('version', `no release to roll back to (give one: hawk rollback ${app.name} 1.2.3)`)
    await step('image', () => sys.run('podman', ['image', 'exists', image(app, to)]))
    out.log(`${prev.version} -> ${to}`)
    out.log(`If a migration changed the DB, restore a backup from /var/backups/${app.name} first (pg_restore -n ${app.name} --clean).`)
    return cutover(app, to, prev, sys, domain)
  })
}
