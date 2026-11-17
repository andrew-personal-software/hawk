export type Targets = Record<string, string>
export type Routes = { default: Targets; routes: Record<string, Targets> }

export function resolve(routes: Routes, topic: string): Targets {
  const exact = routes.routes[topic]
  if (exact) return exact
  let best = ''
  let found: Targets | undefined
  for (const [pattern, targets] of Object.entries(routes.routes)) {
    if (!pattern.endsWith('.*')) continue
    const prefix = pattern.slice(0, -1)
    if (topic.startsWith(prefix) && prefix.length > best.length) {
      best = prefix
      found = targets
    }
  }
  return found ?? routes.default
}
