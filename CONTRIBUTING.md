# Contributing

Thanks for helping. Bug reports, profile examples for new fields and small focused pull requests are all welcome.

## Before you start

- For anything larger than a fix, open an issue first to agree on the approach.
- Read [AGENTS.md](AGENTS.md): it describes the layout and the few rules the code follows. The main one: nothing about a particular organisation goes in `src/`; it belongs in a profile.

## Working on the code

```bash
pnpm install
pnpm check    # typecheck, lint, tests
pnpm format
```

- Tests never call treg or Jev; pass a fake `fetch` like the existing tests do.
- If your change alters the questions sent to Jev, the snapshot in `tests/__snapshots__/profile.test.ts.snap` changes. Say so in the pull request, and include before/after numbers from `pnpm scout --profile profiles/ai-apps.yaml backtest` if you have keys.
- Keep commits focused, with a message that explains why.

## Sharing a profile

A profile for a new field makes a good example. Add it under `profiles/`: it becomes an `init` template and the tests validate it. Make sure `pnpm scout --profile <file> validate --online` passes, and describe in the pull request what it watches and how you tuned it.
