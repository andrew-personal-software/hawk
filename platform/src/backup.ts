import type { App, Sys } from './types.ts'

const STAMP = /(\d{8}T\d{6}Z)/
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** Files ending in `suffix` beyond the `keep` newest (by the stamp in the name). */
export function pruneList(files: string[], suffix: string, keep: number): string[] {
  return files
    .filter((f) => f.endsWith(suffix) && STAMP.test(f))
    .sort((a, b) => STAMP.exec(b)![1].localeCompare(STAMP.exec(a)![1]))
    .slice(keep)
}

/** pg_dump of the app's schema, and a tarball of /var/lib/<app> when it has files. Returns the paths written. */
export async function backupApp(app: App, sys: Sys, o: { prune: boolean }): Promise<string[]> {
  const dir = `/var/backups/${app.name}`
  const base = `${dir}/${app.name}-${stamp(sys.now())}`
  const written: string[] = []
  const put = async (path: string, make: (tmp: string) => Promise<unknown>) => {
    await make(`${path}.tmp`)
    await sys.run('mv', [`${path}.tmp`, path])
    written.push(path)
  }
  await put(`${base}.dump`, (tmp) =>
    sys.run('podman', ['exec', 'postgres', 'pg_dump', '-Fc', '-U', 'postgres', '-d', 'apps', '-n', app.name], { stdoutFile: tmp }))
  const data = `/var/lib/${app.name}`
  if (sys.list(data).length > 0) await put(`${base}-files.tar.gz`, (tmp) => sys.run('tar', ['-czf', tmp, '-C', data, '.']))
  if (o.prune) {
    const files = sys.list(dir)
    for (const f of [...pruneList(files, '.dump', 7), ...pruneList(files, '-files.tar.gz', 7)]) sys.remove(`${dir}/${f}`)
  }
  return written
}
