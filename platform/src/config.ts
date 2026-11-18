import type { App, AppSpec, Slot, Sys } from './types.ts'

export const HAWK = process.env.HAWK ?? '/opt/hawk'
export const NAME = /^[a-z][a-z0-9-]{0,20}$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/
const RESERVED = new Set(['DATABASE_URL', 'PORT'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function fail(path: string, why: string): never { throw new Error(`${path}: ${why}`) }

function command(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string' && s !== '')) fail(path, 'must be a non-empty list of strings')
  return v
}

function record<T>(v: unknown, path: string, each: (v: unknown, path: string) => T): Record<string, T> {
  if (!isObj(v)) fail(path, 'must be an object')
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!NAME.test(k)) fail(`${path}.${k}`, `name must match ${NAME}`)
    out[k] = each(x, `${path}.${k}`)
  }
  return out
}

/** Checks deploy/hawk.json. Errors name the field path. */
export function parseSpec(json: unknown, app: string): AppSpec {
  if (!isObj(json)) fail('spec', 'must be an object')
  const spec: AppSpec = {}
  for (const [k, v] of Object.entries(json)) {
    switch (k) {
      case 'web':
        if (!isObj(v)) fail('web', 'must be an object')
        spec.web = { command: command(v.command, 'web.command') }
        break
      case 'workers':
        spec.workers = record(v, 'workers', command)
        break
      case 'jobs':
        spec.jobs = record(v, 'jobs', (j, p) => {
          if (!isObj(j)) fail(p, 'must be an object')
          if (typeof j.schedule !== 'string' || !j.schedule.trim()) fail(`${p}.schedule`, 'must be a systemd OnCalendar value')
          return { command: command(j.command, `${p}.command`), schedule: j.schedule }
        })
        break
      case 'migrate':
        spec.migrate = command(v, 'migrate')
        break
      case 'env': {
        if (!isObj(v)) fail('env', 'must be an object')
        const env: Record<string, string> = {}
        for (const [ek, ev] of Object.entries(v)) {
          if (!ENV_KEY.test(ek)) fail(`env.${ek}`, `key must match ${ENV_KEY}`)
          if (RESERVED.has(ek)) fail(`env.${ek}`, 'is set by hawk')
          if (typeof ev !== 'string' || /\n/.test(ev)) fail(`env.${ek}`, 'must be a one-line string')
          env[ek] = ev
        }
        spec.env = env
        break
      }
      case 'envFiles':
        if (!Array.isArray(v)) fail('envFiles', 'must be a list')
        spec.envFiles = v.map((f, i) => {
          if (typeof f !== 'string' || !f.startsWith(`/etc/${app}/`) || f.includes('..')) fail(`envFiles[${i}]`, `must be a file under /etc/${app}/`)
          return f
        })
        break
      case 'tmpfs':
        if (!Array.isArray(v)) fail('tmpfs', 'must be a list')
        spec.tmpfs = v.map((t, i) => {
          if (typeof t !== 'string' || !/^\/[\w./-]*$/.test(t)) fail(`tmpfs[${i}]`, 'must be an absolute path')
          return t
        })
        break
      case 'downtime':
        if (typeof v !== 'boolean') fail('downtime', 'must be true or false')
        spec.downtime = v
        break
      default:
        fail(k, 'unknown field')
    }
  }
  const seen = new Set(['blue', 'green', 'live'])
  for (const [kind, names] of [['workers', spec.workers], ['jobs', spec.jobs]] as const)
    for (const n of Object.keys(names ?? {})) {
      if (seen.has(n)) fail(`${kind}.${n}`, 'name is used by another unit of this app')
      seen.add(n)
    }
  return spec
}

/** Reads apps/<app>.env (shell KEY=value lines). */
export function parseAppEnv(text: string): { port: number; health: string; runtime: 'systemd' | 'podman' } {
  const v: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) v[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  const port = Number(v.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 64535) fail('PORT', 'must be a port number')
  if (!v.HEALTH?.startsWith('/')) fail('HEALTH', 'must be a path')
  if (v.RUNTIME && v.RUNTIME !== 'podman' && v.RUNTIME !== 'systemd') fail('RUNTIME', 'must be podman or systemd')
  return { port, health: v.HEALTH, runtime: v.RUNTIME === 'podman' ? 'podman' : 'systemd' }
}

export const slotPort = (app: App, slot: Slot): number => (slot === 'blue' ? app.port : app.port + 1000)

export async function loadApp(name: string, sys: Sys, specPath = `/etc/hawk/apps/${name}.json`): Promise<App> {
  if (!NAME.test(name)) fail('app', `name must match ${NAME}`)
  const env = sys.read(`${HAWK}/apps/${name}.env`)
  if (env === null) fail('app', `unknown app '${name}'`)
  const { port, health } = parseAppEnv(env)
  const text = sys.read(specPath)
  const spec = text === null ? {} : parseSpec(JSON.parse(text), name)
  const uid = Number((await sys.run('id', ['-u', name])).trim())
  const gid = Number((await sys.run('id', ['-g', name])).trim())
  return { name, port, health, uid, gid, spec }
}
