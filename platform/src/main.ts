// hawk's podman side. bin/hawk calls it; see `hawk` help for the commands.
import { HAWK, loadApp, NAME, parseAppEnv, VERSION } from './config.ts'
import { backupApp } from './backup.ts'
import { readState, release, rollback } from './release.ts'
import { build, setup } from './setup.ts'
import { realSys as sys } from './sys.ts'
import { commitSubjects, linkTasks, taskKeys } from './tasks.ts'

const DOMAIN = process.env.DOMAIN ?? 'andrewminghanjiang.com'
const NOTIFY = 'http://127.0.0.1:3402/v1/messages'

class Usage extends Error {}
function app(name: string | undefined): string {
  if (!name || !NAME.test(name)) throw new Usage('give an app name')
  return name
}
function version(v: string | undefined): string {
  if (!v || !VERSION.test(v)) throw new Usage('version must look like 1.2.3')
  return v
}
const warn = (title: string, body: string) =>
  sys.post(NOTIFY, { topic: 'hawk.tasks', title: title.slice(0, 150), body, level: 'warn' })

function podmanApps(): string[] {
  return sys.list(`${HAWK}/apps`).filter((f) => f.endsWith('.env'))
    .map((f) => f.slice(0, -4))
    .filter((a) => parseAppEnv(sys.read(`${HAWK}/apps/${a}.env`) ?? '').runtime === 'podman')
}

async function tasks(name: string, v: string, result: string | undefined, error: string | undefined) {
  if (result !== 'ok' && result !== 'failed') throw new Usage('tasks <app> <version> ok|failed [error]')
  const keys = taskKeys(await commitSubjects(v, sys))
  if (keys.length === 0) return console.log('no task keys in this release')
  const url = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? `andrew-personal-software/${name}`}/releases/tag/v${v}`
  try {
    const r = await linkTasks({ keys, app: name, version: v, url, ok: result === 'ok', error }, sys)
    console.log(`updated: ${r.updated.join(' ') || 'none'}`)
    if (r.unknown.length) {
      console.log(`unknown: ${r.unknown.join(' ')}`)
      await warn(`${name} ${v}: sparrow does not know ${r.unknown.join(', ')}`, 'PR titles named tasks that do not exist.')
    }
  } catch (e) {
    // The deploy itself is done; a sparrow outage must not mark it failed.
    console.error(`warning: ${(e as Error).message}`)
    await warn(`${name} ${v}: could not update tasks`, (e as Error).message)
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, a, b, c, ...rest] = argv
  switch (cmd) {
    case 'setup': return setup(app(a), b, sys, DOMAIN)
    case 'build': {
      const checkout = (await sys.run('git', ['rev-parse', '--show-toplevel'])).trim()
      return build(app(a), checkout, version(process.env.VERSION), sys)
    }
    case 'release': {
      const v = version(b)
      if (c !== undefined) throw new Usage('release <app> <version>')
      const s = await release(await loadApp(app(a), sys), v, sys, DOMAIN)
      return console.log(`deployed ${a} ${s.version} on ${s.slot}`)
    }
    case 'rollback': {
      const s = await rollback(await loadApp(app(a), sys), b === undefined ? undefined : version(b), sys, DOMAIN)
      return console.log(`rolled back ${a} to ${s.version} on ${s.slot}`)
    }
    case 'tasks': return tasks(app(a), version(b), c, rest.join(' ') || undefined)
    case 'backup': {
      let failed = 0
      for (const name of a ? [app(a)] : podmanApps()) {
        try {
          console.log((await backupApp(await loadApp(name, sys), sys, { prune: true })).join('\n'))
        } catch (e) {
          failed++
          console.error(`error: backup ${name}: ${(e as Error).message}`)
        }
      }
      if (failed) process.exitCode = 1
      return
    }
    case 'state': return console.log(JSON.stringify(readState(app(a), sys) ?? {}))
    default: throw new Usage('commands: setup build release rollback tasks backup state')
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
