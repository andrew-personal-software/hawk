import { hostname } from 'node:os'
import type { Env } from './core.ts'

/** Sends the one down email through Resend. Resolves true only when Resend accepted it. */
export type Alert = (subject: string, text: string) => Promise<boolean>

export function makeAlert(env: Env, fetchImpl: typeof fetch = fetch): Alert {
  return async (subject, text) => {
    const { RESEND_API_KEY: key, EMAIL_FROM: from, EMAIL_TO: to } = env
    if (!key || !from || !to) return false
    try {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text: `${text}\n(on ${hostname()})` }),
        signal: AbortSignal.timeout(10_000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
