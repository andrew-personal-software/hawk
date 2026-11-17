import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import routes from '../routes.ts'
import { openDb, prune } from './db.ts'
import { createServer } from './server.ts'
import { startWorker } from './worker.ts'
import { makeAlert } from './alert.ts'
import { platforms } from './platforms/index.ts'

function readVersion(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../../COMMIT', import.meta.url)), 'utf8').trim() || 'dev'
  } catch {
    return 'dev'
  }
}

function main(): void {
  const port = Number(process.env.NOTIFY_PORT ?? 3402)
  const dbPath = process.env.NOTIFY_DB ?? path.join(process.env.STATE_DIRECTORY ?? '.', 'notify.db')
  const log = (line: string) => console.log(line)
  const db = openDb(dbPath)
  const alert = makeAlert(process.env)
  const targeted = new Set([routes.default, ...Object.values(routes.routes)].flatMap((t) => Object.keys(t)))
  const active = platforms.filter((p) => targeted.has(p.name))
  const workers = active.map((platform) =>
    startWorker({ db, platform, env: process.env, now: Date.now, alert, defaultTarget: (routes.default as Record<string, string>)[platform.name], log }))
  const server = createServer({ db, routes, known: new Set(platforms.map((p) => p.name)), now: Date.now, version: readVersion(), log })

  prune(db, Date.now())
  const timer = setInterval(() => prune(db, Date.now()), 86_400_000)
  server.listen(port, '127.0.0.1', () => log(`notify: listening on 127.0.0.1:${port}`))

  const shutdown = async () => {
    clearInterval(timer)
    server.close()
    server.closeAllConnections()
    await Promise.all(workers.map((w) => w.stop()))
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main()
