# Containers, Postgres and zero-downtime deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hawk runs apps as Podman containers on one Postgres server, deploys every merge to `main` blue/green with no downtime, and updates the sparrow task named in each PR title. dodo is the first app moved.

**Architecture:** New TypeScript module `platform/` in hawk (Node 24 type stripping, no runtime deps, `node:test`) holds the container logic: config parsing, Quadlet and Caddy rendering, release/rollback orchestration, backups and task links. All side effects go through one `Sys` interface so tests use a fake. `bin/hawk` keeps the old systemd flow for apps without `RUNTIME=podman` and hands podman apps to `node /opt/hawk/platform/src/main.ts`. dodo moves from `node:sqlite` to `postgres` (postgres.js), gains a `Containerfile` and `deploy/hawk.json`, and drops its unit files.

**Tech Stack:** Podman 4.9 + Quadlet (rootful, `/etc/containers/systemd`), Postgres 17 (`docker.io/library/postgres:17`), Caddy, systemd, bash, Node 24, GitHub Actions + semantic-release. dodo: Next.js 16, postgres.js 3, vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-containers-design.md`

## Global Constraints

- **Prerequisite: HAWK-11 is done.** Every GitHub URL in this plan uses `andrew-personal-software`, and one org runner with label `hawk` serves all repos.
- hawk `platform/`: no runtime npm deps, no build step, same tsconfig rules as `notify/` (type stripping only: no `enum`, no `namespace`, no parameter properties; relative imports end in `.ts`; `import type` for types).
- Ports: blue slot = `PORT` from `apps/<app>.env`; green slot = `PORT + 1000`. Containers listen on `3000` inside. Publish only on `127.0.0.1`.
- Images: `localhost/<app>:<version>`. Slot tags `localhost/<app>:blue` / `:green`. Workers and jobs use `localhost/<app>:live`. Keep the 3 newest version tags per app.
- Postgres: container name `postgres`, Podman network `hawk` (Quadlet `hawk.network`, `NetworkName=hawk`), data `/var/lib/postgres`, published `127.0.0.1:5432`. Database `apps`. Per app: role and schema `<app>`, `search_path = <app>, public`. `pg_trgm` installed once in `public`.
- App connection string: `/etc/hawk/db/<app>.env` (root:root 0600, read by systemd) with `DATABASE_URL=postgres://<app>:<password>@postgres:5432/apps`.
- App data volume: host `/var/lib/<app>` → container `/data`, owned by the app's system user. Containers run with `User=<uid>:<gid>` of that user (not `UserNS=auto`: two slots must write the same volume).
- State: `/var/lib/hawk/apps/<app>.json` = `{"slot","version","previous","at"}`.
- Build handoff: runner writes `/var/lib/hawk-images/<app>-<version>.tar` and `<app>-<version>.json` (copy of `deploy/hawk.json`); root `hawk release` reads only from there.
- Runner sudo: exactly `hawk-runner ALL=(root) NOPASSWD: /usr/local/bin/hawk release <app> *` per podman app. `release` checks the version matches `^[0-9]+\.[0-9]+\.[0-9]+$`.
- Health: 30 tries, 1 s apart, `GET http://127.0.0.1:<slot port><HEALTH>` must return `{"version": "<version>"}`. Drain wait after Caddy switch: 5 s. `TimeoutStopSec=20`.
- Backups: `/var/backups/<app>/<app>-<UTC stamp>.dump` (`pg_dump -Fc -n <app>`) and `<app>-<UTC stamp>-files.tar.gz`; keep 7 newest of each. Nightly `hawk-backup.timer` at `03:15`.
- Task key in PR title: `\(([A-Z][A-Z0-9]*-[0-9]+)\)( \(#[0-9]+\))?$`. sparrow API: `POST http://127.0.0.1:3417/api/tasks/<KEY>` body `{"op": {...}}`, `author: "hawk"`.
- Release rules: `feat` minor, breaking major, every other conventional type patch.
- Repo rules: simple code, few comments, docblocks under 12 lines, conventional commits. hawk work on `feat/containers`; dodo work on `feat/postgres-container`. Never commit to `main`.

## Review Focus

- **Deploy fails after Caddy switched** (old slot will not stop): state must already say the new slot, so a re-run or rollback does not flip traffic back to a stopped slot. Test in Task 6.
- **Two deploys or a deploy and a rollback at once** on one app: the second must fail fast with "busy", not interleave. Test in Task 6.
- **First deploy ever** (no state file, no previous tag, no old image): picks blue, stops nothing, links only the tag commit's key. Tests in Tasks 4 and 6.
- **Box reboot**: only the live slot starts. Test in Task 3 (only the live slot unit has `[Install]`).
- **Postgres down or migration fails**: the live slot keeps serving and Caddy is untouched. Test in Task 6.

---

## File Structure

hawk:
```
platform/
  tsconfig.json
  src/
    types.ts        Slot, AppSpec, App, AppState, Sys
    config.ts       parseSpec(), parseAppEnv(), slotPort(), loadApp()
    quadlet.ts      renderUnits()
    caddy.ts        renderSite()
    tasks.ts        taskKeys(), linkTasks(), commitSubjects()
    db.ts           ensureSql(), ensureDb()
    backup.ts       pruneList(), backupApp()
    release.ts      release(), rollback(), DeployError
    setup.ts        setup(), build()
    sys.ts          realSys
    main.ts         CLI
  test/*.test.ts
containers/postgres.container, containers/hawk.network
systemd/hawk-backup.service, systemd/hawk-backup.timer
bin/hawk                       (modify: route podman apps, status rows)
install.sh                     (modify: podman, postgres, dirs, ports, timer)
.github/workflows/release.yml  (modify: rules, fetch-depth, tasks steps)
.github/workflows/pr-title.yml (new, reusable)
.github/workflows/check.yml    (modify: platform tests)
package.json                   (modify: test/typecheck scripts)
apps/dodo.env                  (modify: RUNTIME=podman)
README.md
```

dodo (`~/Desktop/personal/dodo`):
```
src/core/db.ts          postgres.js connect(), migrate(), tx(), notify()
src/core/docs.ts        async
src/core/files.ts       async
src/core/search.ts      pg_trgm + snippetOf()
src/core/testdb.ts      testDb() for vitest
src/server/state.ts     async getState(), LISTEN
src/app/api/**/route.ts await state
src/cli/cleanup.ts      (replaces backup.ts) orphan file prune
src/cli/migrate.ts      async
src/cli/import-sqlite.ts one-time copy
Containerfile, .containerignore, deploy/hawk.json
deploy/*.service|*.timer, deploy/build.sh, deploy/hawk-setup.sh  (delete)
scripts/dev.sh, scripts/db-pull.sh
.github/workflows/pr.yml, release.yml
tsup.config.ts
```

---

### Task 1: Release on every merge, and the PR title check

**Files:**
- Modify: `.github/workflows/release.yml` (the default `.releaserc.json`)
- Create: `.github/workflows/pr-title.yml`

**Interfaces:**
- Produces: reusable workflow `andrew-personal-software/hawk/.github/workflows/pr-title.yml@main` (no inputs). Apps call it from `pr.yml` in place of their own `title` job.

- [ ] **Step 1:** In `release.yml`, extend `releaseRules` to `[{type:"docs",release:"patch"},{type:"chore",release:"patch"},{type:"refactor",release:"patch"},{type:"test",release:"patch"},{type:"ci",release:"patch"},{type:"style",release:"patch"},{type:"build",release:"patch"},{type:"perf",release:"patch"},{type:"revert",release:"patch"}]`. Remove the two `release: false` rules.
- [ ] **Step 2:** Create `pr-title.yml` (`on: workflow_call`). Job `title` on `ubuntu-latest`: the current conventional-commit regex check (copy from an app's `pr.yml`). Job `task` on `hawk`, no checkout: take `TITLE` from `github.event.pull_request.title`; if it matches the key pattern, `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3417/api/tasks/$KEY`; fail with `PR title names $KEY, which sparrow does not know` on 404; pass with no key.
- [ ] **Step 3: Verify** with `actionlint .github/workflows/*.yml` (install with `brew install actionlint` if missing). Expected: no errors.
- [ ] **Step 4: Verify the rules** locally: in a scratch repo with commits `docs: a`, `chore: b`, run the same `npx semantic-release --dry-run --no-ci` with the new config. Expected: "next release version is …" for each.
- [ ] **Step 5: Commit** `ci: release on every merge and check task keys in PR titles (TASK-11)`.

### Task 2: Platform config

**Files:**
- Create: `platform/tsconfig.json` (copy of `notify/tsconfig.json`, include `src`, `test`), `platform/src/types.ts`, `platform/src/config.ts`, `platform/test/config.test.ts`
- Modify: `package.json` scripts: `"test": "node --test 'notify/test/*.test.ts' 'platform/test/*.test.ts'"`, `"typecheck": "tsc -p notify && tsc -p platform"`; `.github/workflows/check.yml` job `notify` → rename `node`; `install.sh` port duplicate check also counts `PORT + 1000` for apps with `RUNTIME=podman`.

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type Slot = 'blue' | 'green'
  export type Job = { command: string[]; schedule: string }
  export type AppSpec = { web?: { command: string[] }; workers?: Record<string, string[]>; jobs?: Record<string, Job>;
    migrate?: string[]; env?: Record<string, string>; envFiles?: string[]; tmpfs?: string[]; downtime?: boolean }
  export type App = { name: string; port: number; health: string; uid: number; gid: number; spec: AppSpec }
  export type AppState = { slot: Slot; version: string; previous: string | null; at: string }
  export type Sys = {
    run(cmd: string, args: string[], opts?: { input?: string; stdoutFile?: string }): Promise<string> // throws on non-zero
    get(url: string): Promise<{ status: number; body: string }>                                      // status 0 on connect error
    post(url: string, json: unknown): Promise<{ status: number; body: string }>
    read(path: string): string | null
    write(path: string, text: string, mode?: number): boolean // false when unchanged
    remove(path: string): void
    list(dir: string): string[]
    sleep(ms: number): Promise<void>
    now(): Date
    lock(name: string): () => void // throws Error('busy') when held
  }
  ```
- Produces (`config.ts`): `parseSpec(json: unknown, app: string): AppSpec` (`tmpfs` entries are absolute paths), `parseAppEnv(text: string): { port: number; health: string; runtime: 'systemd' | 'podman' }`, `slotPort(app: App, slot: Slot): number`, `loadApp(name: string, sys: Sys, specPath?: string): Promise<App>` (reads `/opt/hawk/apps/<name>.env`, spec from `specPath` or `/etc/hawk/apps/<name>.json`, uid/gid via `id -u`/`id -g`).

- [ ] **Step 1: Write failing tests** in `platform/test/config.test.ts`:
  - `parseSpec` accepts dodo's spec (Task 15's `deploy/hawk.json`) and returns it unchanged.
  - `parseSpec` throws `/workers\.Bad/` for worker name `Bad`, `/env\.DATABASE_URL/` and `/env\.PORT/` when set, `/envFiles\[0\]/` for a path not under `/etc/<app>/` (pass app name as second arg: `parseSpec(json, 'dodo')`), `/web\.command/` for an empty array, and `/jobs\.cleanup\.schedule/` for an empty schedule.
  - `parseAppEnv('PORT=3420\nHEALTH=/api/version\nRUNTIME=podman\n')` → `{port:3420, health:'/api/version', runtime:'podman'}`; without `RUNTIME` → `'systemd'`.
  - `slotPort({port:3420,…}, 'green') === 4420`.
- [ ] **Step 2: Run** `pnpm test` → FAIL (module missing).
- [ ] **Step 3: Implement** `types.ts` and `config.ts`. Names match `^[a-z][a-z0-9-]{0,20}$`; env keys `^[A-Z_][A-Z0-9_]*$`. Errors name the field path.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(platform): app spec and config parsing (TASK-11)`.

### Task 3: Quadlet and Caddy rendering

**Files:**
- Create: `platform/src/quadlet.ts`, `platform/src/caddy.ts`, `platform/test/render.test.ts`

**Interfaces:**
- Consumes: `App`, `Slot`, `slotPort` (Task 2).
- Produces: `renderUnits(app: App, live: Slot): Map<string, string>` (absolute path → content); `renderSite(app: string, domain: string, port: number): string`.

- [ ] **Step 1: Write failing tests** with dodo's spec plus one worker `w` and one job `cleanup`:
  - keys are exactly `/etc/containers/systemd/dodo-blue.container`, `…/dodo-green.container`, `…/dodo-w.container`, `…/dodo-cleanup.container`, `/etc/systemd/system/dodo-cleanup.timer`.
  - blue has `Image=localhost/dodo:blue`, `PublishPort=127.0.0.1:3420:3000`; green has `:green` and `4420`.
  - only the `live` slot's file contains `[Install]` and `WantedBy=multi-user.target` (test both `live` values). The worker always has it. The job has `Restart=no` and no `[Install]`; the timer has `OnCalendar=*-*-* 03:30:00`, `Persistent=true`, `Unit=dodo-cleanup.service`.
  - every `.container` has `OnFailure=hawk-notify@%N.service`, `SuccessExitStatus=143`, `TimeoutStopSec=20`, `User=<uid>:<gid>`, `Network=hawk.network`, `Volume=/var/lib/dodo:/data`, `EnvironmentFile=/etc/hawk/db/dodo.env`, `Environment=PORT=3000`, `ReadOnly=true`, `Tmpfs=/tmp`, `DropCapability=ALL`, `NoNewPrivileges=true`, one `EnvironmentFile=` per `envFiles` entry, one `Environment=K=V` per `env` entry, one `Tmpfs=` per `tmpfs` entry.
  - `Exec=` quotes arguments with spaces.
  - `renderSite('dodo','andrewminghanjiang.com',4420)` equals `"dodo.andrewminghanjiang.com {\n\timport tailnet\n\treverse_proxy 127.0.0.1:4420\n}"` (same shape `caddy/setup.sh` writes).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Plain template strings; no `ContainerName` collisions: `ContainerName=<app>-<slot|worker|job>`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(platform): render quadlet units and caddy sites (TASK-11)`.

### Task 4: Task links

**Files:**
- Create: `platform/src/tasks.ts`, `platform/test/tasks.test.ts`
- Modify: `.github/workflows/release.yml` deploy job

**Interfaces:**
- Consumes: `Sys` (Task 2).
- Produces:
  - `taskKeys(subjects: string[]): string[]` (unique, in order).
  - `commitSubjects(version: string, sys: Sys): Promise<string[]>` — previous tag = `git describe --tags --abbrev=0 --match 'v*' v<version>^`; if that fails, only `git log -1 --format=%s v<version>`; else `git log --format=%s <prev>..v<version>`.
  - `linkTasks(o: { keys: string[]; app: string; version: string; url: string; ok: boolean; error?: string }, sys: Sys, base = 'http://127.0.0.1:3417'): Promise<{ updated: string[]; unknown: string[] }>`.

- [ ] **Step 1: Write failing tests:**
  - `taskKeys(['fix(modal-ui): close on escape (SPAR-12) (#40)', 'feat: x (HAWK-3)', 'docs: y', 'fix(SPAR-9): z', 'chore: a (SPAR-12)'])` → `['SPAR-12','HAWK-3']` (key in scope is ignored).
  - `commitSubjects` with a fake `run` where `git describe` throws → calls `git log -1` only.
  - `linkTasks` ok → per key posts `{op:{type:'addComment',author:'hawk',body:'dodo 1.2.0 deployed: <url>'}}` then `{op:{type:'setStatus',status:'done'}}`; failed → posts only `addComment` with `'dodo 1.2.0 deploy failed: <error>'`; a 404 on the comment puts the key in `unknown` and skips `setStatus`; any other non-2xx throws.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `tasks.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Wire `release.yml`:** deploy job checkout gets `fetch-depth: 0`. After `hawk deploy`, add step `if: success()`: `hawk tasks ${{ inputs.app }} "$VERSION" ok`, and step `if: failure()`: `hawk tasks ${{ inputs.app }} "$VERSION" failed "see $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"`. Release URL inside `hawk tasks`: `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/v$VERSION`. `hawk tasks` posts a `warn` to hawk-notifyd (`topic: "hawk.tasks"`) listing `unknown` keys. `actionlint` → no errors.
- [ ] **Step 6: Commit** `feat(platform): update sparrow tasks named in a release (TASK-11)`.

### Task 5: Database roles and backups

**Files:**
- Create: `platform/src/db.ts`, `platform/src/backup.ts`, `platform/test/db.test.ts`, `platform/test/backup.test.ts`, `systemd/hawk-backup.service`, `systemd/hawk-backup.timer`

**Interfaces:**
- Produces:
  - `ensureSql(app: string, password: string): string` — idempotent SQL: create role `<app>` LOGIN if missing else `ALTER ROLE … PASSWORD`; `CREATE SCHEMA IF NOT EXISTS <app> AUTHORIZATION <app>`; `ALTER ROLE <app> SET search_path = <app>, public`; `GRANT CONNECT ON DATABASE apps TO <app>`.
  - `ensureDb(app: string, sys: Sys): Promise<void>` — reads or creates `/etc/hawk/db/<app>.env` (32-byte random hex password, mode 0600), runs `ensureSql` through `podman exec -i postgres psql -v ON_ERROR_STOP=1 -U postgres -d apps`.
  - `pruneList(files: string[], suffix: string, keep: number): string[]` — names ending in `suffix`, sorted newest first by the stamp in the name, beyond `keep`.
  - `backupApp(app: App, sys: Sys, o: { prune: boolean }): Promise<string[]>` — writes the dump (`.tmp` then rename) and, if `/var/lib/<app>` is not empty, the files tarball; returns paths written.
- `hawk-backup.service`: oneshot, `ExecStart=/usr/local/bin/hawk backup`, `OnFailure=hawk-notify@%N.service`. Timer: `OnCalendar=*-*-* 03:15:00`, `Persistent=true`.

- [ ] **Step 1: Write failing tests:** `ensureSql('dodo','p')` contains `CREATE SCHEMA IF NOT EXISTS dodo AUTHORIZATION dodo` and `search_path = dodo, public`, and rejects app `'x;drop'` (throws). `pruneList` with 9 `.dump` and 2 `-files.tar.gz` names, keep 7 → the 2 oldest dumps only. `backupApp` with a fake `Sys`: calls `pg_dump -Fc -n dodo` with `stdoutFile` ending `.dump.tmp`, then renames; skips tar when `list('/var/lib/dodo')` is empty; with `prune:false` removes nothing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(platform): per-app postgres roles and backups (TASK-11)`.

### Task 6: Release and rollback

**Files:**
- Create: `platform/src/release.ts`, `platform/test/release.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `class DeployError extends Error { step: string }`
  - `release(app: App, version: string, sys: Sys, domain: string): Promise<AppState>`
  - `rollback(app: App, version: string | undefined, sys: Sys, domain: string): Promise<AppState>`

Steps of `release` (spec "Deploy flow"), each a named `DeployError` step: `lock` (`sys.lock('hawk-<app>')`), `load` (`parseSpec` the json beside the tar and copy it to `/etc/hawk/apps/<app>.json`, so a new job or worker deploys with the release; `podman load -i /var/lib/hawk-images/<app>-<version>.tar`; then delete the tar and json), `units` (write `renderUnits(app, live)` with the current live slot; `systemctl daemon-reload` if any changed), `backup` (`backupApp` with `prune:false`), `migrate` (`podman run --rm` the new image with `migrate` as command, same network/env/volume/user as the units), `start` (tag `:<idle>`, `systemctl restart <app>-<idle>`), `health`, `switch` (write site, `systemctl reload caddy`), `state` (write state with new slot, `previous` = old version), `drain` (sleep 5 s), `stop` (`systemctl stop <app>-<old>`), `live` (always tag `:live`, which jobs use; restart each worker), `units` again with the new live slot (moves `[Install]`), `prune` (remove version tags beyond the 3 newest, `podman image prune -f`). With `spec.downtime`, stop the live slot and workers before `migrate`. With no state: idle = `blue`, no `stop`. Without `spec.web`: skip `start`–`stop`.

`rollback`: `version` defaults to `state.previous`; requires image `localhost/<app>:<version>` to exist; runs `start`→`prune` without `load`, `backup`, `migrate`; prints the restore warning from the old `cmd_rollback`.

- [ ] **Step 1: Write failing tests** with a fake `Sys` that records calls and returns scripted answers:
  - happy path from state `blue@1.0.0` to `1.1.0`: calls happen in step order; final state `{slot:'green',version:'1.1.0',previous:'1.0.0'}`; site file has `4420`; `systemctl stop dodo-blue` comes after the 5 s sleep.
  - first deploy (no state): idle is blue, no `systemctl stop`, `previous: null`.
  - migrate throws → `DeployError` step `migrate`; no `systemctl restart dodo-green`, site file never written.
  - health returns `{"version":"1.0.0"}` 30 times → `DeployError` step `health`; `systemctl stop dodo-green` called; site untouched; state unchanged.
  - `systemctl stop dodo-blue` throws → `DeployError` step `stop`, and the state file already says `green@1.1.0`.
  - `lock` throws `busy` → `DeployError` step `lock`, no other calls.
  - `downtime: true` → `systemctl stop dodo-blue` comes before `migrate`.
  - rollback from `green@1.1.0` with previous `1.0.0` → tags `:blue` from `localhost/dodo:1.0.0`, ends `{slot:'blue',version:'1.0.0',previous:'1.1.0'}`, no `podman run`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `release.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(platform): blue/green release and rollback (TASK-11)`.

### Task 7: Setup, build and the CLI

**Files:**
- Create: `platform/src/setup.ts`, `platform/src/sys.ts`, `platform/src/main.ts`, `platform/test/setup.test.ts`
- Modify: `bin/hawk`, `bin/hawk-update` (for podman apps, re-run `hawk setup <app>` when `/var/lib/hawk/apps/<app>.json` exists, in place of the `/opt/<app>/current` check), `.shellcheckrc` if needed

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `setup(name: string, checkout: string | undefined, sys: Sys, domain: string): Promise<void>` — with no checkout, uses the stored `/etc/hawk/apps/<app>.json`; user (`useradd --system`, as `cmd_setup` does), `install -d` `/var/lib/<app>` and `/var/backups/<app>` (owned by the app user), copy `<checkout>/deploy/hawk.json` to `/etc/hawk/apps/<app>.json` (validated), `ensureDb`, write units for the current live slot (blue if none) and `daemon-reload`, `systemctl enable --now` each job timer, sudoers file `/etc/sudoers.d/hawk-<app>` with the one `release` rule (check with `visudo -cqf`), then `caddy/setup.sh <app> 127.0.0.1:<live slot port>`.
  - `build(name: string, checkout: string, version: string, sys: Sys): Promise<void>` — as hawk-runner: `podman build --build-arg VERSION=<v> -f Containerfile -t localhost/<app>:<v> <checkout>`, `podman save -o /var/lib/hawk-images/<app>-<v>.tar`, copy `deploy/hawk.json` beside it, `podman rmi` the local tag.
  - `main.ts` commands: `setup <app> [checkout]`, `build <app>` (checkout = `git rev-parse --show-toplevel`, `VERSION` from env), `release <app> <version>`, `rollback <app> [version]`, `tasks <app> <version> ok|failed [error]`, `backup [app]` (all podman apps when none, `prune:true`), `state <app>` (prints the state JSON or `{}`). Errors print `error: <step>: <message>` and exit 1.
  - `bin/hawk`: `runtime()` reads `RUNTIME` from the app env. For podman apps: `setup`/`rollback` → `node $HAWK/platform/src/main.ts …` (root check stays in bash); `deploy` → `main.ts build` then `sudo hawk release <app> "$VERSION"`. New pass-through commands `release`, `tasks`, `backup`, `state`. Help text lists them.

- [ ] **Step 1: Write failing tests** for `setup` with a fake `Sys`: sudoers content is exactly `hawk-runner ALL=(root) NOPASSWD: /usr/local/bin/hawk release dodo *`; a bad `hawk.json` throws before any write; units are written for `blue` when there is no state. For `main.ts`: `release dodo 1.2` exits 1 with `error: version must look like 1.2.3`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `setup.ts`, `sys.ts` (`node:child_process` `execFile`, `fetch`, `fs`; `lock` via `fs.openSync('/run/<name>.lock','wx')` with release on exit), `main.ts`, and the `bin/hawk` routing.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && shellcheck bin/hawk` → PASS, no warnings.
- [ ] **Step 5: Commit** `feat(platform): setup, build and the hawk CLI for podman apps (TASK-11)`.

### Task 8: Install Podman and Postgres on the box

**Files:**
- Create: `containers/postgres.container`, `containers/hawk.network`
- Modify: `install.sh`

**Interfaces:**
- Produces on the box: running `postgres.service` (Quadlet), network `hawk`, database `apps` with `pg_trgm`, dirs `/var/lib/hawk/apps` (root), `/var/lib/hawk-images` (hawk-runner, 0750), `/etc/hawk/apps`, `/etc/hawk/db` (root, 0700), `hawk-backup.timer` enabled.

- [ ] **Step 1:** `postgres.container`: `Image=docker.io/library/postgres:17`, `ContainerName=postgres`, `Network=hawk.network`, `PublishPort=127.0.0.1:5432:5432`, `Volume=/var/lib/postgres:/var/lib/postgresql/data`, `EnvironmentFile=/etc/hawk/postgres.env`, `HealthCmd=pg_isready -U postgres`, `[Unit] OnFailure=hawk-notify@%N.service`, `[Install] WantedBy=multi-user.target`. `hawk.network`: `[Network] NetworkName=hawk`.
- [ ] **Step 2:** In `install.sh`, a `step "podman + postgres"` block: add `podman uidmap netavark aardvark-dns` to the required-tools path (`apt-get install -y` when `podman` is missing); give `hawk-runner` subuid/subgid ranges if it has none (`usermod --add-subuids 200000-265535 --add-subgids 200000-265535`); write `/etc/hawk/postgres.env` with a random `POSTGRES_PASSWORD` once (0600); install both files to `/etc/containers/systemd` with `cmp -s` like the systemd loop; `daemon-reload`; `systemctl start postgres`; wait up to 60 s for `podman exec postgres pg_isready -U postgres`; create database `apps` if missing and `CREATE EXTENSION IF NOT EXISTS pg_trgm`; make the dirs above; enable `hawk-backup.timer`. Postgres failing to start is `die` with `journalctl -u postgres`.
- [ ] **Step 3: Verify:** `shellcheck install.sh` → clean. On the box, after merge (Task 17 runs it): `sudo hawk-update` → ends with "Done."; `sudo podman exec postgres psql -U postgres -d apps -tAc "select extname from pg_extension"` lists `pg_trgm`; `ss -tlnp | rg 5432` shows only `127.0.0.1`.
- [ ] **Step 4: Commit** `feat: install podman and a shared postgres (TASK-11)`.

### Task 9: hawk page rows for podman apps and Postgres

**Files:**
- Modify: `bin/hawk` (`cmd_status`)

- [ ] **Step 1:** For podman apps, the Apps row uses `hawk state <app>` (via `jq`): Release column = `<slot> · <version>` with `at`; Rollback target = `previous`; Services = badges for `<app>-<slot>` and each worker unit. Systemd apps keep today's row.
- [ ] **Step 2:** Tools table: add `postgres` row: badge `postgres`, version from `podman exec postgres psql -U postgres -tAc 'show server_version'`, Data = `pg_size_pretty(pg_database_size('apps'))`, Links `-`. Each command gets `-m`/timeout-safe handling so a down Postgres prints `down`, not an error.
- [ ] **Step 3: Verify:** `shellcheck bin/hawk` → clean. `hawk status /tmp/x.html` on the box (Task 17) shows the dodo row with a slot and the postgres row.
- [ ] **Step 4: Commit** `feat: show podman apps and postgres on the hawk page (TASK-11)`.

### Task 10: README

**Files:** Modify: `README.md`

- [ ] **Step 1:** Rewrite "What it does", "Add an app" and "Ship a change" for the new flow: `RUNTIME=podman` in `apps/<app>.env`; app repo holds `Containerfile` + `deploy/hawk.json` (document every field from `AppSpec`) + migrations; merge to `main` is the only ship step; PR titles end in `(KEY-N)`; zero-downtime rule (add columns, do not rename or drop; else `"downtime": true`); `hawk rollback`, `hawk backup`, restore from a `.dump` (`pg_restore -n <app> --clean`); one org runner. Keep the systemd-app section short and marked "until project 2".
- [ ] **Step 2: Commit** `docs: readme for podman apps (TASK-11)`.

### Task 11: dodo on Postgres — connection, migrations, test DB

Repo: `~/Desktop/personal/dodo`, branch `feat/postgres-container`.

**Files:**
- Modify: `src/core/db.ts`, `src/cli/migrate.ts`, `package.json` (add `postgres@^3`), `vitest.config.ts` (`fileParallelism: false` only if tests collide), `scripts/dev.sh`
- Create: `src/core/testdb.ts`, `src/core/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Db = postgres.Sql | postgres.TransactionSql
  export const MIGRATIONS: string[]          // v1 = today's schema without FTS5 (see below)
  export function dbUrl(): string            // DATABASE_URL ?? 'postgres://postgres:dev@127.0.0.1:55432/postgres'
  export function connect(url?: string, schema?: string): postgres.Sql   // max 5; schema sets search_path `<schema>, public`
  export async function migrate(db: postgres.Sql): Promise<{ from: number; to: number }>
  export async function tx<T>(db: postgres.Sql, fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T>
  export async function changed(t: Db): Promise<void>   // SELECT pg_notify('dodo_changed', '')
  export const CHANNEL = 'dodo_changed'
  // testdb.ts
  export async function testDb(): Promise<{ db: postgres.Sql; drop(): Promise<void> }> // fresh schema test_<random>, migrated
  ```
- v1 SQL: `docs (id integer generated by default as identity primary key, path text not null, body text not null default '', created text not null, updated text not null, client_id text, deleted_at text, write_client_id text)`, same partial unique indexes, `doc_projects`, `files`, `files_doc` index, plus `CREATE INDEX docs_body_trgm ON docs USING gin (body gin_trgm_ops)`. Version table `schema_version (v integer not null)`. `migrate` holds `pg_advisory_xact_lock(hashtext('dodo'))` and keeps the "database is at migration N, this build only knows M" error.
- Startup no longer migrates (`openDb` is removed); only `dist/migrate.js` does.

- [ ] **Step 1: Write failing tests** in `db.test.ts`: `migrate` on a fresh schema → `{from:0,to:MIGRATIONS.length}`; a second run → `from === to`; with `schema_version` set to `MIGRATIONS.length + 1` → throws `/this build only knows/`; two `migrate` calls in parallel both succeed.
- [ ] **Step 2:** `scripts/dev.sh` starts `podman run -d --name dodo-dev-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=dev docker.io/library/postgres:17` when not running (and `podman start` when stopped), waits for `pg_isready`, creates `pg_trgm`, runs `node dist/migrate.js` (or `tsx src/cli/migrate.ts`). Tests read `TEST_DATABASE_URL ?? dbUrl()`.
- [ ] **Step 3: Run** `pnpm test src/core/db.test.ts` → FAIL.
- [ ] **Step 4: Implement** `db.ts`, `testdb.ts`, async `migrate.ts` (`console.log` stays, `await sql.end()`).
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(db): move to postgres with versioned migrations`.

### Task 12: dodo docs, files and cleanup on Postgres

**Files:**
- Modify: `src/core/docs.ts`, `src/core/files.ts`, `src/core/docs.test.ts`, `tsup.config.ts` (entries `migrate`, `cleanup`, `import-sqlite`)
- Create: `src/cli/cleanup.ts`, `src/core/files.test.ts`
- Delete: `src/cli/backup.ts`

**Interfaces:**
- Consumes: Task 11.
- Produces: every exported function in `docs.ts` and `files.ts` keeps its name and arguments and returns a `Promise` of today's type. Every write ends with `changed(t)` inside its transaction. `group_concat` → `string_agg(project, ',' ORDER BY project)`. `movePath` temp prefix `\x01` (Postgres text cannot hold `\0`).
- `cleanup.ts`: deletes files in `DODO_FILES` (default `/data/files`) with no `files` row and mtime older than 7 days. No DB backup (hawk does it).

- [ ] **Step 1:** Convert `docs.test.ts` to `await` with `testDb()` in `beforeEach` and `drop()` in `afterEach`. Add: `movePath` swap `x`→`z` passes (catches the `\0` case); `createDoc` sends a `NOTIFY` on `dodo_changed` (listen on a second connection, expect one message). Create `files.test.ts`: `removeFile` touches the file; `cleanup` removes an orphan older than 7 days and keeps a fresh one and a referenced one.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `refactor(core): docs and files on postgres`.

### Task 13: dodo search on pg_trgm

**Files:** Modify: `src/core/search.ts`, `src/core/search.test.ts`

**Interfaces:**
- Produces: `searchDocs(db: Db, index: DocIndex, q: string, opts?): Promise<Hit[]>`; `snippetOf(body: string, q: string, words = 12): string` (case-insensitive first match, about `words` words around it, `…` where cut).
- Body search (3+ chars): `body ILIKE '%' || $q || '%' ESCAPE '\'` with `%`, `_`, `\` escaped; order by `word_similarity($q, body) DESC`; project filter as today.

- [ ] **Step 1: Tests** (async): existing three pass; `snippetOf('a b c systemctl d e', 'SystemCtl')` contains `systemctl`; query `50%` does not match body `500 items`; query `a_b` does not match `axb`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(search): trigram search on postgres`.

### Task 14: dodo server state and routes

**Files:** Modify: `src/server/state.ts`, every `src/app/api/**/route.ts` that calls `getState`/`refresh`, `src/app/api/routes.test.ts`

**Interfaces:**
- Produces: `getState(): Promise<State>` (memoized promise on `globalThis.__dodo`; on first call connects, loads the index, and `db.listen(CHANNEL, () => refresh(state))`); `refresh(state): Promise<void>`. `State` stays `{ db, index, rev }`.

- [ ] **Step 1: Tests:** `routes.test.ts` uses `testDb()` and sets `globalThis.__dodo` from it. Add: a doc inserted through a second connection (simulating the other slot) appears in `GET /api/docs` within 2 s, and the ETag changes.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and `await` every call in the routes.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm build` → PASS.
- [ ] **Step 5: Commit** `feat(server): reload the index on postgres notify`.

### Task 15: dodo container, deploy config, CI and dev scripts

**Files:**
- Create: `Containerfile`, `.containerignore`, `deploy/hawk.json`, `src/cli/import-sqlite.ts`
- Delete: `deploy/*.service`, `deploy/*.timer`, `deploy/build.sh`, `deploy/hawk-setup.sh`
- Modify: `scripts/db-pull.sh`, `.github/workflows/pr.yml`, `.github/workflows/release.yml`, `README.md`, `CLAUDE.md` (deploy notes)

**Interfaces:**
- `deploy/hawk.json`:
  ```json
  {
    "web": { "command": ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"] },
    "migrate": ["node", "dist/migrate.js"],
    "jobs": { "cleanup": { "command": ["node", "dist/cleanup.js"], "schedule": "*-*-* 03:30:00" } },
    "env": { "NODE_ENV": "production", "DODO_FILES": "/data/files" },
    "tmpfs": ["/app/.next/cache"]
  }
  ```
- `Containerfile`: two stages on `docker.io/library/node:24-slim`. Build stage: `corepack enable`, `ARG VERSION`, `pnpm pkg set version=$VERSION`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm prune --prod`. Run stage copies `package.json`, `node_modules`, `.next`, `public`, `dist`; `WORKDIR /app`; no `CMD` needed (hawk passes `Exec=`).
- `import-sqlite.ts`: `node dist/import-sqlite.js <sqlite file>` — reads with `node:sqlite`, inserts `docs`, `doc_projects`, `files` with their ids in one transaction into an empty schema (refuses if `docs` has rows), resets the identity (`setval`), sets `schema_version` to the current version, and prints row counts for both sides; exits 1 if any count differs.

- [ ] **Step 1: Test** `import-sqlite` in `src/cli/import-sqlite.test.ts`: build a SQLite file with today's v2 schema (copy the old `MIGRATIONS` strings into the test), 3 docs (one deleted), 2 projects, 1 file; import into `testDb()`; counts match; `readDoc` returns the same body; a new `createDoc` gets id 4; a second import throws `/not empty/`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5:** `pr.yml`: replace the `title` job with `uses: andrew-personal-software/hawk/.github/workflows/pr-title.yml@main`; the `test` job (and `release.yml`'s) gets `services: postgres: image: postgres:17, env POSTGRES_PASSWORD: dev, ports 55432:5432, health options`, and a step `psql … -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'`. `release.yml` uses `andrew-personal-software/hawk/.github/workflows/release.yml@main`.
- [ ] **Step 6:** `db-pull.sh`: `ssh andrewj@andrewsserver 'sudo podman exec postgres pg_dump -Fc -U postgres -d apps -n dodo'` → restore into the dev container with `pg_restore --clean --if-exists -n dodo` into schema `dodo`, plus the existing `rsync` of `/var/lib/dodo/files/`. Local `DATABASE_URL` for dev uses schema `dodo`.
- [ ] **Step 7: Verify locally:** `podman build --build-arg VERSION=9.9.9 -t dodo-test .`; `podman run --rm -p 127.0.0.1:3999:3000 -e DATABASE_URL=… --read-only --tmpfs /tmp --tmpfs /app/.next/cache dodo-test node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000`; `curl -s localhost:3999/api/version` → `{"version":"9.9.9"}`.
- [ ] **Step 8: Commit** `feat(deploy): run dodo as a hawk podman app`. Do not merge yet: Task 17 merges it.

### Task 16: Wire the other apps' PR titles

**Files:** `.github/workflows/pr.yml` in `productivity`, `whiteboard`, `newsletter`

- [ ] **Step 1:** Replace each `title` job with `uses: andrew-personal-software/hawk/.github/workflows/pr-title.yml@main`. Nothing else changes; they stay systemd apps until project 2.
- [ ] **Step 2: Verify:** open the PR in each repo; both `title` and `task` jobs pass.
- [ ] **Step 3: Commit** in each repo `ci: check task keys in PR titles`.

### Task 17: Cutover dodo on the box

Manual runbook. Run in order; stop at the first failure.

- [ ] **Step 1:** Merge hawk `feat/containers`; on the box `sudo hawk-update`. Check Task 8 Step 3 and that sparrow, crow and budgie are still active (`systemctl is-active sparrow crow budgie-web budgie-worker`).
- [ ] **Step 2:** Planned stop. `sudo systemctl stop dodo dodo-backup.timer`; `sudo systemctl disable dodo dodo-backup.timer`; `sudo cp /var/lib/dodo/dodo.db /var/backups/dodo/dodo-pre-postgres.db`.
- [ ] **Step 3:** Set `RUNTIME=podman` in `apps/dodo.env` (hawk PR, `chore: move dodo to podman (TASK-11)`), merge, `sudo hawk-update`. Then `sudo -u hawk-runner git clone -b feat/postgres-container https://github.com/andrew-personal-software/dodo /tmp/dodo-import` and `sudo hawk setup dodo /tmp/dodo-import`. Fix ownership: `sudo chown -R dodo:dodo /var/lib/dodo`.
- [ ] **Step 4:** Build once by hand and import, before any slot serves the empty DB: `cd /tmp/dodo-import && sudo -u hawk-runner env VERSION=0.0.0 hawk build dodo`, `sudo podman load -i /var/lib/hawk-images/dodo-0.0.0.tar`, `sudo podman run --rm --network hawk --env-file /etc/hawk/db/dodo.env --user $(id -u dodo):$(id -g dodo) -v /var/lib/dodo:/data localhost/dodo:0.0.0 node dist/migrate.js`, then the same with `node dist/import-sqlite.js /data/dodo.db`. Expected: counts match. Then `sudo podman rmi localhost/dodo:0.0.0` and `sudo rm /var/lib/hawk-images/dodo-0.0.0.*`.
- [ ] **Step 5:** Merge dodo `feat/postgres-container`. The release workflow deploys it. Expected: job green; `hawk state dodo` shows a slot; `https://dodo.andrewminghanjiang.com` loads the same docs; the hawk page shows the dodo row and postgres row.
- [ ] **Step 6: Zero-downtime check.** On the box: `while :; do curl -s -o /dev/null -w '%{http_code}\n' https://dodo.andrewminghanjiang.com/api/version; sleep 0.2; done | tee /tmp/codes` in one shell. Merge a `fix:` PR to dodo whose title ends with a real task key. Expected: `/tmp/codes` holds only `200`; the slot flips; the task is done with a comment from `hawk`.
- [ ] **Step 7:** `sudo hawk rollback dodo` then let the next merge deploy again. Expected: both switch slots with only `200`s in the loop.
- [ ] **Step 8:** Clean up after 30 days (make a sparrow task with that due date): remove `/opt/dodo/releases`, `/var/backups/dodo/dodo-pre-postgres.db`, the old unit files in `/etc/systemd/system/dodo*`.
- [ ] **Step 9:** Comment the result on TASK-11.
