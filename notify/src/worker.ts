import type { Core, Env, Platform, Result } from './core.ts'
import type { Alert } from './alert.ts'
import { getState, getThread, saveState, saveThread, markFailed, markRetry, markSent, nextDelivery, oldestQueued, queuedCount } from './db.ts'
import type { Db, DeliveryRow, PlatformState } from './db.ts'

export type WorkerDeps = {
  db: Db; platform: Platform; env: Env; now: () => number
  alert: Alert; defaultTarget: string | undefined; log: (line: string) => void
}

const PROBE = 60_000
const OUTAGE = 300_000
const ALERT_QUIET = 3_600_000
const BACKOFF = [5, 15, 30, 60, 60].map((s) => s * 1000)

const iso = (ms: number | null) => new Date(ms ?? 0).toISOString()
const why = (r: Result) => ('error' in r ? r.error : r.kind)

type Prev = Pick<PlatformState, 'status' | 'reason'>

function save(d: WorkerDeps, prev: Prev, s: PlatformState): void {
  if (s.status !== prev.status || s.reason !== prev.reason) d.log(`notify: ${d.platform.name} ${s.status === 'up' ? 'up' : `down: ${s.reason}`}`)
  saveState(d.db, s)
}

async function maybeAlert(d: WorkerDeps, s: PlatformState, now: number): Promise<void> {
  if (s.status !== 'down') return
  if (s.alertSentAt !== null && (s.alertSentAt >= (s.downSince ?? 0) || now - s.alertSentAt < ALERT_QUIET)) return
  const L = d.platform.label
  const n = queuedCount(d.db, d.platform.name)
  const ok = s.reason === 'no_token'
    ? await d.alert(`hawk: ${L} is not set up`,
      `The ${L} token is not set in /etc/hawk/hawk.env.\nQueued: ${n} messages. They will be sent once it is set and hawk-notifyd restarts.`)
    : await d.alert(`hawk: ${L} is down`,
      `${L} is down since ${iso(s.downSince)}.\nReason: ${s.reason}\nQueued: ${n} messages. They will be sent when ${L} is back.`)
  if (ok) {
    s.alertSentAt = now
    saveState(d.db, s)
  }
}

async function notice(d: WorkerDeps, core: Core): Promise<void> {
  if (!d.defaultTarget) return
  const r = await d.platform.send(core, d.defaultTarget, d.env)
  if (r.kind !== 'ok') d.log(`notify: ${d.platform.name} notice to ${d.defaultTarget} failed: ${why(r)}`)
}

async function deliver(d: WorkerDeps, s: PlatformState, row: DeliveryRow, now: number): Promise<void> {
  const prev: Prev = { status: s.status, reason: s.reason }
  const wasDown = prev.status === 'down'
  // A send result after no_token is a new outage with a real reason, so it may alert again.
  const afterNoToken = wasDown && s.reason === 'no_token'
  const n = wasDown ? queuedCount(d.db, d.platform.name) : 0
  const key = row.core.thread
  const thread = key ? getThread(d.db, key, d.platform.name, row.target) : undefined
  const r = await d.platform.send(row.core, row.target, d.env, thread)
  switch (r.kind) {
    case 'ok': {
      markSent(d.db, row.id, now, r.ref)
      if (key && !thread && r.ref) saveThread(d.db, key, d.platform.name, row.target, r.ref)
      const downSince = s.downSince
      s.failingSince = null
      if (wasDown) Object.assign(s, { status: 'up', reason: null, downSince: null, nextProbeAt: null })
      save(d, prev, s)
      if (wasDown) {
        const title = `${d.platform.label} was unreachable from ${iso(downSince)} to ${iso(now)}. ${n} messages were delayed.`
        await notice(d, { topic: 'hawk.notify', level: 'info', title })
      }
      return
    }
    case 'retry_after':
      s.pausedUntil = now + r.seconds * 1000
      s.failingSince = null
      break
    case 'transient':
      markRetry(d.db, row.id, now + BACKOFF[Math.min(row.attempts, 4)], r.error)
      s.failingSince ??= now
      if (s.status === 'up' && now - s.failingSince >= OUTAGE) Object.assign(s, { status: 'down', reason: r.error, downSince: now })
      if (afterNoToken) Object.assign(s, { reason: r.error, downSince: now })
      if (s.status === 'down') s.nextProbeAt = now + PROBE
      break
    case 'auth':
      markRetry(d.db, row.id, now, r.error)
      s.status = 'down'
      s.reason = r.error
      s.downSince = afterNoToken ? now : (s.downSince ?? now)
      s.nextProbeAt = now + PROBE
      break
    case 'permanent':
      markFailed(d.db, row.id, r.error)
      s.failingSince = null
      save(d, prev, s)
      d.log(`notify: ${d.platform.name} ${row.target} failed: ${r.error}`)
      if (row.target !== d.defaultTarget) {
        await notice(d, { topic: 'hawk.notify', level: 'warn', title: `could not post ${row.core.topic} to ${row.target}: ${r.error}` })
      }
      return
  }
  save(d, prev, s)
}

/** One step of a platform's worker. Returns the ms to wait before the next step. */
export async function tick(d: WorkerDeps): Promise<number> {
  const now = d.now()
  const s = getState(d.db, d.platform.name)
  if (!d.platform.configured(d.env)) {
    if (s.status !== 'down' || s.reason !== 'no_token') {
      const prev: Prev = { status: s.status, reason: s.reason }
      Object.assign(s, { status: 'down', reason: 'no_token', downSince: now })
      save(d, prev, s)
    }
    await maybeAlert(d, s, now)
    return PROBE
  }
  if (s.pausedUntil !== null && s.pausedUntil > now) return s.pausedUntil - now
  await maybeAlert(d, s, now)
  let row: DeliveryRow | null
  if (s.status === 'down') {
    if (s.nextProbeAt !== null && s.nextProbeAt > now) return s.nextProbeAt - now
    row = oldestQueued(d.db, d.platform.name)
    if (!row) {
      s.nextProbeAt = now + PROBE
      saveState(d.db, s)
      return PROBE
    }
  } else {
    row = nextDelivery(d.db, d.platform.name, now)
    if (!row) return 1000
  }
  await deliver(d, s, row, now)
  return 0
}

/** Runs `tick` in a loop until `stop()`, which cancels the current sleep and waits for the running tick. */
export function startWorker(d: WorkerDeps): { stop(): Promise<void> } {
  let running = true
  let wake = () => {}
  const loop = (async () => {
    while (running) {
      let ms: number
      try {
        ms = Math.min(await tick(d), PROBE)
      } catch (e) {
        d.log(`notify: ${d.platform.name} worker error: ${String(e)}`)
        ms = 5000
      }
      if (!running) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        wake = () => { clearTimeout(t); resolve() }
      })
    }
  })()
  return {
    async stop() {
      running = false
      wake()
      await loop
    },
  }
}
