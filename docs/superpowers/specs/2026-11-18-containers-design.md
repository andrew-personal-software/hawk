# Containers, Postgres and zero-downtime deploys for hawk

Task: TASK-11. Related: HAWK-11 (org runner), HAWK-3 (replaced by this design).

## Why

hawk deploys sparrow, crow, budgie and dodo to the mini PC (`andrewsserver`) as plain systemd services, each with its own SQLite DB or files. Andrew wants three things:

1. **Ground for raptor.** raptor is a new service. It works on one-shot sparrow tasks and merges their PRs to `main`. The merge must deploy by itself, through hawk. raptor does no deploy work.
2. **One way to deploy.** Each app repo copies near-identical unit files, backup code and build scripts. That shared code moves into hawk. An app repo keeps only what is its own.
3. **Shared storage.** All app data goes in one Postgres server, so apps can read each other's data later. No integration is planned yet, but more will come.

A merge to `main` must deploy the app with **no downtime**, as long as the new version can share the DB with the old one.

## Goals

- Every app runs as a Podman container, built from a `Containerfile` in its repo.
- One Postgres server holds all app rows. Each app has its own schema and login.
- A deploy starts the new version next to the old one, checks it, moves traffic, then stops the old one. No failed requests in between.
- A merge to `main` is the only step needed to ship an app. No `pnpm ship` in app repos.
- After a deploy works, hawk updates each sparrow task named in the release's PR titles.
- The hawk page, gatus and Discord alerts keep working for containers and for Postgres.

## Non-goals

- PR previews. A deploy always replaces the live app.
- Zero downtime for a release whose migration breaks the old version. That release may stop the app briefly.
- An image registry. Images build on the box.
- Moving gatus, mlflow or hawk-notifyd into containers.
- Moving mlflow to Postgres (it can follow later).
- Building raptor. This design only gives raptor what it needs.
- Any app-to-app integration.

## Anti-goals

- Losing data while moving apps from SQLite to Postgres.
- Alerts that go quiet. If Podman or Postgres breaks, Discord (or the email fallback) must still say so.
- Postgres or any app reachable from outside the box. Apps stay on the tailnet behind Caddy, as now.
- A runner with broad root. The runner gets narrow sudo rules, as it does today.

## What exists now

Read `README.md`, `bin/hawk`, `install.sh`, `caddy/setup.sh` and `.github/workflows/release.yml` in this repo. In short:

- `apps/<app>.env` holds `PORT`, `SERVICES` and `HEALTH`.
- Push to `main` → reusable `release.yml` → semantic-release tag → job on the `hawk` runner → `hawk deploy <app>`.
- `hawk deploy` builds into `/opt/<app>/releases/<version>`, runs `<app>-predeploy` (backup + migrate), switches `/opt/<app>/current`, restarts the services, and checks `GET <HEALTH>` returns `{"version": "<VERSION>"}`. There is a gap while the services restart.
- `hawk setup` installs each app's `deploy/*.service|*.timer` with an `OnFailure=hawk-notify@%N.service` drop-in.
- Caddy serves `https://<app>.andrewminghanjiang.com` from `/etc/caddy/sites/<app>.caddy`, bound to the tailscale IPs only.
- Box: Ubuntu 24.04, 22 cores, 30 GB RAM, 63 GB free on `/`. Node 24, uv and pnpm installed. No Podman yet; apt has Podman 4.9.3.
- Repos now live in the `andrew-personal-software` GitHub org. HAWK-11 moves to one org runner and fixes the old `minghanminghan` links. Do HAWK-11 first.

Per app (the app repo is in `~/Desktop/personal/<dir>`):

| App | Dir | Data today | Notes |
|---|---|---|---|
| sparrow | `productivity` | SQLite via `node:sqlite` (sync) + `attachments/` | Keeps an in-memory index (`src/server/state.ts`) and pushes live updates over SSE from the same process. Closes SSE streams on SIGTERM. Has `scripts/ship.sh`. |
| dodo | `dodo` | SQLite via `node:sqlite` + `files/` | FTS5 trigram search table (`docs_fts`). Same in-memory pattern. |
| crow | `whiteboard` | one `<id>.canvas` JSON file per board + `assets/` | `src/lib/store.ts` (150 lines, async). Conflict check is a hash of the file. |
| budgie | `newsletter` | SQLite via SQLAlchemy + Alembic | Two services: `budgie-web` (HTTP) and `budgie-worker` (scheduler). Embeddings stored as `LargeBinary`. Secrets in `/etc/budgie/budgie.env`. |

## Decisions Andrew made

- **Podman**, not Docker. Containers run as systemd units through **Quadlet**, so `OnFailure`, `journalctl -u` and the hawk page badges keep working.
- **Postgres**, not MariaDB. One server for every app. Each app gets its own schema and login.
- **crow boards move to Postgres.** No one edits `.canvas` files by hand.
- **Rule for all apps:** rows go in Postgres, uploaded files (sparrow attachments, dodo files, crow assets) stay as files on a volume.
- **raptor merges the PR to `main`.** That push starts the hawk deploy, as today.
- **Keep the GitHub runner as the trigger.** The box is tailnet-only, so GitHub cannot call in.
- **gatus, mlflow and hawk-notifyd stay plain systemd services.** The watcher must not depend on what it watches.
- **Images build on the box** from the runner. No registry.
- **dodo is the pilot app.** It has the smallest DB code.
- **The one-time SQLite → Postgres move per app may have a short planned stop.** Normal deploys after that have zero downtime.
- **Task links come from PR titles.** Conventional commits stay. The task key goes at the end in brackets, and the scope stays descriptive: `fix(modal-ui): close on escape (SPAR-12)`. PRs are squash-merged, so the title is the commit subject on `main` (GitHub appends ` (#N)`).
- **Every merge to `main` makes a release.** Today `release.yml` releases only on `feat` and `fix`. Change its default `releaseRules` so every other conventional type (`docs`, `chore`, `refactor`, `test`, `ci`, `style`, `build`, `perf`, `revert`) makes a patch release. `feat` stays minor and `!` stays major. So every merge deploys, and every merged task gets updated.
- **No `pnpm ship` in app repos.** hawk keeps its own `pnpm ship`, because hawk deploys itself through `hawk-update`.

## The design

### Projects and order

1. **hawk platform + dodo pilot** (this document): Podman, Postgres, the new deploy flow, task links, and dodo fully moved.
2. **Move sparrow, crow and budgie** onto the platform, one at a time. Each gets its own short plan. Notes for them are at the end.
3. **raptor**, its own brainstorm. It only needs: "merge to `main` deploys, and the task gets updated".

### Postgres

- One Postgres server, run as a Quadlet container managed by hawk (`install.sh`), with its data on a host volume under `/var/lib/postgres`. Pin the major version (17).
- Listens on `127.0.0.1` only (and on whatever Podman network the apps use). Never on the tailscale IPs.
- One database, `apps`. Each app gets a schema named after it and a login role that owns only that schema. Later, one app can read another with a `GRANT`.
- `hawk setup <app>` creates the role and schema if missing, makes a random password, and writes the connection string to a root-owned env file that the app's containers read (`DATABASE_URL`).
- Backups: hawk owns them now. A nightly hawk timer runs `pg_dump` per schema into `/var/backups/<app>/`, keeps the 7 newest, and tars the app's file volume (if any) next to it. The per-app `*-backup.service|timer` units and backup scripts go away.
- An `OnFailure` alert and a hawk page row cover Postgres (state, version, DB size per schema).

### What an app repo holds

- `Containerfile`: builds the app image. It takes `VERSION` as a build arg and bakes it in, so `GET <HEALTH>` returns it.
- `deploy/app.toml` (or extend `apps/<app>.env` in hawk; builder's call which side owns what, as long as the app repo keeps only app-specific facts): the services, which is the web service, the health path, the migrate command, the file volume path, extra env files.
- The app's own migrations, run by its migrate command against `DATABASE_URL`.
- Nothing else for deploys. No unit files, no backup scripts, no `build.sh`, no `ship.sh`.

hawk holds everything shared: the Quadlet templates, the hardening options, the backup job, the deploy and rollback logic, the Caddy wiring.

### Two kinds of services

- **web**: serves HTTP behind Caddy. Deploys blue/green (below). Each app has one at most.
- **worker**: no HTTP (budgie-worker). Must not run twice at once. Deploys stop-then-start; a short gap is fine.
- **job** (builder's call, from the review): a one-off command run on a schedule from the live image, as a timer + oneshot container. Example: dodo's nightly cleanup in `src/cli/backup.ts` deletes orphan upload files older than 7 days. That cleanup stays, as a job, after hawk takes over the backup itself.

### Deploy flow (zero downtime)

Each web service has two slots, **blue** and **green**, each on its own fixed `127.0.0.1` port. One slot is live. A deploy:

1. **Build** the image `<app>:<version>` from the tag checkout (`podman build`).
2. **Back up** the app's schema (`pg_dump`).
3. **Migrate**: run the new image's migrate command once, as a one-off container. If it fails, stop here. The live slot is untouched.
4. **Start** the idle slot with the new image.
5. **Check** `GET <HEALTH>` on the idle slot until it returns the new version (30 s limit). If it fails, stop the idle slot, keep the live one, fail the deploy.
6. **Switch** Caddy's upstream for `<app>.<domain>` to the new slot, with a graceful reload (no dropped connections).
7. **Drain**: wait a few seconds for in-flight requests on the old slot, then stop it. SIGTERM closes open SSE streams, so browsers reconnect to the new slot and rebuild their state.
8. **Workers**: stop the old worker, start the new one.
9. **Record** the live slot and version, prune old images (keep the 3 newest per app).
10. **Link tasks** (below).

Rule for app authors: a migration must not break the version that is still live. Add columns, do not rename or drop them in the same release. A release that cannot follow this rule may use a stop-migrate-start deploy (a flag in the app's deploy config).

sparrow and dodo keep an in-memory index that loads at startup and reloads only after the same process writes. Writes that land on the old slot during steps 4–7 would be missing from the new slot's index until its next write. Contract (builder's call, from the review): any app that caches DB state in memory listens for a per-app Postgres `NOTIFY` channel and reloads on it; every write sends `NOTIFY`. This also covers two processes at once in general, and is the first use of the app-to-app event path. dodo does this in the pilot; sparrow in project 2.

Old browser tabs (builder's call, from the review): after a switch, a tab on the old Next.js build may ask for old `/_next/static/<hash>` chunks and get a 404. Next.js then does a full page load, which gets the new build. That is acceptable. "No failed requests" is measured by the curl loop in the pilot's done check, not by old tabs.

### Rollback

`sudo hawk rollback <app> [version]` runs steps 4–8 with an older image. It does not touch the DB. It prints the same warning as today: if a migration changed the DB, restore a backup first.

### Task links

- Every merge makes a release (see decisions), so the task step always runs after a deploy. No separate job on push is needed.
- After a deploy works, hawk lists the commit subjects between the previous release tag and the new one.
- From each subject it reads a task key at the end, before GitHub's ` (#N)`: pattern `\(([A-Z]+-[0-9]+)\)( \(#[0-9]+\))?$`.
- For each key it calls sparrow's API on the box (`POST /api/tasks/<KEY>` with body `{"op": {...}}`): `addComment` with `"<app> <version> deployed"` and a link to the GitHub release, then `setStatus` `done`. This route and both ops exist today (`productivity/src/app/api/tasks/[id]/route.ts`, `src/core/ops.ts`). It needs no token: sparrow is tailnet-only. hawk can call `http://127.0.0.1:3417` directly. A comment with no `author` gets the Tailscale user or the board user; hawk sets `author: "hawk"`.
- If a deploy fails, hawk comments the error on the tasks in that release and does not change status.
- A key that sparrow does not know: hawk posts a `warn` message to hawk-notifyd and goes on.
- Commits with no key: skipped.
- `pr.yml` in each app: the title regex allows an optional ` (KEY-N)` suffix. A second job, on the `hawk` runner (so it can reach sparrow), fails if the key names a task that does not exist. This job reads only the title; it checks out no code.

### Monitoring

- Quadlet units get the same `OnFailure=hawk-notify@%N.service` drop-in as today's units.
- The hawk page shows, per app: live version, live slot, deploy time, rollback image, services. Add a Postgres row to the Tools table.
- gatus keeps checking `https://<app>.<domain><HEALTH>`, which now hits whichever slot is live.

### Local dev and CI

- CI tests run against a Postgres service container in the GitHub workflow.
- Locally, each app's `dev` script starts a Postgres container with Podman (`podman machine` on the Mac) if one is not running.
- `scripts/db-pull.sh` in sparrow and dodo becomes a `pg_dump` of that app's schema over ssh, restored into the local Postgres.

### dodo pilot

- Write dodo's `Containerfile` and deploy config.
- Move `src/core/db.ts` and its callers from `node:sqlite` to a Postgres client. Calls become async.
- Replace the FTS5 trigram table with Postgres trigram search (`pg_trgm`), and keep current search behavior.
- One-time move: stop dodo, back up the SQLite DB, copy every row into Postgres, check row counts match, deploy the container version, start. Keep the SQLite file and old `/opt/dodo/releases` for 30 days.
- Remove dodo's old `deploy/*.service|*.timer`, backup code and `build.sh`.
- Done when: a `fix:` PR merged to `main` deploys dodo with no failed requests while a loop of `curl` calls hits it, and its task (if any) moves to done.

## Notes for project 2 (not this document)

- sparrow: same move as dodo. Its CLI talks to the HTTP API, so it does not change. Remove `scripts/ship.sh`.
- crow: each board becomes a row with a JSON (`jsonb`) column. The conflict check becomes a stored version column. `assets/` stays as files.
- budgie: point `DATABASE_URL` at Postgres; Alembic migrations need a Postgres pass. Keep embeddings as `bytea`. `budgie-worker` is a worker service. `/usr/local/bin/budgie` should run the CLI in the current image.

## Calls left to the builder

- Podman network layout, as long as Postgres and apps are not reachable off the box.
- Rootful system Quadlets vs rootless. Recommended: rootful in `/etc/containers/systemd` with `UserNS=auto`, so units are normal system units and each container runs as an unprivileged user.
- How blue/green maps to Quadlet files. Podman 4.9 has no Quadlet templates (`@.container`), so hawk will likely write `<app>-blue.container` and `<app>-green.container`.
- How Caddy switches upstream: rewrite the site file and `caddy reload`, or the admin API on `127.0.0.1:2019`.
- How the runner gets narrow root for `podman build` and the slot switch (a single `hawk-deploy` sudo entry is the expected shape).
- Port numbers for the slots.
- Where the deploy config lives and its format.
- Postgres client library per language, and how it keeps `node:sqlite`-style code readable.
- Drain wait length.
