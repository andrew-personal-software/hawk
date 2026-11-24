import type { Sys } from '../src/types.ts'

export const RUNNER_UID = 1500

export type Call = { cmd: string; args: string[]; opts?: { input?: string; stdoutFile?: string } }

/** A recording Sys. Override any method; `run` answers from `answer` (throw to fail). */
export function fakeSys(o: Partial<Sys> & { answer?: (c: Call) => string } = {}) {
  const calls: Call[] = []
  const files = new Map<string, string>()
  const log: string[] = []
  const posts: { url: string; json: unknown; headers?: Record<string, string> }[] = []
  const sys: Sys = {
    async run(cmd, args, opts) {
      const c = { cmd, args, opts }
      calls.push(c); log.push(`run ${cmd} ${args.join(' ')}`)
      return o.answer ? o.answer(c) : ''
    },
    async get(url) { log.push(`get ${url}`); return { status: 200, body: '{}' } },
    async post(url, json, headers) { posts.push({ url, json, ...(headers && { headers }) }); log.push(`post ${url}`); return { status: 200, body: '{}' } },
    read: (p) => files.get(p) ?? null,
    lstat: (p) => (files.has(p) ? { file: true, uid: RUNNER_UID } : null),
    write(p, t) { log.push(`write ${p}`); if (files.get(p) === t) return false; files.set(p, t); return true },
    remove(p) { log.push(`remove ${p}`); files.delete(p) },
    list: (d) => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)).filter((k) => !k.includes('/')),
    async sleep(ms) { log.push(`sleep ${ms}`) },
    now: () => new Date('2026-11-18T12:00:00Z'),
    lock(name) { log.push(`lock ${name}`); return () => log.push(`unlock ${name}`) },
  }
  return { sys: { ...sys, ...o } as Sys, calls, files, log, posts }
}
