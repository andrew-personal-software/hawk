// One-time: Discord requires a bot to connect to the gateway once before it can create messages.
const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('error: DISCORD_BOT_TOKEN is not set')
  process.exit(1)
}

let res: Response
try {
  res = await fetch('https://discord.com/api/v10/gateway/bot', { headers: { authorization: `Bot ${token}` } })
} catch (err) {
  console.error(`error: could not reach Discord: ${err}`)
  process.exit(1)
}
const gateway = (await res.json().catch(() => null)) as { url?: unknown } | null
if (!res.ok || typeof gateway?.url !== 'string') {
  console.error(res.status === 401 ? 'error: Discord rejected the token' : `error: Discord answered http ${res.status}`)
  process.exit(1)
}

const timer = setTimeout(() => {
  console.error('error: timed out waiting for Discord')
  process.exit(1)
}, 15_000)

const ws = new WebSocket(`${gateway.url}/?v=10&encoding=json`)
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { op: number; t?: string; d?: { user?: { username?: string } } }
  if (m.op === 10) {
    ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'hawk', device: 'hawk' } } }))
  } else if (m.op === 0 && m.t === 'READY') {
    clearTimeout(timer)
    console.log(`ok: identified as ${m.d?.user?.username}`)
    process.exit(0)
  } else if (m.op === 9) {
    console.error('error: Discord rejected the token')
    process.exit(1)
  }
}
ws.onclose = (e) => {
  console.error(e.code === 4004 ? 'error: Discord rejected the token' : `error: connection closed (${e.code})`)
  process.exit(1)
}
ws.onerror = () => {
  console.error('error: connection failed')
  process.exit(1)
}
