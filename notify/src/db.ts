import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import type { Core, DeliveryView, MessageView, Status } from './core.ts'
import type { Targets } from './route.ts'

export type Db = DatabaseSync
export type DeliveryRow = { id: number; messageId: string; platform: string; target: string; attempts: number; core: Core }
export type PlatformState = {
  platform: string; status: 'up' | 'down'; reason: string | null; failingSince: number | null
  downSince: number | null; nextProbeAt: number | null; alertSentAt: number | null; pausedUntil: number | null
}

const DAY = 86_400_000

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, created INTEGER NOT NULL, api_version TEXT NOT NULL,
      topic TEXT NOT NULL, key TEXT UNIQUE, thread TEXT, core TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, platform TEXT NOT NULL,
      target TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, error TEXT, sent_at INTEGER, ref TEXT
    );
    CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries (platform, status, id);
    CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id);
    CREATE TABLE IF NOT EXISTS platform_state (
      platform TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, failing_since INTEGER,
      down_since INTEGER, next_probe_at INTEGER, alert_sent_at INTEGER, paused_until INTEGER
    );
  `)
  return db
}

function newId(now: number): string {
  return 'msg_' + now.toString(36).padStart(9, '0') + randomBytes(4).toString('hex')
}

export function insertMessage(db: Db, core: Core, apiVersion: string, targets: Targets, now: number): { id: string; created: boolean } {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (core.key) {
      const hit = db.prepare('SELECT id FROM messages WHERE key = ?').get(core.key)
      if (hit) {
        db.exec('COMMIT')
        return { id: hit.id as string, created: false }
      }
    }
    const id = newId(now)
    db.prepare('INSERT INTO messages (id, created, api_version, topic, key, thread, core) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, now, apiVersion, core.topic, core.key ?? null, core.thread ?? null, JSON.stringify(core))
    const ins = db.prepare("INSERT INTO deliveries (message_id, platform, target, status, attempts, next_at) VALUES (?, ?, ?, 'queued', 0, ?)")
    for (const [platform, target] of Object.entries(targets)) ins.run(id, platform, target, now)
    db.exec('COMMIT')
    return { id, created: true }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function rollup(deliveries: DeliveryView[]): Status {
  if (deliveries.every((d) => d.status === 'sent')) return 'sent'
  if (deliveries.some((d) => d.status === 'queued')) return 'queued'
  return 'failed'
}

export function getMessage(db: Db, id: string): MessageView | null {
  const m = db.prepare('SELECT id, topic, created, api_version, core FROM messages WHERE id = ?').get(id)
  if (!m) return null
  const deliveries = db.prepare('SELECT platform, target, status, attempts, error, sent_at FROM deliveries WHERE message_id = ? ORDER BY id')
    .all(id).map((r): DeliveryView => ({
      platform: r.platform as string, target: r.target as string, status: r.status as Status,
      attempts: r.attempts as number, error: r.error as string | null, sentAt: r.sent_at as number | null,
    }))
  return {
    id: m.id as string, topic: m.topic as string, created: m.created as number, apiVersion: m.api_version as string,
    core: JSON.parse(m.core as string) as Core, status: rollup(deliveries), deliveries,
  }
}

const DELIVERY_SELECT = `SELECT d.id, d.message_id, d.platform, d.target, d.attempts, m.core
  FROM deliveries d JOIN messages m ON m.id = d.message_id
  WHERE d.platform = ? AND d.status = 'queued'`

function toRow(r: Record<string, unknown> | undefined): DeliveryRow | null {
  if (!r) return null
  return {
    id: r.id as number, messageId: r.message_id as string, platform: r.platform as string,
    target: r.target as string, attempts: r.attempts as number, core: JSON.parse(r.core as string) as Core,
  }
}

export function nextDelivery(db: Db, platform: string, now: number): DeliveryRow | null {
  return toRow(db.prepare(DELIVERY_SELECT + ' AND d.next_at <= ? ORDER BY d.id LIMIT 1').get(platform, now))
}

export function oldestQueued(db: Db, platform: string): DeliveryRow | null {
  return toRow(db.prepare(DELIVERY_SELECT + ' ORDER BY d.id LIMIT 1').get(platform))
}

export function queuedCount(db: Db, platform: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE platform = ? AND status = 'queued'").get(platform)
  return r!.n as number
}

export function markSent(db: Db, id: number, now: number, ref?: string): void {
  db.prepare("UPDATE deliveries SET status = 'sent', sent_at = ?, ref = ?, error = NULL WHERE id = ?").run(now, ref ?? null, id)
}

export function markRetry(db: Db, id: number, nextAt: number, error: string): void {
  db.prepare('UPDATE deliveries SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?').run(nextAt, error, id)
}

export function markFailed(db: Db, id: number, error: string): void {
  db.prepare("UPDATE deliveries SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?").run(error, id)
}

export function getState(db: Db, platform: string): PlatformState {
  const r = db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(platform)
  if (!r) {
    return { platform, status: 'up', reason: null, failingSince: null, downSince: null, nextProbeAt: null, alertSentAt: null, pausedUntil: null }
  }
  return {
    platform, status: r.status as 'up' | 'down', reason: r.reason as string | null,
    failingSince: r.failing_since as number | null, downSince: r.down_since as number | null,
    nextProbeAt: r.next_probe_at as number | null, alertSentAt: r.alert_sent_at as number | null,
    pausedUntil: r.paused_until as number | null,
  }
}

export function saveState(db: Db, s: PlatformState): void {
  const v: SQLInputValue[] = [s.platform, s.status, s.reason, s.failingSince, s.downSince, s.nextProbeAt, s.alertSentAt, s.pausedUntil]
  db.prepare(`INSERT OR REPLACE INTO platform_state
    (platform, status, reason, failing_since, down_since, next_probe_at, alert_sent_at, paused_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...v)
}

export function prune(db: Db, now: number): number {
  const cutoff = now - 30 * DAY
  const old = "SELECT id FROM messages WHERE created < ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = messages.id AND d.status = 'queued')"
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`DELETE FROM deliveries WHERE message_id IN (${old})`).run(cutoff)
    const n = db.prepare(`DELETE FROM messages WHERE id IN (${old})`).run(cutoff).changes
    db.exec('COMMIT')
    return Number(n)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
