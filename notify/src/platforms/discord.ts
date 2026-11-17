import type { Core, Platform, Result } from '../core.ts'
import { parse } from '../markdown.ts'
import type { Block, Inline } from '../markdown.ts'

export type DiscordPayload = { content: string; allowed_mentions: { parse: [] } }

const MAX = 2000
const SUFFIX = 8 // room for " (99/99)"
const PREFIX = { info: '', warn: '⚠️ ', error: '🚨 ' }

const esc = (s: string) => s.replace(/[\\*_~`|[\]]/g, '\\$&')
const encodeUrl = (u: string) => u.replace(/\)/g, '%29').replace(/ /g, '%20')

function inline(nodes: Inline[]): string {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return esc(n.v)
      case 'code': return n.v.includes('`') ? `\`\` ${n.v} \`\`` : `\`${n.v}\``
      case 'bold': return `**${inline(n.c)}**`
      case 'italic': return `*${inline(n.c)}*`
      case 'link': return `[${inline(n.c)}](${encodeUrl(n.url)})`
    }
  }).join('')
}

function block(b: Block): string {
  switch (b.t) {
    case 'para': return inline(b.c)
    case 'heading': return `### ${inline(b.c)}`
    case 'quote': return inline(b.c).split('\n').map((l) => `> ${l}`).join('\n')
    case 'code': return `\`\`\`\n${b.v}\n\`\`\``
    case 'list': return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${inline(it)}`).join('\n')
  }
}

// Cut at the last newline or space within the budget (dropping it), else at the budget. Cuts may misrender.
function split(s: string, budget: number): string[] {
  const out: string[] = []
  while (s.length > budget) {
    const ws = Math.max(s.lastIndexOf('\n', budget), s.lastIndexOf(' ', budget))
    if (ws > 0) { out.push(s.slice(0, ws)); s = s.slice(ws + 1) } else { out.push(s.slice(0, budget)); s = s.slice(budget) }
  }
  out.push(s)
  return out
}

function pack(pieces: string[], budget: number): string[] {
  const out: string[] = []
  for (const piece of pieces.flatMap((p) => (p.length > budget ? split(p, budget) : [p]))) {
    const last = out[out.length - 1]
    if (last !== undefined && last.length + 2 + piece.length <= budget) out[out.length - 1] = `${last}\n\n${piece}`
    else out.push(piece)
  }
  return out
}

export function render(msg: Core): DiscordPayload[] {
  const title = `${PREFIX[msg.level]}**${esc(msg.title)}**`
  const budget = Math.max(MAX - title.length - SUFFIX - 1, 100)
  const body = parse(msg.body ?? '').map(block)
  const chunks = body.length ? pack(body, budget) : ['']
  const link = msg.link ? `\n\n[Open](${encodeUrl(msg.link)})` : ''
  const lastLen = title.length + SUFFIX + (chunks.at(-1) ? 1 + chunks.at(-1)!.length : 0)
  const linkOwn = link !== '' && lastLen + link.length > MAX
  const total = chunks.length + (linkOwn ? 1 : 0)
  const parts = chunks.map((c, i) => {
    const head = total > 1 ? `${title} (${i + 1}/${total})` : title
    let content = c ? `${head}\n${c}` : head
    if (link && !linkOwn && i === chunks.length - 1) content += link
    return content
  })
  if (linkOwn) parts.push(msg.link!)
  return parts.map((content) => ({ content, allowed_mentions: { parse: [] as [] } }))
}

export function mapResponse(status: number, body: unknown): Result {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown; retry_after?: unknown; message?: unknown; code?: unknown }
  if (status >= 200 && status < 300) return { kind: 'ok', ref: typeof b.id === 'string' ? b.id : undefined }
  if (status === 429) {
    const s = Number(b.retry_after)
    return { kind: 'retry_after', seconds: typeof b.retry_after === 'number' && Number.isFinite(s) && s > 0 ? Math.ceil(s) : 30 }
  }
  if (status === 401) return { kind: 'auth', error: `http 401: ${typeof b.message === 'string' ? b.message : 'unauthorized'}` }
  if (status >= 500) return { kind: 'transient', error: `http ${status}` }
  const detail = [b.code, b.message].filter((x) => typeof x === 'string' || typeof x === 'number').join(' ')
  return { kind: 'permanent', error: `http ${status}${detail ? `: ${detail}` : ''}` }
}

const PART_GAP_MS = 1000
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// A failure after some parts were posted returns that failure; the retry posts every part again.
export function makeDiscord(fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = wait): Platform {
  async function post(url: string, body: string, token: string | undefined): Promise<Result> {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (hawk-notify, 1.0)' },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      return mapResponse(res.status, await res.json().catch(() => null))
    } catch (err) {
      return { kind: 'transient', error: String(err) }
    }
  }
  return {
    name: 'discord',
    label: 'Discord',
    configured: (env) => typeof env.DISCORD_BOT_TOKEN === 'string' && env.DISCORD_BOT_TOKEN !== '',
    async send(msg, target, env) {
      let bodies: string[]
      try {
        bodies = render(msg).map((p) => JSON.stringify(p))
      } catch (err) {
        return { kind: 'permanent', error: `render: ${err instanceof Error ? err.message : String(err)}` }
      }
      const url = `https://discord.com/api/v10/channels/${encodeURIComponent(target)}/messages`
      let ref: string | undefined
      for (const [i, body] of bodies.entries()) {
        if (i > 0) await sleep(PART_GAP_MS)
        const r = await post(url, body, env.DISCORD_BOT_TOKEN)
        if (r.kind !== 'ok') return r
        ref ??= r.ref
      }
      return { kind: 'ok', ref }
    },
  }
}

export const discord: Platform = makeDiscord()
