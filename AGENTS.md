# xscout

A CLI that watches X for the updates that matter to one organisation and raises alerts. treg collects posts, Jev (TypeSafe's System One model) judges them against a YAML profile, and deterministic rules decide when an event is worth an alert.

## Layout

| Path | What it holds |
| --- | --- |
| `src/cli.ts` | Commands and argument parsing |
| `src/config.ts` | Engine constants and the default alert policy |
| `src/profile.ts` | Profile schema, validation, and compilation into a `Scout` |
| `src/questions.ts` | The shape of the Jev questions; their content comes from the profile |
| `src/pipeline.ts` | One run: collect, filter, score, group into events, decide, write alerts |
| `src/filter.ts` | Which judged posts are kept |
| `src/policy.ts` | Scoring and the alert rules (big, trending, notable) |
| `src/heat.ts` | Momentum from post timestamps and counts |
| `src/events.ts` | Matching a post to an open event |
| `src/replay.ts`, `src/backtest.ts` | Offline evaluation |
| `src/validate.ts` | Profile, key and keyword checks |
| `src/store.ts` | SQLite storage (`node:sqlite`) |
| `src/treg.ts`, `src/jev.ts`, `src/x.ts` | API clients |
| `src/notify.ts` | Slack formatting and webhook |
| `src/prompt.ts` | The drafting prompt attached to each alert |
| `src/types.ts` | Shared types |
| `profiles/` | Example profiles; `ai-apps.yaml` has a labelled benchmark set |
| `skills/` | Agent skills shipped with the plugin (`.claude/skills` links to them) |
| `tests/` | Vitest tests, one file per module |

## Commands

```bash
pnpm install
pnpm check      # typecheck, lint, tests: run before every commit
pnpm format     # apply formatting
TYPESAFE_API_KEY=x TREG_TOKEN=x pnpm scout --profile profiles/starter.yaml validate   # offline check; placeholder keys are enough
```

## Rules

- Nothing about a particular organisation belongs in `src/`. Put it in a profile.
- Code owns arithmetic, thresholds and state; Jev only answers typed questions. Do not move a decision that code can make into a question.
- `tests/__snapshots__/profile.test.ts.snap` pins the questions Jev receives for the `ai-apps` example. If a change updates it, say so in the commit: it changes every judgment. Check the effect with `pnpm scout --profile profiles/ai-apps.yaml backtest` (needs keys, costs cents).
- Tests never call treg or Jev: pass a fake `fetch`.
- Never commit `.env`, `data/` or a personal `scout.yaml`.
- Match the existing style: small modules, plain functions, comments only where the reason is not obvious.
