export type Slot = 'blue' | 'green'
export type Job = { command: string[]; schedule: string }
export type AppSpec = {
  web?: { command: string[] }
  workers?: Record<string, string[]>
  jobs?: Record<string, Job>
  migrate?: string[]
  env?: Record<string, string>
  envFiles?: string[]
  tmpfs?: string[]
  downtime?: boolean
}
export type App = { name: string; port: number; health: string; uid: number; gid: number; spec: AppSpec }
export type AppState = { slot: Slot; version: string; previous: string | null; at: string }

/** Every side effect the platform has. Tests pass a fake. */
export type Sys = {
  run(cmd: string, args: string[], opts?: { input?: string; stdoutFile?: string }): Promise<string> // throws on non-zero
  get(url: string): Promise<{ status: number; body: string }> // status 0 on connect error
  post(url: string, json: unknown): Promise<{ status: number; body: string }>
  read(path: string): string | null
  lstat(path: string): { file: boolean; uid: number } | null // null when missing; a symlink is not a file
  write(path: string, text: string, mode?: number): boolean // false when unchanged
  remove(path: string): void
  list(dir: string): string[]
  sleep(ms: number): Promise<void>
  now(): Date
  lock(name: string): () => void // throws Error('busy') when held
}
