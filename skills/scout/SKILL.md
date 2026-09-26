---
name: scout
description: Use xscout day to day. Review recent alerts and events, open an event with its sources, draft a post or brief from it, record good/skip feedback, check runs and spend, and adjust the profile when alerts are noisy or news is missed. Use when the user asks what xscout found, wants to act on an alert, says an alert was useless or something was missed, or wants to change what xscout watches.
---

# Use xscout day to day

Run every command from the xscout checkout (the directory whose `package.json` is named `xscout`). The profile is `scout.yaml`, or `SCOUT_PROFILE` from `.env`; pass another one with `--profile <file>`. Add `--json` when you need to read the output.

## What happened

- `pnpm scout status`: last runs, events by status, alerts in the last 24 h, spend today against the budget.
- `pnpm scout --json events alerted` (or `watch`, `held`, `open`): recent events. Summarise them as a short list: tier, topic, title, link.
- `pnpm scout --json show <id>`: one event with its posts and a ready drafting prompt.
- `pnpm scout posts dropped` (or `kept`): the 50 most recent posts (`--limit N` for more), the search that found each one, and why it was dropped. Use it when the user says something was missed.

If `status` shows no run for more than half an hour, the schedule stopped: check the cron job, launchd agent or GitHub Actions run (see `docs/deploy.md`), and `pnpm scout notify` by hand to see errors.

## Act on an alert

Read the event with `show`, then write what the user asked for (post, brief, email) from its `prompt` field. Use only facts in the listed posts and cite their URLs. Say so when the sources are thin, such as a single unofficial post.

## Teach it

- After the user reacts to an alert, record it: `pnpm scout feedback <id> good` or `skip`. When more than half of at least 6 feedbacks on alerts from the last 7 days are `skip`, xscout raises its alert threshold by 0.25 on its own.
- Keep a note of why an alert was useless or which news was missed; the fixes below need the reason, not just the verdict.

## Change what it watches

Edit the profile, then run `pnpm scout validate` (and `validate --online` after adding accounts or keywords).

| Problem | Change |
| --- | --- |
| News never collected | add the account to `sources.primary` or `sources.amplifiers`, or add a keyword |
| Collected but classified off-topic | sharpen the topic's `what`, add the post to its `examples` |
| Kept but scored too low | adjust `scoring.relevance.levels`, or set a negative `threshold_offset` on the topic |
| Same kind of noise again and again | add it to the topic's `not_for`, or to `exclude` |
| Too many alerts overall | raise `policy.alertThreshold` or lower `policy.dailyCap` |

To see the effect before it goes live:

- Raising thresholds or other `policy` changes: `pnpm scout replay` (free, reuses stored judgments; it ignores the daily cap, quiet hours and engagement, so it shows somewhat more alerts than live runs).
- Lowering a threshold, or changing topics, scoring, actions or exclusions: `pnpm scout scan 24` re-judges a day of posts in a new database (it costs a little) and prints how to review it.

Tell the user what you changed and why, and what the replay showed.
