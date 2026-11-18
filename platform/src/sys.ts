import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Sys } from './types.ts'

const tail = (s: string) => s.trim().split('\n').slice(-15).join('\n')

async function request(url: string, init: RequestInit, ms: number): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
    return { status: r.status, body: await r.text() }
  } catch {
    return { status: 0, body: '' }
  }
}

/** Where lock files live. Tests point it at a temp dir. */
export const locks = { dir: '/run' }

export const realSys: Sys = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const fd = opts.stdoutFile ? fs.openSync(opts.stdoutFile, 'w', 0o600) : undefined
      const child = spawn(cmd, args, { stdio: [opts.input === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout?.on('data', (d) => (stdout += d))
      child.stderr!.on('data', (d) => { stderr += d; process.stderr.write(d) })
      if (opts.input !== undefined) child.stdin!.end(opts.input)
      child.on('error', (e) => { if (fd !== undefined) fs.closeSync(fd); reject(e) })
      child.on('close', (code) => {
        if (fd !== undefined) fs.closeSync(fd)
        if (code === 0) resolve(stdout)
        else reject(new Error(`${cmd} ${args[0] ?? ''} exited ${code}: ${tail(stderr || stdout)}`))
      })
    })
  },
  get: (url) => request(url, {}, 2000),
  post: (url, json) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }, 5000),
  read(p) {
    try { return fs.readFileSync(p, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  },
  lstat(p) {
    try {
      const s = fs.lstatSync(p)
      return { file: s.isFile(), uid: s.uid }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  },
  write(p, text, mode = 0o644) {
    if (realSys.read(p) === text) return false
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text, { mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, p)
    return true
  },
  remove: (p) => fs.rmSync(p, { force: true }),
  list(dir) {
    try { return fs.readdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  /**
   * flock(1) on our open fd of /run/<name>.lock, like hawk-update. The lock belongs to the open file,
   * so it stays after flock exits and goes when this process closes the fd or dies. The file is never removed.
   */
  lock(name) {
    const { O_WRONLY, O_CREAT, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(`${locks.dir}/${name}.lock`, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
    const r = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] })
    if (r.status !== 0) {
      fs.closeSync(fd)
      throw new Error(r.status === 1 ? 'busy' : `flock: ${r.error?.message ?? r.stderr}`)
    }
    let held = true
    return () => { if (held) { held = false; fs.closeSync(fd) } }
  },
}
