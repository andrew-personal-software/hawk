export type Level = 'info' | 'warn' | 'error'
export type Core = { topic: string; title: string; level: Level; body?: string; link?: string; thread?: string; key?: string }
export type Env = Record<string, string | undefined>
export type Result =
  | { kind: 'ok'; ref?: string }
  | { kind: 'retry_after'; seconds: number }
  | { kind: 'transient'; error: string }
  | { kind: 'auth'; error: string }
  | { kind: 'permanent'; error: string }
export type Platform = {
  name: string
  label: string
  configured(env: Env): boolean
  /** `thread` is the ref saved from the thread's first `ok`; without it, `ok.ref` starts the thread. */
  send(msg: Core, target: string, env: Env, thread?: string): Promise<Result>
}
export type Status = 'queued' | 'sent' | 'failed'
export type DeliveryView = { platform: string; target: string; status: Status; attempts: number; error: string | null; sentAt: number | null }
export type MessageView = { id: string; topic: string; created: number; apiVersion: string; core: Core; status: Status; deliveries: DeliveryView[] }
