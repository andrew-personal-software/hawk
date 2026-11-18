import { spawn } from 'node:child_process'
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

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

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
  /** /run/<name>.lock holds our pid. A lock whose pid is gone (a killed deploy) is taken over. */
  lock(name) {
    const file = `/run/${name}.lock`
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
        const release = () => {
          process.off('exit', release)
          if (realSys.read(file) === String(process.pid)) fs.rmSync(file, { force: true })
        }
        process.on('exit', release)
        return release
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const pid = Number(realSys.read(file))
        if (pid && alive(pid)) break
        fs.rmSync(file, { force: true })
      }
    }
    throw new Error('busy')
  },
}
