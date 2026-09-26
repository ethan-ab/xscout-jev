# Running xscout on a schedule

`pnpm scout notify` runs one cycle and is made for schedulers:

- it prints the Slack message for new alerts and nothing when there is nothing new;
- it posts that message to `SLACK_WEBHOOK_URL` when the variable is set;
- it exits with an error only when every search failed or Slack refused the message, so a flaky search or a spent budget does not page anyone. A message Slack refused is kept in `data/<profile name>/slack-pending.txt` and sent before the next one;
- it holds alerts during quiet hours (evenings and weekends, see `quietStartHour` and `quietEndHour` in the policy) unless `SCOUT_QUIET_HOURS=0`.

Run it every 10 minutes. Primary and amplifier accounts are searched on every run; keywords every `keyword_every_minutes` (30 by default).

xscout keeps its state in `data/<profile name>/` (a SQLite database and `alerts.jsonl`). Whatever runs it must keep that folder between runs.

## Slack

Create an [incoming webhook](https://api.slack.com/messaging/webhooks) for the channel and put its URL in `.env` as `SLACK_WEBHOOK_URL`. Check it with `pnpm scout notify` once by hand.

## cron (Linux, macOS)

`scripts/notify.sh` changes to the checkout and runs `notify`. Every 10 minutes, logging to a file:

```cron
*/10 * * * * SCOUT_DIR=/path/to/xscout /path/to/xscout/scripts/notify.sh >> /path/to/xscout/notify.log 2>&1
```

Put the keys in `.env`, and `SCOUT_PROFILE` too if your profile is not `scout.yaml`. cron has a minimal `PATH`; the script adds the usual Homebrew and `~/.local/bin` locations. If `node` or `pnpm` lives elsewhere (nvm, fnm, volta), add it to `PATH` in the script.

## launchd (macOS)

Save as `~/Library/LaunchAgents/com.xscout.notify.plist`, replace the paths, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xscout.notify.plist` (or the older `launchctl load <plist>`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.xscout.notify</string>
  <key>ProgramArguments</key><array><string>/path/to/xscout/scripts/notify.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>SCOUT_DIR</key><string>/path/to/xscout</string></dict>
  <key>StartInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>/path/to/xscout/notify.log</string>
  <key>StandardErrorPath</key><string>/path/to/xscout/notify.log</string>
</dict>
</plist>
```

A Mac that sleeps skips runs; the next run catches up on accounts for up to 24 hours, reading up to 100 posts per group of 12 accounts, and on keywords for `keyword_lookback_hours`.

## GitHub Actions

No machine to keep awake. Use a private copy of the repository (a fork of a public repository is public, and the profile you commit would be too), and enable Actions in its Actions tab. Then:

1. Copy `deploy/github-actions.yml` to `.github/workflows/scout.yml`.
2. Commit your profile: `git add -f scout.yaml` (it is ignored by default so it is not committed by accident).
3. Add repository secrets `TYPESAFE_API_KEY`, `TREG_TOKEN` (and `TREG_ORG` for identity tokens) and `SLACK_WEBHOOK_URL`. If you use `treg login` locally, the token is the `token` field of `~/.treg/config.json`; when that file has `"identity": true`, also set `TREG_ORG` to its `active_org`.
4. Run the workflow once from the Actions tab.

The state is carried between runs with the Actions cache. Keep in mind:

- GitHub can start scheduled runs several minutes late, and disables schedules on public repositories after 60 days without a commit.
- Each run saves a new cache entry; GitHub evicts the oldest ones once the repository reaches its cache quota, which is fine because only the latest is used.
- If the cache is ever lost, xscout starts fresh: it looks back an hour for accounts and a few hours for keywords, and may alert again on an event it had already reported.
- Runs cost Actions minutes on private repositories.

## Hermes

Copy `scripts/notify.sh` to `~/.hermes/scripts/`, set `SCOUT_DIR` to the checkout, and schedule it as a script-only job every 10 minutes. Hermes posts whatever the script prints, so you can leave `SLACK_WEBHOOK_URL` unset and let Hermes deliver the message.

## Checking on it

- `pnpm scout status`: last runs, events, alerts in the last 24 hours, spend against the budget.
- `pnpm scout costs`: spend per day.
- `data/<profile name>/alerts.jsonl`: every alert with its drafting prompt, one JSON object per line.

If `status` shows no recent run, look at the scheduler's log first, then run `pnpm scout notify` by hand to see the error.
