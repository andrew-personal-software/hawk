import http from 'node:http'
import type { Db } from './db.ts'
import { getMessage, insertMessage } from './db.ts'
import { resolve } from './route.ts'
import type { Routes, Targets } from './route.ts'
import { fromCore, toCore } from './api/v1.ts'

export type ServerDeps = { db: Db; routes: Routes; known: Set<string>; now: () => number; version: string; log: (line: string) => void }

const LIMIT = 65_536

function send(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

const fail = (res: http.ServerResponse, status: number, code: string, message: string, field?: string) =>
  send(res, status, { error: { code, ...(field ? { field } : {}), message } })

/** Resolves with the body, or null when it exceeded the limit (the rest is read and discarded). */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((ok, no) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= LIMIT) chunks.push(c)
    })
    req.on('end', () => ok(size > LIMIT ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', no)
  })
}

async function post(d: ServerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const text = await readBody(req)
  if (text === null) return fail(res, 413, 'too_large', 'request body is over 64 KB')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return fail(res, 400, 'invalid_json', 'body is not valid JSON')
  }
  const parsed = toCore(json)
  if (!parsed.ok) return fail(res, 400, 'invalid', parsed.message, parsed.field)
  const { core } = parsed
  const targets: Targets = {}
  for (const [platform, target] of Object.entries(resolve(d.routes, core.topic))) {
    if (d.known.has(platform)) targets[platform] = target
    else d.log(`notify: unknown platform ${platform} for ${core.topic}, skipped`)
  }
  if (Object.keys(targets).length === 0) d.log(`notify: no known platform for ${core.topic}`)
  const { id, created } = insertMessage(d.db, core, 'v1', targets, d.now())
  d.log(`notify: v1 ${core.topic}`)
  if (created) return send(res, 202, { id, status: 'queued' })
  send(res, 200, { id, status: getMessage(d.db, id)?.status })
}

export function createServer(d: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'POST' && path === '/v1/messages') return await post(d, req, res)
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { version: d.version })
      const m = req.method === 'GET' ? /^\/v1\/messages\/([^/]+)$/.exec(path) : null
      if (m) {
        const msg = getMessage(d.db, m[1])
        return msg ? send(res, 200, fromCore(msg)) : fail(res, 404, 'not_found', 'no such message')
      }
      fail(res, 404, 'not_found', 'no such route')
    } catch (e) {
      d.log(`notify: internal error: ${e instanceof Error ? e.message : e}`)
      if (!res.headersSent) fail(res, 500, 'internal', 'internal error')
    }
  })
}
