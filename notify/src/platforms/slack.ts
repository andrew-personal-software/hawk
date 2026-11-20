import type { Core, Platform, Result } from '../core.ts'
import { parse } from '../markdown.ts'
import type { Block, Inline } from '../markdown.ts'

export type SlackPayload = { text: string; blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[] }

const MAX = 3000
const MAX_BODY_SECTIONS = 48
const PREFIX = { info: '', warn: ':warning: ', error: ':rotating_light: ' }
const TRANSIENT = new Set(['internal_error', 'service_unavailable', 'fatal_error', 'request_timeout'])
const AUTH = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'])

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const encodeUrl = (u: string) => u.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E')

function inline(nodes: Inline[]): string {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return esc(n.v)
      case 'code': return `\`${esc(n.v)}\``
      case 'bold': return `*${inline(n.c)}*`
      case 'italic': return `_${inline(n.c)}_`
      case 'link': return `<${encodeUrl(n.url)}|${inline(n.c)}>`
    }
  }).join('')
}

function block(b: Block): string {
  switch (b.t) {
    case 'para': return inline(b.c)
    case 'heading': return `*${inline(b.c)}*`
    case 'quote': return inline(b.c).split('\n').map((l) => `> ${l}`).join('\n')
    case 'code': return `\`\`\`${esc(b.v)}\`\`\``
    case 'list': return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${inline(it)}`).join('\n')
  }
}

// Move a cut back to the start of any `&…;` entity or `<…>` token it lands inside.
function safeCut(s: string, cut: number): number {
  const head = s.slice(0, cut)
  const lt = head.lastIndexOf('<')
  if (lt > head.lastIndexOf('>')) return lt
  const amp = head.lastIndexOf('&')
  if (amp > head.lastIndexOf(';') && cut - amp < 8) return amp
  return cut
}

function split(s: string): string[] {
  const out: string[] = []
  while (s.length > MAX) {
    const ws = Math.max(s.lastIndexOf('\n', MAX), s.lastIndexOf(' ', MAX))
    let cut = ws > 0 ? safeCut(s, ws) : 0
    if (cut <= 0) cut = safeCut(s, MAX)
    if (cut <= 0) cut = MAX
    out.push(s.slice(0, cut))
    s = s.slice(cut)
  }
  out.push(s)
  return out
}

function pack(pieces: string[]): string[] {
  const out: string[] = []
  for (const piece of pieces.flatMap((p) => (p.length > MAX ? split(p) : [p]))) {
    const last = out[out.length - 1]
    if (last !== undefined && last.length + 2 + piece.length <= MAX) out[out.length - 1] = `${last}\n\n${piece}`
    else out.push(piece)
  }
  return out
}

const section = (text: string) => ({ type: 'section' as const, text: { type: 'mrkdwn' as const, text } })

// One payload per 48 body sections (title + 48 + link ≤ 50 blocks). Parts are numbered when there are several.
export function render(msg: Core): SlackPayload[] {
  const body = pack(parse(msg.body ?? '').map(block))
  const chunks: string[][] = []
  for (let i = 0; i < body.length; i += MAX_BODY_SECTIONS) chunks.push(body.slice(i, i + MAX_BODY_SECTIONS))
  if (chunks.length === 0) chunks.push([])
  return chunks.map((secs, i) => {
    const part = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''
    const blocks = [section(`${PREFIX[msg.level]}*${esc(msg.title)}*${part}`), ...secs.map(section)]
    if (msg.link && i === chunks.length - 1) blocks.push(section(`<${encodeUrl(msg.link)}|Open>`))
    return { text: esc(msg.title) + part, blocks }
  })
}

export function mapResponse(status: number, retryAfter: string | null, body: unknown): Result {
  if (status === 429) {
    const s = Number(retryAfter)
    return { kind: 'retry_after', seconds: retryAfter && Number.isFinite(s) && s > 0 ? s : 30 }
  }
  if (status >= 500) return { kind: 'transient', error: `http ${status}` }
  if (typeof body !== 'object' || body === null) return { kind: 'transient', error: `bad response (http ${status})` }
  const r = body as { ok?: unknown; ts?: unknown; error?: unknown }
  if (r.ok === true) return { kind: 'ok', ref: typeof r.ts === 'string' ? r.ts : undefined }
  const error = typeof r.error === 'string' ? r.error : 'unknown_error'
  if (TRANSIENT.has(error)) return { kind: 'transient', error }
  if (AUTH.has(error)) return { kind: 'auth', error }
  return { kind: 'permanent', error }
}

const PART_GAP_MS = 1000
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// A failure after some parts were posted returns that failure; the retry posts every part again.
export function makeSlack(fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = wait): Platform {
  async function post(body: string, token: string | undefined): Promise<Result> {
    try {
      const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      return mapResponse(res.status, res.headers.get('retry-after'), await res.json().catch(() => null))
    } catch (err) {
      return { kind: 'transient', error: String(err) }
    }
  }
  return {
    name: 'slack',
    label: 'Slack',
    configured: (env) => typeof env.SLACK_BOT_TOKEN === 'string' && env.SLACK_BOT_TOKEN !== '',
    async send(msg, target, env, thread) {
      let bodies: string[]
      try {
        bodies = render(msg).map((p) => JSON.stringify({ channel: target, ...(thread ? { thread_ts: thread } : {}), ...p }))
      } catch (err) {
        return { kind: 'permanent', error: `render: ${err instanceof Error ? err.message : String(err)}` }
      }
      let ref: string | undefined
      for (const [i, body] of bodies.entries()) {
        if (i > 0) await sleep(PART_GAP_MS)
        const r = await post(body, env.SLACK_BOT_TOKEN)
        if (r.kind !== 'ok') return r
        ref ??= r.ref
      }
      return { kind: 'ok', ref }
    },
  }
}

export const slack: Platform = makeSlack()
