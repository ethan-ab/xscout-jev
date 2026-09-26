import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backtest } from "./backtest";
import { PROMPT_POSTS } from "./config";
import { deliverToSlack, formatSlack, TIER } from "./notify";
import { runPoll } from "./pipeline";
import { adjustedThreshold } from "./policy";
import { loadScout, type Scout } from "./profile";
import { draftPrompt } from "./prompt";
import { replay } from "./replay";
import { Store } from "./store";
import { STATUSES } from "./types";
import { type Check, checkOffline, checkOnline } from "./validate";

if (existsSync(".env")) process.loadEnvFile(".env");

const USAGE = `usage: scout [--profile <file>] [--json] <command>

Setup
  init [template] [--output <file>] [--force]   copy an example profile (default: starter) to scout.yaml
  validate [--online]                           check the profile, keys and keyword syntax; --online also checks
                                                every account and keyword on X (a few cents of treg calls)

Running
  poll                  one collection and decision cycle
  notify                poll for a scheduler: prints the Slack message for new alerts (--json: the alerts)
                        and posts it when SLACK_WEBHOOK_URL is set; prints nothing when there is nothing new.
                        Holds alerts on weekday evenings and weekends unless SCOUT_QUIET_HOURS=0
  watch [minutes]       poll every N minutes (default 10)

Reviewing
  status                last runs, events, alerts, spend
  events [status]       list events (open, watch, held, alerted, dropped)
  posts [kept|dropped] [--limit N]
                        collected posts, newest first: which search found them, kept or dropped, and why
  show <id>             an event, its posts and its drafting prompt
  feedback <id> good|skip
  costs                 daily treg and Jev spend

Tuning
  scan [hours]          collect a past window (default 168) into a new database and replay it
  replay                when each stored event would have been flagged live
  backtest [labels]     recall and false alerts on a labelled TSV (expected, url, note)

The profile comes from --profile, else SCOUT_PROFILE, else scout.yaml.
Data goes to data/<profile name>/ (SCOUT_DB overrides the database path).`;

// Flags may appear anywhere (--name value or --name=value); everything else is positional.
const VALUED = new Set(["profile", "output", "limit"]);
const SWITCHES = new Set(["json", "online", "force", "help"]);
function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (VALUED.has(name)) {
      const value = inline ?? argv[++i];
      if (!value) throw new Error(`--${name} needs a value`);
      flags[name] = value;
    } else if (SWITCHES.has(name) && inline === undefined) flags[name] = true;
    else throw new Error(`unknown option ${a}\n\n${USAGE}`);
  }
  return { flags, positional };
}

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { flags, positional } = parsed;
const [command = "help", ...args] = positional;
const json = flags.json === true;
const usd = (x: number) => `$${x.toFixed(4)}`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const minutes = (m: number) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const print = (data: unknown, text: () => void, compact = false) =>
  json ? console.log(compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) : text();

function templates(): Record<string, string> {
  const files = existsSync("profiles") ? readdirSync("profiles").filter((f) => f.endsWith(".yaml")) : [];
  return Object.fromEntries(files.map((f) => [basename(f, ".yaml"), join("profiles", f)]));
}

function init() {
  const name = args[0] ?? "starter";
  const all = templates();
  const from = all[name];
  if (!from) throw new Error(`unknown template "${name}"; available: ${Object.keys(all).join(", ")}`);
  const to = typeof flags.output === "string" ? flags.output : "scout.yaml";
  if (existsSync(to) && flags.force !== true) throw new Error(`${to} already exists; pass --force to overwrite`);
  copyFileSync(from, to);
  loadScout(to);
  const profileFlag = to === "scout.yaml" ? "" : ` --profile ${to}`;
  console.log(
    [
      `wrote ${to} from ${from}`,
      "",
      "next: edit it (docs/profile.md describes every field), then run",
      `  pnpm scout${profileFlag} validate            # profile, keys and keyword syntax`,
      `  pnpm scout${profileFlag} validate --online   # every account and keyword on X (a few cents)`,
      `  pnpm scout${profileFlag} scan 24               # the alerts you would have had over the last day`,
      "",
      "or open Claude Code here and ask it to set up xscout: the scout-setup skill walks you through it.",
    ].join("\n"),
  );
}

function loadProfile(): { scout: Scout; file: string } {
  const file = typeof flags.profile === "string" ? flags.profile : (process.env.SCOUT_PROFILE ?? "scout.yaml");
  if (!existsSync(file)) throw new Error(`no profile at ${file}: run \`pnpm scout init\` or pass --profile <file>`);
  return { scout: loadScout(file), file };
}

async function main() {
  if (command === "help" || flags.help === true) return console.log(USAGE);
  if (command === "init") return init();

  const { scout, file } = loadProfile();
  const dataDir = join("data", scout.profile.name);
  const liveDb = join(dataDir, "scout.db");
  const dbPath = process.env.SCOUT_DB ?? liveDb;
  const alertsFile = join(dirname(dbPath), "alerts.jsonl");
  const open = (path = dbPath) => new Store(path);
  const time = (utc: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: scout.profile.locale.timezone, dateStyle: "medium", timeStyle: "short" }).format(
      utc * 1000,
    );

  function report(store: Store, threshold: number, extra: object = {}) {
    const flagsList = replay(scout, store, threshold);
    print({ ...extra, alerts: flagsList }, () => {
      console.log(`\n${flagsList.length} alerts (replayed as if polled live)`);
      for (const f of flagsList) {
        console.log(`\n${time(f.flaggedUtc)}  ${TIER[f.tier]}  [${f.topic}]  ${f.title.slice(0, 110)}`);
        console.log(`  ${f.url}`);
        console.log(`  ${f.why} · ${minutes(f.lagMin)} after first post · ${f.accounts} accounts · ${f.updates.length} updates`);
      }
    });
  }

  // `watch` prints one compact JSON document per line.
  async function poll(store: Store, compact = false) {
    const r = await runPoll(scout, store, { alertsFile });
    const { alerts, errors, ...counts } = r;
    print(
      { ...counts, alerts, errors },
      () => {
        console.log(
          `[${new Date().toISOString()}] fetched ${r.fetched} · new ${r.fresh} · kept ${r.kept} · events ${r.events} · alerts ${alerts.length} · treg ${usd(r.tregUsd)} · jev ${usd(r.jevUsd)}`,
        );
        for (const a of alerts)
          console.log(`  ${a.kind === "update" ? "UPDATE" : TIER[a.tier]} #${a.eventId} [${a.topic}] ${a.title.slice(0, 100)}`);
      },
      compact,
    );
    for (const e of errors) console.error(`  error: ${e}`);
  }

  const commands: Record<string, () => Promise<void> | void> = {
    async validate() {
      const checks: Check[] = checkOffline(scout);
      let tregUsd = 0;
      if (flags.online === true && !checks.some((c) => c.level === "error" && c.where === "env")) {
        const online = await checkOnline(scout);
        checks.push(...online.checks);
        tregUsd = online.tregUsd;
        open(liveDb).addCost(new Date(), tregUsd, 0); // all spend is recorded in the profile's live database
      }
      const errors = checks.filter((c) => c.level === "error").length;
      print({ profile: file, ok: errors === 0, checks, tregUsd }, () => {
        console.log(
          `${file}: ${count(scout.topics.length, "topic")}, ${count(scout.primary.size, "primary account")}, ${count(scout.amplifiers.size, "amplifier")}, ${count(Object.keys(scout.profile.sources.keywords).length, "keyword")}`,
        );
        for (const c of checks) console.log(`  ${c.level.padEnd(7)} ${c.where}: ${c.message}`);
        if (tregUsd) console.log(`  online checks cost ${usd(tregUsd)}`);
        const warnings = checks.filter((c) => c.level === "warning").length;
        console.log(
          errors
            ? `\n${errors} error(s): fix them before running`
            : `\nok: no errors${warnings ? `, ${warnings} warning(s) to review` : ""}`,
        );
      });
      if (errors) process.exitCode = 1;
    },

    poll: () => poll(open()),

    // For schedulers (cron, launchd, Hermes…): stdout is the Slack message (--json: the alerts), empty when nothing is new.
    // Exits non-zero only when every search failed or Slack refused the message, so transient errors do not page anyone.
    async notify() {
      const r = await runPoll(scout, open(), { alertsFile, quietHours: process.env.SCOUT_QUIET_HOURS !== "0" });
      for (const e of r.errors) console.error(e);
      if (r.searches > 0 && r.failedSearches === r.searches) process.exitCode = 1;
      const message = formatSlack(scout, r.alerts);
      if (json) {
        if (r.alerts.length) console.log(JSON.stringify(r.alerts, null, 2));
      } else if (message) console.log(message);
      // A message Slack refuses is kept and sent first next time, so no alert is lost.
      if (process.env.SLACK_WEBHOOK_URL)
        await deliverToSlack(process.env.SLACK_WEBHOOK_URL, message, join(dirname(dbPath), "slack-pending.txt"));
    },

    async watch() {
      const every = Number(args[0] ?? 10);
      if (!(every > 0)) throw new Error("usage: scout watch [minutes]");
      const store = open();
      for (;;) {
        await poll(store, true).catch((e: Error) => console.error(`poll failed: ${e.message}`));
        await new Promise((r) => setTimeout(r, every * 60_000));
      }
    },

    async scan() {
      const hours = Number(args[0] ?? 168);
      if (!(hours > 0)) throw new Error("usage: scout scan [hours]");
      // A new database per scan by default: a scan into a database that already holds posts skips the ones it has judged.
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const scanDb = process.env.SCOUT_DB ?? join(dataDir, `scan-${stamp}.db`);
      const store = open(scanDb);
      const r = await runPoll(scout, store, { scanHours: hours, spentToday: open(liveDb).costOn(new Date()) });
      if (scanDb !== liveDb) open(liveDb).addCost(new Date(), r.tregUsd, r.jevUsd); // all spend is recorded in the profile's live database
      if (!json) {
        console.log(
          `scan ${hours} h into ${scanDb} · fetched ${r.fetched} · kept ${r.kept} · events ${r.events} · treg ${usd(r.tregUsd)} · jev ${usd(r.jevUsd)}`,
        );
        const sources = Object.entries(r.bySource).map(([k, n]) => `${k} ${n}`);
        const silent = Object.keys(scout.profile.sources.keywords).filter((k) => !r.bySource[`keyword:${k}`]);
        console.log(
          `  fetched by source: ${sources.join(" · ") || "none"}${silent.length ? ` · no posts: ${silent.map((k) => `keyword:${k}`).join(", ")}` : ""}`,
        );
        const profileFlag = typeof flags.profile === "string" ? ` --profile ${file}` : "";
        console.log(`  see what was kept or dropped and why: SCOUT_DB=${scanDb} pnpm scout${profileFlag} posts`);
      }
      for (const e of r.errors) console.error(`  error: ${e}`);
      const { alerts: _, ...counts } = r;
      report(store, r.threshold, { database: scanDb, ...counts });
    },

    replay() {
      const store = open();
      report(store, adjustedThreshold(scout, store.feedbackStats(new Date())));
    },

    status() {
      const store = open();
      const s = store.status(new Date());
      const cost = store.costs(7, new Date());
      const today = store.costOn(new Date());
      const budget = scout.profile.budget.usd_per_day;
      print({ profile: file, database: dbPath, ...s, spentTodayUsd: today, budgetUsdPerDay: budget ?? null, costs: cost }, () => {
        const when = (d: Date | null) => (d ? time(d.getTime() / 1000) : "never");
        console.log(`profile   ${file} (${scout.profile.name})`);
        console.log(`database  ${dbPath}`);
        console.log(`last run  ${when(s.lastRun)} · keywords searched ${when(s.lastKeywords)}`);
        console.log(
          `events    ${
            Object.entries(s.events)
              .map(([k, n]) => `${n} ${k}`)
              .join(" · ") || "none"
          }`,
        );
        console.log(`alerts    ${s.alerts24h} in the last 24 h`);
        console.log(
          `spend     ${usd(today)} today${budget ? ` of ${usd(budget)}` : ""} · ${usd(cost.reduce((t, c) => t + c.treg_usd + c.jev_usd, 0))} over 7 days`,
        );
      });
    },

    events() {
      const status = args[0];
      if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
        throw new Error(`usage: scout events [${STATUSES.join("|")}]`);
      const list = open().listEvents(status);
      print(list, () => {
        for (const e of list)
          console.log(
            `#${String(e.id).padEnd(5)} ${e.status.padEnd(8)} ${(e.tier ?? "-").padEnd(9)} ${e.score.toFixed(1)}  [${e.topic}] ${e.title.slice(0, 90)}`,
          );
      });
    },

    show() {
      const store = open();
      const e = store.event(Number(args[0]));
      if (!e) throw new Error(`no event #${args[0] ?? ""}`);
      const posts = store.eventPosts(e.id).map(({ author, text, url }) => ({ author, text, url }));
      const prompt = draftPrompt(scout, e, posts.slice(0, PROMPT_POSTS));
      print({ ...e, posts, prompt }, () => {
        console.log(
          `#${e.id}  ${e.status}${e.tier ? ` · ${TIER[e.tier]}` : ""}  [${scout.labels[e.topic] ?? e.topic}]  score ${e.score.toFixed(2)}`,
        );
        console.log(e.title);
        if (e.actions.length) console.log(`actions: ${e.actions.join(", ")}`);
        if (e.feedback) console.log(`feedback: ${e.feedback}`);
        console.log(`\n${posts.length} ${posts.length === 1 ? "post" : "posts"}`);
        for (const p of posts) console.log(`  @${p.author}  ${p.url}\n    ${p.text.replace(/\s+/g, " ").slice(0, 200)}`);
        console.log(`\nDraft prompt:\n\n${prompt}`);
      });
    },

    posts() {
      const filter = args[0];
      if (filter !== undefined && filter !== "kept" && filter !== "dropped")
        throw new Error("usage: scout posts [kept|dropped] [--limit N]");
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
      if (!(limit > 0)) throw new Error("--limit must be a positive number");
      const list = open().listPosts(filter, limit);
      print(list, () => {
        console.log(`${list.length} posts, newest first (times in ${scout.profile.locale.timezone}; --limit N, default 50)\n`);
        for (const p of list)
          console.log(
            `${time(p.createdUtc)}  ${p.kept ? `kept #${p.eventId}` : "dropped"}  ${(p.source ?? "-").padEnd(18)} @${p.author}  ${p.reason}${p.topic ? ` [${p.topic}]` : ""}\n    ${p.text.replace(/\s+/g, " ").slice(0, 140)}  ${p.url}`,
          );
      });
    },

    feedback() {
      const [id, verdict] = args;
      if (verdict !== "good" && verdict !== "skip") throw new Error("usage: scout feedback <id> good|skip");
      const store = open();
      if (!store.event(Number(id))) throw new Error(`no event #${id ?? ""}`);
      store.setFeedback(Number(id), verdict);
      print({ id: Number(id), feedback: verdict }, () => console.log(`#${id} marked ${verdict}`));
    },

    costs() {
      const list = open().costs(30, new Date());
      print(list, () => {
        for (const c of list) console.log(`${c.day}  treg ${usd(c.treg_usd)}  jev ${usd(c.jev_usd)}`);
      });
    },

    async backtest() {
      const labels = args[0] ?? join(dirname(file), `${scout.profile.name}.labels.tsv`);
      if (!existsSync(labels)) throw new Error(`no labels at ${labels}: pass a TSV with columns expected, url, note`);
      const r = await backtest(scout, labels, join(dataDir, "backtest-cache.json"));
      open(liveDb).addCost(new Date(), r.tregUsd, r.jevUsd); // all spend is recorded in the profile's live database
      print(r, () => {
        for (const x of r.results)
          console.log(
            `${x.hit ? "hit " : "miss"}  ${x.expected.padEnd(16)} ${x.score?.toFixed(2) ?? "   -"}  ${x.reason.padEnd(24)} ${x.note.slice(0, 60)}`,
          );
        console.log(
          `\nrecall ${r.recall.hits}/${r.recall.total} · false alerts ${r.falseAlerts.hits}/${r.falseAlerts.total} · threshold ${r.threshold}`,
        );
        for (const b of r.byThreshold)
          console.log(`  at ${b.threshold}: recall ${b.recall}/${r.recall.total}, false alerts ${b.falseAlerts}/${r.falseAlerts.total}`);
        console.log(`\ntreg ${usd(r.tregUsd)} · jev ${usd(r.jevUsd)}`);
      });
    },
  };

  const run = commands[command];
  if (!run) {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  await run();
}

try {
  await main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
