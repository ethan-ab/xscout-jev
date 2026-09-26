#!/usr/bin/env bash
# Scheduled job (cron, launchd, Hermes script-only…): set SCOUT_DIR to the repository path.
# Prints the Slack message for new alerts, nothing when there is nothing new.
set -euo pipefail
cd "${SCOUT_DIR:?set SCOUT_DIR to the xscout checkout}"
# Schedulers start with a minimal PATH: add where node and pnpm live if they are elsewhere (nvm, fnm, volta).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" NODE_NO_WARNINGS=1
exec pnpm -s scout notify
