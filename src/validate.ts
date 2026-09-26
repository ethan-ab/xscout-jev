import { ACCOUNT_CHUNK, SEARCH_PAGE_SIZE } from "./config";
import { jevConfig } from "./jev";
import type { Scout } from "./profile";
import { type FetchLike, Ledger, tregAuth } from "./treg";
import { keywordQuery, searchX } from "./x";

export interface Check {
  level: "error" | "warning" | "info";
  where: string;
  message: string;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

// X search syntax mistakes that make a keyword return nothing or everything.
export function keywordProblems(query: string): { level: "error" | "warning"; message: string }[] {
  const out: { level: "error" | "warning"; message: string }[] = [];
  const error = (message: string) => out.push({ level: "error", message });
  if ((query.match(/"/g) ?? []).length % 2) error("unbalanced double quotes");
  let depth = 0;
  for (const ch of query.replace(/"[^"]*"/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) break;
  }
  if (depth !== 0) error("unbalanced parentheses");
  if (/^\s*OR\b|\bOR\s*$|\bOR\s+OR\b/.test(query)) error("dangling OR");
  if (/\b(or|and)\b/.test(query.replace(/"[^"]*"/g, "")))
    out.push({ level: "warning", message: "lowercase or/and are searched as words; X operators are OR and a space" });
  return out;
}

// Checks that need no network: profile content, handles, keyword syntax, credentials.
export function checkOffline(scout: Scout): Check[] {
  const p = scout.profile;
  const checks: Check[] = [];
  const add = (level: Check["level"], where: string, message: string) => checks.push({ level, where, message });

  for (const [group, accounts] of [
    ["primary", p.sources.primary],
    ["amplifiers", p.sources.amplifiers],
  ] as const)
    for (const h of Object.keys(accounts))
      if (!HANDLE.test(h)) add("error", `sources.${group}.${h}`, "is not a valid X handle (letters, digits, _; no @)");
  for (const h of Object.keys(p.sources.primary))
    if (scout.amplifiers.has(h.toLowerCase()))
      add("warning", `sources.primary.${h}`, "is listed both as primary and as amplifier; it counts as primary");
  for (const [name, k] of Object.entries(p.sources.keywords))
    for (const problem of keywordProblems(k.query)) add(problem.level, `sources.keywords.${name}`, problem.message);

  for (const t of p.topics)
    if (!t.examples?.length)
      add("warning", `topics.${t.id}`, "has no examples; two or three real posts make classification much more reliable");
  if (!p.exclude.question && !p.exclude.blocklist.length)
    add("info", "exclude", "nothing is excluded; add a blocklist or a question to skip posts you never want alerts on");
  if (!p.actions.length) add("info", "actions", "no actions: alerts will not suggest what to do");
  if (p.budget.usd_per_day === undefined) add("info", "budget", "no daily budget; set budget.usd_per_day to cap spend");
  // Live searches per day at a 10-minute schedule: accounts on every run in groups, keywords every keyword_every_minutes.
  const accounts = Object.keys(p.sources.primary).length + Object.keys(p.sources.amplifiers).length;
  const searches =
    144 * Math.ceil(accounts / ACCOUNT_CHUNK) +
    Math.round((24 * 60) / p.sources.keyword_every_minutes) * Object.keys(p.sources.keywords).length;
  add(
    "info",
    "cost",
    `about ${searches} searches a day when run every 10 minutes, plus Jev calls for each new post (see Costs in the README)`,
  );
  if (!Object.keys(p.sources.primary).length)
    add("warning", "sources.primary", "no primary accounts: big news can then only come from coverage and bursts");
  // Each scale runs from 0 to (levels - 1); the score is their sum.
  const best = p.scoring.significance.levels.length - 1 + p.scoring.relevance.levels.length - 1;
  for (const t of p.topics) {
    const threshold = scout.policy.alertThreshold + (t.threshold_offset ?? 0);
    if (best < threshold)
      add(
        "error",
        `topics.${t.id}`,
        `can never alert: the best possible score is ${best}, the threshold is ${threshold}; add levels or lower the threshold`,
      );
  }

  try {
    jevConfig();
  } catch (e) {
    add("error", "env", (e as Error).message);
  }
  try {
    tregAuth();
  } catch (e) {
    add("error", "env", (e as Error).message);
  }
  return checks;
}

// One search per account and keyword: flags handles with no recent posts and shows keyword volume. Costs a few treg calls.
export async function checkOnline(scout: Scout, fetchImpl?: FetchLike, now = new Date()): Promise<{ checks: Check[]; tregUsd: number }> {
  const p = scout.profile;
  const ledger = new Ledger();
  const checks: Check[] = [];
  const nowUnix = Math.floor(now.getTime() / 1000);
  const month = nowUnix - 30 * 86400;
  const day = nowUnix - 86400;
  const handles = [...Object.keys(p.sources.primary), ...Object.keys(p.sources.amplifiers)].filter((h) => HANDLE.test(h));
  let inactive = 0;
  for (const h of handles) {
    // The latest original post, however old: tells a wrong handle from an account that went quiet.
    const posts = await searchX(`from:${h} -filter:replies -filter:retweets`, 0, ledger, fetchImpl, "Latest", 1, 1).catch((e: Error) => e);
    if (posts instanceof Error) checks.push({ level: "error", where: `@${h}`, message: posts.message });
    else if (!posts.length) {
      inactive++;
      checks.push({
        level: "warning",
        where: `@${h}`,
        message: "no original posts found (replies and reposts do not count): misspelled, renamed, protected, or it only replies",
      });
    } else if (posts[0]!.createdUtc < month) {
      inactive++;
      const last = new Date(posts[0]!.createdUtc * 1000).toISOString().slice(0, 10);
      checks.push({ level: "warning", where: `@${h}`, message: `inactive: no original post in 30 days, last on ${last}` });
    }
  }
  if (handles.length >= 3 && inactive / handles.length >= 0.5)
    checks.push({
      level: "warning",
      where: "sources",
      message: `${inactive} of ${handles.length} accounts are missing or inactive: this field may be quiet on X; lean on keywords and replay a longer window (scan 168) before deciding`,
    });
  for (const [name, k] of Object.entries(p.sources.keywords)) {
    const query = keywordQuery(k.query, day, { lang: p.locale.lang, minFaves: k.min_faves });
    const posts = await searchX(query, day, ledger, fetchImpl).catch((e: Error) => e);
    const likes = `with ${k.min_faves}+ likes`;
    if (posts instanceof Error) checks.push({ level: "error", where: `sources.keywords.${name}`, message: posts.message });
    else
      checks.push({
        level: posts.length ? "info" : "warning",
        where: `sources.keywords.${name}`,
        message:
          posts.length >= SEARCH_PAGE_SIZE
            ? `${SEARCH_PAGE_SIZE}+ posts ${likes} in the last 24 h (a full search page): busy; narrow it or raise its min_faves if it brings noise`
            : `${posts.length} posts ${likes} in the last 24 h`,
      });
  }
  return { checks, tregUsd: ledger.tregUsd };
}
