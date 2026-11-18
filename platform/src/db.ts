import { randomBytes } from 'node:crypto'
import type { Sys } from './types.ts'

const SQL_NAME = /^[a-z][a-z0-9_]{0,20}$/

/** Idempotent SQL that gives an app its login role and its own schema in the apps database. */
export function ensureSql(app: string, password: string): string {
  if (!SQL_NAME.test(app)) throw new Error(`app name '${app}' is not a plain SQL name`)
  if (!/^[0-9a-f]+$/.test(password)) throw new Error('password must be hex')
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${app}') THEN CREATE ROLE ${app} LOGIN PASSWORD '${password}';
  ELSE ALTER ROLE ${app} LOGIN PASSWORD '${password}';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS ${app} AUTHORIZATION ${app};
ALTER ROLE ${app} SET search_path = ${app}, public;
REVOKE ALL ON DATABASE apps FROM PUBLIC;
GRANT CONNECT ON DATABASE apps TO ${app};
`
}

export const dbEnvPath = (app: string) => `/etc/hawk/db/${app}.env`

/** Makes the app's DATABASE_URL once (root-only file), then makes sure the role and schema match it. */
export async function ensureDb(app: string, sys: Sys): Promise<void> {
  const path = dbEnvPath(app)
  let password = /^DATABASE_URL=postgres:\/\/[^:]+:([0-9a-f]+)@/m.exec(sys.read(path) ?? '')?.[1]
  if (!password) {
    password = randomBytes(32).toString('hex')
    sys.write(path, `DATABASE_URL=postgres://${app}:${password}@postgres:5432/apps\n`, 0o600)
  }
  await sys.run('podman', ['exec', '-i', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'apps'], { input: ensureSql(app, password) })
}
