# Profile reference

A profile is one YAML file that says what to watch and why. The engine reads it with `--profile <file>`, else `SCOUT_PROFILE`, else `scout.yaml`. `pnpm scout validate` checks it.

Complete examples: [`profiles/starter.yaml`](../profiles/starter.yaml) (commented), [`profiles/competitive-intel.yaml`](../profiles/competitive-intel.yaml) and [`profiles/ai-apps.yaml`](../profiles/ai-apps.yaml) (the most tuned example).

## How the fields are used

For every new post, Jev answers two sets of questions built from the profile:

1. **Filter**: which topic the post is about (one of `topics`, `other` or `off_topic`), who is speaking (maker, reporter, promoter, user, no product) and, if `exclude.question` is set, whether the post should be excluded. A post is kept when at least half of the topic probability falls on your topics, the speaker is not a promoter (posts from primary accounts are kept anyway), it is not excluded, and it does not match `exclude.blocklist`.
2. **Score**: `significance` and `relevance`, each a position on the levels you describe, from 0 to the number of levels minus one (0 to 3 with four levels), plus one yes/no answer per action. The post's score is significance + relevance (0 to 6 with four levels each).

A kept post whose score is below its topic's **floor** (the alert threshold, plus the topic's `threshold_offset`, minus `watchMargin`: 2.4 with the defaults) cannot start an event. It still counts as coverage of an event that already started (it adds an account to its momentum, not to its score); otherwise it is stored as dropped with the reason `below floor`. Lowering `alertThreshold` or a topic's `threshold_offset` lowers the floor too, for posts judged from then on: posts already dropped below the floor are not reconsidered, so check such a change with a new scan. `pnpm scout posts dropped` shows every dropped post and why.

Posts about the same update are grouped into an event, which takes the score of its best post. Its title is the text of its first post, replaced when a post from a higher-ranked source joins (a primary account, then an amplifier, then anyone else). Every alert needs that score to be at least the alert threshold minus `watchMargin`; above that, an event alerts when:

- **big**: its score reaches `majorThreshold` and it comes from a primary account, an amplifier or at least two accounts; or it is covered by several primary accounts, several amplifiers, or a burst of accounts;
- **trending**: it is young and spreading (a burst of accounts within 6 hours, or fast engagement);
- **notable**: its score reaches the alert threshold (`alertThreshold` plus the topic's `threshold_offset`), from a primary account or at least `notableMinAccounts` accounts (2), within the daily cap.

Fields where official accounts rarely post (most news comes through keywords) produce few notable alerts with the defaults; set `notableMinAccounts: 1` to let a single strong post through, and consider a lower `alertThreshold`.

## Fields

### `name` (required)

Letters, digits, `-` and `_`. Names the data folder: `data/<name>/`.

### `org` (required)

| Field | Content |
| --- | --- |
| `name` | organisation or person the alerts are for |
| `about` | two or three sentences on what they do. Given to Jev as context for relevance, exclusion and actions, so make it concrete. |

### `locale`

| Field | Default | Content |
| --- | --- | --- |
| `timezone` | `UTC` | IANA name, e.g. `Europe/Paris`. Used for quiet hours and displayed times. |
| `lang` | none | keyword searches only return posts in this language (e.g. `en`); without it they cover every language |

### `topics` (required, at least one)

| Field | Content |
| --- | --- |
| `id` | short identifier, e.g. `pricing`. `off_topic` and the `classification.other` id are reserved. |
| `label` | shown in alerts (defaults to the id) |
| `what` | what belongs in the topic |
| `not_for` | what looks similar but does not belong. The most effective way to cut noise. |
| `examples` | two or three real posts that belong. Strongly recommended. |
| `threshold_offset` | added to the alert threshold for this topic, e.g. `-1` for a topic that matters but scores lower |

### `classification`

| Field | Default | Content |
| --- | --- | --- |
| `question` | `Which topic is this X post mainly about?` | the topic question |
| `context` | generated from the number of topics | one or two sentences framing the choice |
| `other` | `{id: other, what: none of the topics above}` | related to your field but none of your topics |
| `off_topic` | `{what: unrelated to the topics we track}` | `what` and optional `examples` of noise |
| `speaker_examples` | neutral examples | replaces the example post for `maker`, `reporter`, `promoter` or `user` |

### `sources` (at least one account or keyword)

| Field | Default | Content |
| --- | --- | --- |
| `primary` | | official accounts, as `handle: who they are`. Searched on every run, no engagement floor. |
| `amplifiers` | | news accounts and newsletters, same format. Coverage by several of them is the strongest big-news signal. |
| `keywords` | | `name: X search expression`, or `name: {query: ..., min_faves: N}` to give one keyword its own likes threshold. Quote multi-word terms, use uppercase `OR`, parenthesise OR groups, and exclude words with `-word` (e.g. `-crypto`). |
| `keyword_min_faves` | `10` | minimum likes for a keyword match, for keywords without their own `min_faves`. Rare, important news (outages) needs a low value; busy topics a high one. |
| `keyword_lookback_hours` | `3` | window re-searched each time, so fresh posts can gather likes |
| `keyword_every_minutes` | `30` | how often keywords are searched |

Handles are written without `@` and are case-insensitive. The role text is given to Jev with each post from that account.

Each search reads the newest 20 matching posts. Account searches read further pages when needed to reach back to the previous run; a keyword that matches more than 20 posts per `keyword_every_minutes` misses the older ones, so keep keywords specific or raise `keyword_min_faves`.

A `scan` is a preview, not an exact replay of live polling: it searches accounts in groups of 4 and reads up to two pages (40 posts) of top posts per search over the whole window, so busy keywords are sampled.

### `exclude`

| Field | Content |
| --- | --- |
| `blocklist` | names or handles, matched as whole words (case-insensitive) in the text and the author. Dropped before any Jev call. |
| `question` | a yes/no question; posts Jev answers yes to (probability 0.6 or more) are dropped. Keep it narrow: a broad question ("is this about crypto?") also removes on-topic news. Check the `excluded` lines of `pnpm scout posts dropped` after a scan. |

### `scoring` (required)

`significance` (how big the update is for the field) and `relevance` (how much it matters to `org`), each with:

| Field | Content |
| --- | --- |
| `question` | what the scale measures |
| `focus` | optional, significance only: an extra instruction, e.g. to ignore hype |
| `levels` | at least two levels, lowest first, each with a `summary` and a list of `signals` |

With four levels the scale runs from 0 to 3.

### `actions`

What the reader could do with an alert. Each has an `id`, a `label` (defaults to the `id`) and a yes/no `question`. Actions answered yes with probability `actionMin` (0.6) or more are listed in `show`, in `alerts.jsonl` and in the drafting prompt.

### `draft`

`template`: the prompt printed with each alert, ready to paste into an assistant. Placeholders: `{org}`, `{about}`, `{title}`, `{actions}` (comma-separated, or "pick the best one"), `{sources}` (one line per post: author, URL, text). The default asks for a short social media post.

### `grouping`

`stopwords`: words common in your field that should not link unrelated posts into one event (e.g. `agent` when watching AI agents). Added to a built-in list of common English words.

### `policy`

Overrides of the alert rules. Defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `alertThreshold` | 3.0 | score for a notable alert |
| `majorThreshold` | 4.0 | score for a big alert when corroborated |
| `watchMargin` | 0.6 | events this far below the threshold are kept under watch |
| `minConfidence` | 0.5 | minimum significance confidence for a notable alert |
| `dailyCap` | 5 | notable alerts per rolling 24 hours (big and trending are not capped) |
| `quietStartHour`, `quietEndHour` | 20, 9 | quiet hours in `locale.timezone`; weekends are quiet too |
| `respectQuietHours` | false | hold alerts during quiet hours for `poll` and `watch` (`notify` holds them unless `SCOUT_QUIET_HOURS=0`) |
| `eventWindowHours` | 72 | how long an event can absorb new posts |
| `maxEventAgeHours` | 24 | no alert once an event's first post is older than this (`eventWindowHours` for an event held during quiet hours) |
| `noisyRejectRate`, `minFeedbackForTuning`, `thresholdStep` | 0.5, 6, 0.25 | with at least 6 feedbacks in 7 days and more than half `skip`, the threshold rises by 0.25 |
| `actionMin` | 0.6 | probability for an action to be suggested |
| `trendingMaxAgeHours` | 12 | trending only applies to events younger than this |
| `trendingBurst` | 3 | distinct accounts within 6 hours for trending |
| `trendingVelocity` | 300 | engagements per hour (likes + 2 × reposts + 3 × quotes) for trending |
| `bigBurst` | 6 | distinct accounts within 6 hours for big |
| `bigBurstWithPrimary` | 4 | the same, when a primary account is among them |
| `bigAmplifiers` | 2 | amplifiers covering the event for big |
| `bigPrimary` | 2 | primary accounts posting about the event for big |
| `notableMinAccounts` | 2 | accounts needed for a notable alert when no primary account posted; 1 allows a single post |

### `budget`

`usd_per_day`: spend from runs, scans, backtests and `validate --online` is recorded in the live database and counts toward this limit: a scan stops once today's total, live runs included, reaches it. Once today's treg and Jev spend (UTC day) reaches it, runs stop calling them and report it. When the budget is available again, account searches reach back to the posts left unjudged (up to `maxEventAgeHours`); keyword searches only reach back `keyword_lookback_hours`, so older keyword matches are not picked up.
