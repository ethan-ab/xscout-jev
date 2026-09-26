---
name: scout-setup
description: Set up xscout to watch X for the updates that matter to the user and alert them in Slack. Interviews the user, researches the accounts and keywords to follow, writes the YAML profile, checks it, replays a few past days, tunes it with the user's feedback, then schedules it. Use when someone wants to monitor X for news, launches, competitors or trends in a niche, set up xscout, create or rewrite an xscout profile, or says "set up xscout", "monitor X for", "watch X for", "alert me when".
---

# Set up xscout

xscout collects posts from X (through treg), has Jev judge each one against a profile (topic, significance, relevance, suggested actions), groups posts into events, and alerts when an event is big, trending or notable. Everything specific to the user lives in one YAML profile. Your job is to write that profile with the user, check it on real data, and schedule it.

Work through the steps in order. Ask one question at a time, and propose answers the user can accept or correct rather than asking open questions.

## 0. Find or install xscout

- If the current directory has a `package.json` whose `name` is `xscout`, use it.
- Otherwise ask where to put it (default `~/xscout`), then run `git clone https://github.com/ethan-ab/xscout-jev <dir>` and `pnpm install` in it. It needs Node.js 22.13 or later and pnpm.
- Run every command below from that directory.

Keys: the user needs a TypeSafe key (`TYPESAFE_API_KEY`, from typesafe.ai; an OpenRouter key also works with `TYPESAFE_BASE_URL=https://openrouter.ai/api`) and a treg account at treg.to, signed in with the treg CLI (`treg login`) or given as an API token in `TREG_TOKEN`. Copy `.env.example` to `.env` if it does not exist and ask the user to fill it in themselves; never ask them to paste a key into the chat.

## 1. Interview

Collect, in this order:

1. **Who the alerts are for**: the organisation or person and what they do, in two or three sentences. This becomes `org.about`, which the judge uses to decide relevance, so make it concrete (products, customers, market).
2. **What to watch**: the field in their words. Turn it into 2 to 5 topics, each with `what`, `not_for` (what looks similar but is noise) and 2 or 3 example posts. Show the draft topics and let the user correct them.
3. **What they will do with an alert**: publish content, brief sales, update a roadmap, react to a competitor. These become `actions` (one yes/no question each) and the `draft.template`.
4. **What to ignore**: competitors they do not want to amplify, promotional content, specific accounts. These become `exclude.blocklist` (names or handles) and/or `exclude.question`.
5. **Where and when**: Slack channel (they create an incoming webhook), timezone, whether to hold alerts at night and on weekends, and a daily budget in dollars.

Pick the closest example as a base: `profiles/starter.yaml` (ecosystem watch for a company), `profiles/competitive-intel.yaml` (competitor launches, pricing, funding, incidents) or `profiles/ai-apps.yaml` (the AI app ecosystem, the most tuned example). Read it before writing.

## 2. Research sources

- **primary**: official accounts whose posts matter from the first minute (companies, products, their leaders). 10 to 40 is typical.
- **amplifiers**: news accounts and newsletters that cover the field. Coverage by several of them is the strongest "big news" signal. 3 to 10.
- **keywords**: X search expressions for news that comes from accounts not listed. Quote multi-word terms, use uppercase `OR`, wrap OR groups in parentheses. Prefer specific names and phrases over generic words.

Find candidates with web search and your own knowledge, then let `validate --online` confirm them. Never invent a handle to fill a list.

Not every field lives on X. Some companies and markets post elsewhere or not at all. If `validate --online` reports most accounts as missing or inactive, say so plainly to the user: the scout will depend on keywords and news accounts, replay a longer window (`scan 168`) before judging it, and it may not be the right tool for this field.

## 3. Write and check the profile

1. Write `scout.yaml` (run `pnpm scout init <example>` first if that helps; it refuses to overwrite an existing file without `--force`). `docs/profile.md` documents every field.
2. Run `pnpm scout validate`. Fix every error; explain warnings to the user.
3. Run `pnpm scout validate --online`. It checks each account and keyword on X and costs a few cents.
   - "no original posts found": the handle is wrong, renamed or protected, or the account only replies. Check it on the web; fix or remove it.
   - "inactive: no original post in 30 days": the account exists but is quiet. Keep it only if it matters when it does post (a company that announces rarely).
   - Keywords report how many posts with enough likes they matched in 24 hours. "0" means the keyword is too narrow or `keyword_min_faves` too high; "20+" means it is busy, which is fine if the posts are relevant.

## 4. Replay the past and tune

A scan collects a past window into a new database and prints the alerts xscout would have raised, the database it wrote to, and the command to review it. Point every review command at that database with `SCOUT_DB=<scan database>`, otherwise they read the live one.

1. Tell the user the scan costs treg searches and Jev calls, in proportion to how many posts match. Start with a day and read the cost line before going further back: `pnpm scout scan 24` (`scan 72` gives a better picture).
2. Show the replayed alerts as a short list (time, tier, title, link) and ask:
   - which alerts are useless, and why;
   - which news from those days they expected and did not get.
3. Diagnose. The scan line shows how many posts the accounts and each keyword brought. Then:
   - `SCOUT_DB=<scan database> pnpm scout posts dropped`: what was dropped and why (off-topic, excluded, below the score floor), with the search that found each post (50 by default; add `--limit N` for more);
   - `... pnpm scout posts kept` and `... pnpm scout events`: what was kept and how it was grouped;
   - `... pnpm scout show <id>`: one event with its posts.

   If the scan raised no alert, that is common on a quiet day and does not mean the profile is wrong. Look at `posts kept` and the `below floor` lines of `posts dropped`: if relevant posts score just under the floor, lower `policy.alertThreshold` (it lowers the floor too) or give the topic a negative `threshold_offset`; if the field has few active official accounts, set `policy.notableMinAccounts: 1`; then scan again, over a longer window if the day was quiet (`scan 72`).

   Then fix what you find:
   - **Expected news never collected**: add the account or a keyword.
   - **Collected but dropped as off-topic**: sharpen the topic's `what` and add the missed post as an example.
   - **Kept but scored too low**: adjust the relevance levels, or give that topic a negative `threshold_offset`.
   - **Dropped as `excluded`**: the `exclude.question` is too broad; narrow it.
   - **Noise**: add to the topic's `not_for`, to `exclude`, give the keyword its own higher `min_faves`, or raise `policy.alertThreshold`.
4. Test again:
   - Raising thresholds or changing other `policy` settings: `SCOUT_DB=<scan database> pnpm scout replay` (free, reuses the stored judgments). `replay` ignores the daily cap, quiet hours and engagement, so it shows somewhat more alerts than live runs would.
   - Lowering `alertThreshold` or a `threshold_offset`, or changing topics, scoring, actions or exclusions, needs fresh judgments: run `pnpm scout scan 24` again, which writes to a new database. Posts already stored in a database are never judged again.
5. Stop when the user is happy with a day's alerts. Two or three rounds is normal.

If the user has a list of posts they would have wanted (or not), save it next to the profile as `<profile name>.labels.tsv` (the profile's `name` field), with a header row `expected	url	note` and one tab-separated line per post: `expected` is a topic id or `out`. Run `pnpm scout backtest` after each change to measure recall and false alerts.

## 5. Schedule

Follow `docs/deploy.md`. In short:

- Set `SLACK_WEBHOOK_URL` in `.env`.
- Quiet hours: `notify` holds alerts on weekday evenings (from 20:00 to 09:00 in the profile's timezone) and at weekends, and sends them afterwards. To send alerts at any hour, set `SCOUT_QUIET_HOURS=0` in `.env`; to change the hours, set `policy.quietStartHour` and `policy.quietEndHour`.
- Run `pnpm scout notify` once by hand. It prints the Slack message for new alerts (nothing when there is nothing new) and posts it to the webhook.
- Schedule `scripts/notify.sh` every 10 minutes with cron or launchd, with `SCOUT_DIR` set to the checkout, or use the GitHub Actions workflow in `deploy/github-actions.yml`.

Finish by telling the user how to use it day to day: run `pnpm scout show <id>` for the full event and its drafting prompt, `pnpm scout feedback <id> good|skip` to teach it, and `pnpm scout status` to check runs and spend. The `scout` skill helps with all of that.
