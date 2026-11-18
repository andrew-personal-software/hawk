import type { Sys } from './types.ts'

const KEY = /\(([A-Z][A-Z0-9]*-[0-9]+)\)( \(#[0-9]+\))?$/

/** Task keys at the end of commit subjects, unique, in order. */
export function taskKeys(subjects: string[]): string[] {
  const keys: string[] = []
  for (const s of subjects) {
    const k = KEY.exec(s.trim())?.[1]
    if (k && !keys.includes(k)) keys.push(k)
  }
  return keys
}

/** Commit subjects in this release: from the previous v* tag, or only the tag commit when there is none. */
export async function commitSubjects(version: string, sys: Sys): Promise<string[]> {
  const tag = `v${version}`
  let prev: string
  try {
    prev = (await sys.run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`])).trim()
  } catch {
    return lines(await sys.run('git', ['log', '-1', '--format=%s', tag]))
  }
  return lines(await sys.run('git', ['log', '--format=%s', `${prev}..${tag}`]))
}

const lines = (s: string) => s.split('\n').filter(Boolean)

/** Comments the deploy on each task; on success also sets it done. Keys sparrow does not know go in `unknown`. */
export async function linkTasks(
  o: { keys: string[]; app: string; version: string; url: string; ok: boolean; error?: string },
  sys: Sys,
  base = 'http://127.0.0.1:3417',
): Promise<{ updated: string[]; unknown: string[] }> {
  const updated: string[] = []
  const unknown: string[] = []
  const body = o.ok ? `${o.app} ${o.version} deployed: ${o.url}` : `${o.app} ${o.version} deploy failed: ${o.error ?? 'unknown error'}`
  for (const key of o.keys) {
    const url = `${base}/api/tasks/${key}`
    const send = async (op: unknown) => {
      const r = await sys.post(url, { op })
      if (r.status === 404) return false
      if (r.status < 200 || r.status > 299) throw new Error(`sparrow answered ${r.status} for ${key}: ${r.body.slice(0, 200)}`)
      return true
    }
    if (!(await send({ type: 'addComment', author: 'hawk', body }))) { unknown.push(key); continue }
    if (o.ok) await send({ type: 'setStatus', status: 'done' })
    updated.push(key)
  }
  return { updated, unknown }
}
