import { slotPort } from './config.ts'
import type { App, Slot } from './types.ts'

export const QUADLET_DIR = '/etc/containers/systemd'
export const SYSTEMD_DIR = '/etc/systemd/system'

/** Quotes one word the way systemd and Quadlet split lines. */
export const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, '\\$&')}"`)

/** The podman options every container of an app shares. Also used for the migrate run. */
export function containerLines(app: App): string[] {
  const s = app.spec
  return [
    `User=${app.uid}:${app.gid}`,
    'Network=hawk.network',
    `Volume=/var/lib/${app.name}:/data`,
    `EnvironmentFile=/etc/hawk/db/${app.name}.env`,
    ...(s.envFiles ?? []).map((f) => `EnvironmentFile=${f}`),
    'Environment=PORT=3000',
    ...Object.entries(s.env ?? {}).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`),
    'ReadOnly=true',
    'Tmpfs=/tmp',
    ...(s.tmpfs ?? []).map((t) => `Tmpfs=${t}`),
    'DropCapability=ALL',
    'NoNewPrivileges=true',
  ]
}

function container(app: App, o: { name: string; image: string; command: string[]; port?: number; install: boolean; restart: string }): string {
  return [
    '[Unit]',
    `Description=${app.name} ${o.name}`,
    'Wants=postgres.service',
    'After=postgres.service',
    'OnFailure=hawk-notify@%N.service',
    '',
    '[Container]',
    `ContainerName=${app.name}-${o.name}`,
    `Image=${o.image}`,
    ...(o.port ? [`PublishPort=127.0.0.1:${o.port}:3000`] : []),
    ...containerLines(app),
    `Exec=${o.command.map(quote).join(' ')}`,
    '',
    '[Service]',
    `Restart=${o.restart}`,
    'TimeoutStopSec=20',
    'SuccessExitStatus=143',
    ...(o.install ? ['', '[Install]', 'WantedBy=multi-user.target'] : []),
    '',
  ].join('\n')
}

/** Every unit file of an app (absolute path → content). Only the live slot starts at boot. */
export function renderUnits(app: App, live: Slot): Map<string, string> {
  const units = new Map<string, string>()
  const live_ = `localhost/${app.name}:live`
  const web = app.spec.web
  if (web) {
    for (const slot of ['blue', 'green'] as const)
      units.set(`${QUADLET_DIR}/${app.name}-${slot}.container`, container(app, {
        name: slot, image: `localhost/${app.name}:${slot}`, command: web.command, port: slotPort(app, slot),
        install: slot === live, restart: 'always' }))
  }
  for (const [name, command] of Object.entries(app.spec.workers ?? {}))
    units.set(`${QUADLET_DIR}/${app.name}-${name}.container`, container(app, { name, image: live_, command, install: true, restart: 'always' }))
  for (const [name, job] of Object.entries(app.spec.jobs ?? {})) {
    units.set(`${QUADLET_DIR}/${app.name}-${name}.container`, container(app, { name, image: live_, command: job.command, install: false, restart: 'no' }))
    units.set(`${SYSTEMD_DIR}/${app.name}-${name}.timer`, [
      '[Unit]', `Description=${app.name} ${name} schedule`, '',
      '[Timer]', `OnCalendar=${job.schedule}`, 'Persistent=true', `Unit=${app.name}-${name}.service`, '',
      '[Install]', 'WantedBy=timers.target', ''].join('\n'))
  }
  return units
}
