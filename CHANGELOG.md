# Changelog

## 0.1.0 (unreleased)

First public release.

- A YAML profile describes what to watch: topics, primary accounts, amplifiers, keywords, exclusions, significance and relevance scales, suggested actions, a drafting prompt, alert policy and daily budget. Three examples: `starter`, `competitive-intel` and `ai-apps` (with a labelled benchmark set).
- Collection from X through treg, judgments by Jev, grouping into events, and big, trending and notable alerts from deterministic rules.
- Commands: `init`, `validate` (with `--online` account and keyword checks), `poll`, `notify`, `watch`, `status`, `events`, `posts`, `show`, `feedback`, `costs`, `scan`, `replay` and `backtest`, with `--json` output.
- Slack delivery from `notify`, a daily budget, and TypeSafe-compatible gateways (OpenRouter, Vercel AI Gateway).
- Claude Code plugin with the `scout-setup` and `scout` skills.
- Deployment guides for cron, launchd, GitHub Actions and Hermes.
