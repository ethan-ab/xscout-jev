# Benchmark

[`profiles/ai-apps.labels.tsv`](../profiles/ai-apps.labels.tsv) is a labelled set of 42 real X posts for the `ai-apps` example: 20 on one of its topics, 13 out of scope (`out`) and 9 marked `unknown`, which are ignored. It measures the part of xscout that works on a single post: the topic filter and the score. The coverage rules (official sources, news accounts, bursts, velocity) need several posts over time and are evaluated with `scan` and `replay` instead.

```bash
pnpm scout --profile profiles/ai-apps.yaml backtest
```

It fetches each post once through treg (cached in `data/<profile name>/backtest-cache.json`), asks Jev the profile's questions, and reports which on-topic posts would clear their topic's alert threshold on their own (`alertThreshold` plus the topic's `threshold_offset`) and which out-of-scope posts would.

## Results

Model `jev-1.13.0`, September 2026, two identical runs:

| Base threshold | Recall (on-topic posts) | False alerts (`out` posts) |
| --- | --- | --- |
| 2.5 | 17/20 | 0/13 |
| **3.0 (default)** | **11/20** | **0/13** |
| 3.5 | 5/20 | 0/13 |
| 4.0 | 3/20 | 0/13 |

Jev's scores can move by about 0.1 between runs for identical requests, so a post that sits right on a threshold may count in one run and not the next.

Single-post recall is deliberately conservative. Many on-topic posts that miss here still alert live, because a second account or a news account picks the story up.

## Making your own

Save a TSV next to your profile as `<profile name>.labels.tsv` (the profile's `name` field), with a header row and three tab-separated columns:

| Column | Content |
| --- | --- |
| `expected` | a topic id for posts you want alerts on, `out` for posts you do not, anything else to ignore the row |
| `url` | the post's URL (`https://x.com/<user>/status/<id>`) |
| `note` | a short description, shown in the output |

Then run `pnpm scout backtest` after each profile change. `--json` gives the same results as JSON.
