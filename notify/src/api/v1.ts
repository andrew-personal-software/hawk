import type { Core, Level, MessageView } from '../core.ts'

export type Invalid = { ok: false; field: string; message: string }

const TOPIC = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const LEVELS: Level[] = ['info', 'warn', 'error']

const bad = (field: string, message: string): Invalid => ({ ok: false, field, message })

function str(v: unknown, min: number, max: number): boolean {
  return typeof v === 'string' && v.length >= min && v.length <= max
}

export function toCore(json: unknown): { ok: true; core: Core } | Invalid {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return bad('', 'expected a JSON object')
  const j = json as Record<string, unknown>

  if (!str(j.topic, 1, 200) || !TOPIC.test(j.topic as string)) return bad('topic', 'must be dotted lowercase segments, e.g. app.event')
  if (!str(j.title, 1, 150)) return bad('title', 'must be a string of 1-150 characters')
  if (j.body !== undefined && !str(j.body, 0, 40000)) return bad('body', 'must be a string of at most 40000 characters')
  if (j.level !== undefined && !LEVELS.includes(j.level as Level)) return bad('level', 'must be info, warn or error')
  if (j.link !== undefined) {
    let protocol = ''
    try { if (str(j.link, 1, 2000)) protocol = new URL(j.link as string).protocol } catch {}
    if (protocol !== 'http:' && protocol !== 'https:') return bad('link', 'must be an http or https URL of at most 2000 characters')
  }
  if (j.thread !== undefined && !str(j.thread, 1, 100)) return bad('thread', 'must be a string of 1-100 characters')
  if (j.key !== undefined && !str(j.key, 1, 200)) return bad('key', 'must be a string of 1-200 characters')

  const core: Core = { topic: j.topic as string, title: j.title as string, level: (j.level as Level | undefined) ?? 'info' }
  if (j.body !== undefined) core.body = j.body as string
  if (j.link !== undefined) core.link = j.link as string
  if (j.thread !== undefined) core.thread = j.thread as string
  if (j.key !== undefined) core.key = j.key as string
  return { ok: true, core }
}

const iso = (ms: number) => new Date(ms).toISOString()

export function fromCore(m: MessageView): object {
  return {
    id: m.id,
    topic: m.topic,
    status: m.status,
    created: iso(m.created),
    deliveries: m.deliveries.map((d) => ({
      platform: d.platform,
      target: d.target,
      status: d.status,
      attempts: d.attempts,
      error: d.error,
      sent: d.sentAt === null ? null : iso(d.sentAt),
    })),
  }
}
