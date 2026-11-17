# hawk

Deploys and monitors the apps on the mini PC (`andrewsserver`). Each app runs as systemd services behind Caddy, on the tailnet only, at `https://<app>.andrewminghanjiang.com`.

## What it does

- **Registry.** `apps/<app>.env` holds each app's port, services and health path.
- **Deploys.** The reusable `release.yml` workflow tags a release, then the `hawk` runner runs `hawk deploy <app>`. That builds into `/opt/<app>/releases/<version>`, runs `<app>-predeploy` if the app has it, switches `/opt/<app>/current`, restarts, and checks the health path.
- **Rollback.** `sudo hawk rollback <app> [release]`.
- **Status page.** Gatus checks every app each minute at `https://status.andrewminghanjiang.com`.
- **hawk page.** `https://hawk.andrewminghanjiang.com`, rewritten each minute by `hawk status`: each app's live version, release, deploy time, rollback target and services, plus the runners, the last 7 days of alerts, disk and heartbeat.
- **Alerts and messages** go to Slack through `hawk-notifyd` (`POST http://127.0.0.1:3402/v1/messages`, routes in `notify/routes.ts`). Email is only for "Slack is down" (once per outage) and when `hawk-notifyd` itself is down (once per 30 min). Alerts that send them:
  - an app is down 3 checks in a row, or its cert expires in under 7 days (gatus, still by email);
  - any app service fails, including backups and predeploy (`OnFailure=hawk-notify@`);
  - the box stops sending heartbeats, or its disk is 90%+ full (healthchecks.io emails you itself).

## Install or update (mini PC)

```sh
git clone https://github.com/minghanminghan/hawk ~/hawk   # first time
cd ~/hawk && git pull && sudo ./install.sh
```

From a laptop checkout, `pnpm box:install` does the same over ssh. It asks for your sudo password on the box.

## Ship a change (laptop)

Commit on a feature branch, then run `pnpm ship [--task HAWK-12]`. It pushes, opens the PR, waits for CI, merges, runs `sudo hawk-update` on the box (hawk goes to `main`, then `hawk setup` re-runs for each app and restarts only services whose units changed), checks that every service is active, comments on the task and marks it done, then switches to `main`. Safe to re-run after a failure.

`hawk-update` needs no password: `install.sh` lets the user who ran it run `/usr/local/sbin/hawk-update` (no arguments) as root. It only deploys GitHub `main`, from a root-owned checkout in `/var/lib/hawk-src`. Run `pnpm box:install` once to set it up.

The first run makes `/etc/hawk/hawk.env` from `~/hawk/hawk.env` (git-ignored) if it exists, or asks for:

- `RESEND_API_KEY`, `EMAIL_FROM` (on a domain verified in Resend) and `EMAIL_TO`;
- `HC_PING_URL`: make a healthchecks.io check with a 5 min period and 10 min grace. It emails your account when pings stop.
- `SLACK_BOT_TOKEN` (optional, blank to set later; messages queue until it is set). Make a Slack app with the `chat:write` scope, install it to the workspace, put the bot token in `/etc/hawk/hawk.env`, restart `hawk-notifyd`, and invite the bot to each channel in `notify/routes.ts`.

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

1. In this repo, add `apps/<app>.env` with a free port. Merge, then `git pull && sudo ./install.sh` on the box.
2. In the app repo, add to `deploy/`:
   - `build.sh`: runs in the new release dir with `VERSION`, `APP` and `OPT` set. It installs and builds.
   - `<app>.service` and any other units. `@PORT@` and `@NODE_BIN@` are filled in. Read and write data only in `/var/lib/<app>` and `/var/backups/<app>`.
   - optional `<app>-predeploy.service`: a oneshot that backs up and migrates, run from `/opt/<app>/next`.
   - optional `hawk-setup.sh`: extra root setup, run by `hawk setup`.
   - The app must answer `GET <HEALTH>` with `{"version": "<VERSION>"}`.
3. Call the reusable workflow from the app's `.github/workflows/release.yml`:

   ```yaml
   jobs:
     test: ...
     hawk:
       needs: test
       uses: minghanminghan/hawk/.github/workflows/release.yml@main
       permissions:
         contents: write
       with:
         app: <app>
   ```

4. On the box: add a runner for the repo, then set up the app from a checkout:

   ```sh
   gh api -X POST repos/minghanminghan/<repo>/actions/runners/registration-token -q .token   # laptop
   sudo hawk runner https://github.com/minghanminghan/<repo> <token>
   sudo hawk setup <app> ~/<checkout>
   ```

5. Push to `main`. The release deploys itself.

GitHub shares one runner between repos only inside an org. Until the repos move to one, each repo needs its own `hawk runner` line. All of them use the `hawk` label.
