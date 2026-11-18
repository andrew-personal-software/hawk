import { HAWK, loadApp, parseSpec, slotPort, VERSION } from './config.ts'
import { ensureDb } from './db.ts'
import { out, readState, writeUnits } from './release.ts'
import type { Sys } from './types.ts'

export const specPath = (app: string) => `/etc/hawk/apps/${app}.json`
export const IMAGES = '/var/lib/hawk-images'

/** Root. User, dirs, DB role, units, runner sudo rule and Caddy site for a podman app. Safe to re-run. */
export async function setup(name: string, checkout: string | undefined, sys: Sys, domain: string): Promise<void> {
  const from = checkout ? `${checkout}/deploy/hawk.json` : specPath(name)
  const text = sys.read(from)
  if (text === null) throw new Error(`no ${from}. Pass a checkout of ${name}: sudo hawk setup ${name} <checkout>`)
  const spec = parseSpec(JSON.parse(text), name)

  out.log(`==> user and dirs: ${name}`)
  try {
    await sys.run('id', ['-u', name])
  } catch {
    await sys.run('useradd', ['--system', '--user-group', '--home-dir', `/var/lib/${name}`, '--no-create-home', '--shell', '/usr/sbin/nologin', name])
  }
  await sys.run('install', ['-d', '-o', name, '-g', name, '-m', '0750', `/var/lib/${name}`, `/var/backups/${name}`])
  sys.write(specPath(name), JSON.stringify(spec), 0o644)

  out.log(`==> postgres: role and schema ${name}`)
  await ensureDb(name, sys)

  const app = await loadApp(name, sys)
  const live = readState(name, sys)?.slot ?? 'blue'
  out.log(`==> units (live slot: ${live})`)
  await writeUnits(app, live, sys)
  await sys.run('systemctl', ['daemon-reload'])
  for (const job of Object.keys(spec.jobs ?? {})) await sys.run('systemctl', ['enable', '--now', `${name}-${job}.timer`])

  out.log('==> sudoers: hawk-runner may run hawk release')
  const sudoers = `/etc/sudoers.d/hawk-${name}`
  const rule = `hawk-runner ALL=(root) NOPASSWD: /usr/local/bin/hawk release ${name} *\n`
  if (sys.read(sudoers) !== rule) {
    sys.write(`${sudoers}.tmp`, rule, 0o440)
    try {
      await sys.run('visudo', ['-cqf', `${sudoers}.tmp`])
    } catch (e) {
      sys.remove(`${sudoers}.tmp`)
      throw e
    }
    await sys.run('mv', [`${sudoers}.tmp`, sudoers])
  }

  await sys.run(`${HAWK}/caddy/setup.sh`, [name, `127.0.0.1:${slotPort(app, live)}`])
  out.log(`Done. ${name} is at https://${name}.${domain}. The first deploy starts it.`)
}

/** Runner, from the tag checkout. Builds the image and hands it to root through /var/lib/hawk-images. */
export async function build(name: string, checkout: string, version: string, sys: Sys): Promise<void> {
  if (!VERSION.test(version)) throw new Error('version must look like 1.2.3')
  const text = sys.read(`${checkout}/deploy/hawk.json`)
  if (text === null) throw new Error(`no deploy/hawk.json in ${checkout}`)
  const spec = parseSpec(JSON.parse(text), name)
  const tag = `localhost/${name}:${version}`
  out.log(`==> build ${tag}`)
  await sys.run('podman', ['build', '--build-arg', `VERSION=${version}`, '-f', `${checkout}/Containerfile`, '-t', tag, checkout])
  await sys.run('podman', ['save', '-o', `${IMAGES}/${name}-${version}.tar`, tag])
  sys.write(`${IMAGES}/${name}-${version}.json`, JSON.stringify(spec), 0o640)
  await sys.run('podman', ['rmi', tag])
}
