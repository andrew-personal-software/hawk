# hawk

Deploys and monitors the apps on the mini PC (`andrewsserver`). Apps run behind Caddy, on the tailnet only, at `https://<app>.andrewminghanjiang.com`. Podman apps (`RUNTIME=podman`) run as containers with their rows in one shared Postgres. The others still run as plain systemd services until they move (project 2).

## What it does

- **Registry.** `apps/<app>.env` holds each app's `PORT`, `HEALTH` path and `RUNTIME` (`podman`, or `systemd` when unset).
- **Deploys.** Every merge to `main` makes a release: the reusable `release.yml` tags it (`feat` is minor, `!` is major, every other type is patch), then the `hawk` runner runs `hawk deploy <app>`.
  - A podman app deploys **blue/green, with no downtime**: build the image, back up the schema, migrate, start the idle slot, check `HEALTH` on it, switch Caddy to it, wait 5 s, stop the old slot. The blue slot is on `PORT`, green on `PORT+1000`. If the migration or the health check fails, the live slot keeps serving and Caddy is not touched.
  - A systemd app builds into `/opt/<app>/releases/<version>`, runs `<app>-predeploy`, switches `/opt/<app>/current` and restarts (a short gap).
- **Task links.** After a deploy, hawk reads the task key at the end of each PR title in the release (`fix(modal-ui): close on escape (SPAR-12)`), comments `<app> <version> deployed` on the sparrow task and sets it to done. A failed deploy only comments. PR titles are checked by the reusable `pr-title.yml`: it fails when the key names a task sparrow does not know.
- **Rollback.** `sudo hawk rollback <app> [version]`. A podman app switches slots to the older image (default: the previous release). It does not touch the DB.
- **Postgres.** One Postgres 17 container (`postgres.service`, Quadlet) on `127.0.0.1:5432` and the podman network `hawk`. One database, `apps`; each app has its own schema and login role, made by `hawk setup`. Its `DATABASE_URL` is in `/etc/hawk/db/<app>.env` (root only).
- **Backups.** `hawk-backup.timer` runs `hawk backup` at 03:15: a `pg_dump` of each podman app's schema and a tarball of `/var/lib/<app>`, in `/var/backups/<app>`, 7 of each kept. Each deploy also dumps the schema before it migrates.
- **Status page.** Gatus checks every app each minute at `https://status.andrewminghanjiang.com`.
- **hawk page.** `https://hawk.andrewminghanjiang.com`, rewritten each minute by `hawk status`: each app's live version, slot or release, deploy time, rollback target and services, plus Postgres, the runners, the last 7 days of alerts, disk and heartbeat.
- **Alerts and messages** go to Discord through `hawk-notifyd` (`POST http://127.0.0.1:3402/v1/messages`, routes in `notify/routes.ts`). Email is only for "Discord is down" (once per outage) and when `hawk-notifyd` itself is down (once per 30 min). Alerts that send them:
  - an app is down 3 checks in a row, or its cert expires in under 7 days (gatus, still by email);
  - any app unit fails, including containers, Postgres, backups and predeploy (`OnFailure=hawk-notify@`);
  - the box stops sending heartbeats, or its disk is 90%+ full (healthchecks.io emails you itself).

## Install or update (mini PC)

```sh
git clone https://github.com/andrew-personal-software/hawk ~/hawk   # first time
cd ~/hawk && git pull && sudo ./install.sh
```

From a laptop checkout, `pnpm box:install` does the same over ssh. It asks for your sudo password on the box.

## Ship a change

**An app:** merge its PR to `main`. That is the only step. End the PR title with the task key, `(SPAR-12)`, to update the task.

**hawk itself** (laptop): commit on a feature branch, then run `pnpm ship [--task HAWK-12]`. It pushes, opens the PR, waits for CI, merges, runs `sudo hawk-update` on the box (hawk goes to `main`, then `hawk setup` re-runs for each set-up app), checks that every service is active, comments on the task and marks it done, then switches to `main`. Safe to re-run after a failure.

`hawk-update` needs no password: `install.sh` lets the user who ran it run `/usr/local/sbin/hawk-update` (no arguments) as root. It only deploys GitHub `main`, from a root-owned checkout in `/var/lib/hawk-src`. Run `pnpm box:install` once to set it up.

The first run makes `/etc/hawk/hawk.env` from `~/hawk/hawk.env` (git-ignored) if it exists, or asks for:

- `RESEND_API_KEY`, `EMAIL_FROM` (on a domain verified in Resend) and `EMAIL_TO`;
- `HC_PING_URL`: make a healthchecks.io check with a 5 min period and 10 min grace. It emails your account when pings stop.
- `DISCORD_BOT_TOKEN` (optional, blank to set later; messages queue until it is set). No privileged intents are needed.
  1. Discord Developer Portal → New Application → Bot → Reset Token. Put it in `/etc/hawk/hawk.env` as `DISCORD_BOT_TOKEN`.
  2. OAuth2 → URL Generator: scope `bot`, permissions View Channels + Send Messages. Open the URL and add the bot to your server.
  3. Run once (a bot must connect to the gateway before it can send): `sudo bash -c 'set -a; . /etc/hawk/hawk.env; node /opt/hawk/notify/scripts/discord-identify.ts'`
  4. Paste the channel IDs (Developer Mode → right-click channel → Copy Channel ID) into `notify/routes.ts`, then `sudo systemctl restart hawk-notifyd`.

  The Slack adapter is still in the code: add `slack:` targets and `SLACK_BOT_TOKEN` to use it.

`hawk tasks` runs as `hawk-runner`, which cannot read `hawk.env`. It reads sparrow's `SPARROW_HAWK_TOKEN` from its own file:
`sudo install -m 0640 -g hawk-runner /dev/null /etc/hawk/sparrow-hawk-token`, then put the value in it (same as `/etc/sparrow/sparrow.env`).

## Send a message

```sh
curl -fsS http://127.0.0.1:3402/v1/messages -d '{
  "topic": "sparrow.task.status",
  "title": "HAWK-8: in-progress → done",
  "body": "markdown, optional",
  "level": "info",
  "link": "https://example.com",
  "key": "sparrow:HAWK-8:done"
}'
```

`202 {"id": "msg_…", "status": "queued"}`. `GET /v1/messages/<id>` shows the delivery. `topic` is `<service>.<event>`; `level` is `info`, `warn` or `error`; `key` dedups.

## Add an app

1. In this repo, add `apps/<app>.env`: `PORT` (free, and `PORT+1000` free too), `HEALTH=/api/version`, `RUNTIME=podman`. Merge, then `sudo hawk-update` on the box.
2. In the app repo, add:
   - `Containerfile`. It takes `ARG VERSION` and bakes it in. The web service must answer `GET <HEALTH>` with `{"version": "<VERSION>"}` and listen on `PORT` (3000 in the container).
   - `deploy/hawk.json`, the app's deploy config:

     | Field | Meaning |
     |---|---|
     | `web.command` | the HTTP service (one at most). Deploys blue/green. |
     | `workers.<name>` | a command with no HTTP that must not run twice (stop, then start, on deploy). |
     | `jobs.<name>` | `{ "command": [...], "schedule": "<OnCalendar>" }`: a timer that runs the command in the live image. |
     | `migrate` | run once per deploy, before the new slot starts, against `DATABASE_URL`. |
     | `env` | extra `KEY: value` env. `DATABASE_URL` and `PORT` are set by hawk. |
     | `envFiles` | extra env files, only under `/etc/<app>/` (secrets). |
     | `tmpfs` | writable paths in the read-only container, like `/app/.next/cache`. |
     | `notify` | `true` mounts `/run/hawk-notify` read-only, so the app can post to `hawk-notifyd` at `/run/hawk-notify/notify.sock` (same API as `127.0.0.1:3402`). |
     | `downtime` | `true` for a release whose migration breaks the live version: hawk stops the app before it migrates, and starts it again if the backup or migration fails. |

     Commands are lists, like `["node", "dist/migrate.js"]`. Every container gets `DATABASE_URL`, `PORT=3000`, the host dir `/var/lib/<app>` at `/data` (uploaded files go there), a read-only root, `/tmp`, no capabilities, and runs as the app's system user.
   - Its migrations. **A migration must not break the live version**: add columns and tables, do not rename or drop them in the same release. If you must, set `"downtime": true` for that release.
   - Nothing else for deploys: no unit files, backup scripts, `build.sh` or `ship.sh`.
3. Call the reusable workflows. In `.github/workflows/release.yml`:

   ```yaml
   jobs:
     test: ...
     hawk:
       needs: test
       uses: andrew-personal-software/hawk/.github/workflows/release.yml@main
       permissions:
         contents: write
       with:
         app: <app>
   ```

   In `.github/workflows/pr.yml` (`on: pull_request` with `types: [opened, edited, synchronize, reopened]`):

   ```yaml
   jobs:
     title:
       uses: andrew-personal-software/hawk/.github/workflows/pr-title.yml@main
   ```

4. On the box, set up the app from a checkout: `sudo hawk setup <app> ~/<checkout>`. It makes the user, `/var/lib/<app>`, the Postgres role and schema, the units, the runner's sudo rule and the Caddy site. Safe to re-run.
5. Merge to `main`. The release deploys itself.

**Restore a backup:** stop the app's slot (`sudo systemctl stop <app>-blue <app>-green`), then `sudo podman exec -i postgres pg_restore -U postgres -d apps -n <app> --clean < /var/backups/<app>/<app>-<stamp>.dump`, then `sudo hawk rollback <app> <version>` to start the version that matches.

Other commands: `hawk state <app>` (live slot and version), `sudo hawk backup [app]`, `sudo hawk release <app> <version>` (what a deploy runs as root).

**systemd apps** (until project 2): `apps/<app>.env` also has `SERVICES`, and the app repo has `deploy/build.sh`, its unit files (`@PORT@` and `@NODE_BIN@` are filled in), an optional `<app>-predeploy.service` and `hawk-setup.sh`.

One org runner with the `hawk` label serves every repo in `andrew-personal-software`. A new repo needs no runner step. To add the runner again (one time):

```sh
gh api -X POST orgs/andrew-personal-software/actions/runners/registration-token -q .token   # laptop
sudo hawk runner https://github.com/andrew-personal-software <token>
```
