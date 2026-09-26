import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ACCOUNT_CHUNK, CATCH_UP_PAGES, CONCURRENCY, FIRST_CALL_USD, PROMPT_POSTS, SCAN_CHUNK, SCAN_PAGES } from "./config";
import { matchEvent } from "./events";
import { filterDecision, isBlocklisted } from "./filter";
import { computeHeat } from "./heat";
import { decide } from "./jev";
import { adjustedThreshold, decideAlert, scorePost, thresholdFor } from "./policy";
import { isAmplifier, isPrimary, isSource, roleOf, type Scout } from "./profile";
import { draftPrompt } from "./prompt";
import type { EventRow, Store } from "./store";
import { type FetchLike, Ledger } from "./treg";
import type { XPost } from "./types";
import { accountQueries, keywordQuery, searchX } from "./x";

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const audience = (f: number) =>
  f >= 1e6 ? "1M+ followers" : f >= 1e5 ? "100K–1M followers" : f >= 1e4 ? "10K–100K followers" : "under 10K followers";
export const authorState = (scout: Scout, p: { author: string; followers?: number }) => {
  const role = roleOf(scout, p.author);
  return { username: p.author, ...(p.followers !== undefined ? { audience: audience(p.followers) } : {}), ...(role ? { role } : {}) };
};
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

export interface Alert {
  kind: "alert" | "update";
  at: string;
  eventId: number;
  tier: string;
  topic: string;
  score: number;
  why: string;
  title: string;
  actions: string[];
  authors: string[];
  sources: string[];
  prompt: string;
}

// scanHours: one-off collection over a past window (Top posts, paginated, no decisions — use replay() to see when each event would have been flagged).
export interface PollOptions {
  quietHours?: boolean;
  now?: Date;
  fetchImpl?: FetchLike;
  alertsFile?: string;
  scanHours?: number;
  spentToday?: number; // spend already counted against today's budget; defaults to the store's (a scan passes the live database's)
}

export async function runPoll(scout: Scout, store: Store, opts: PollOptions = {}) {
  const now = opts.now ?? new Date();
  const ledger = new Ledger();
  try {
    return await poll(scout, store, { ...opts, now }, ledger);
  } finally {
    // Recorded even when the run fails half-way, so the daily budget sees every call.
    store.addCost(now, ledger.tregUsd, ledger.jevUsd);
  }
}

async function poll(scout: Scout, store: Store, opts: PollOptions & { now: Date }, ledger: Ledger) {
  const P = scout.policy;
  const src = scout.profile.sources;
  const now = opts.now;
  const { alertsFile } = opts;
  const nowUnix = Math.floor(now.getTime() / 1000);
  const report = {
    searches: 0,
    failedSearches: 0,
    fetched: 0,
    bySource: {} as Record<string, number>, // fetched posts per search: "accounts" or "keyword:<name>"
    fresh: 0,
    kept: 0,
    events: 0,
    alerts: [] as Alert[],
    errors: [] as string[],
    budgetReached: false,
  };
  // Daily budget: stop calling treg and Jev once today's spend (UTC day) reaches it. Calls run in parallel, so each check also
  // counts what is already in flight, reserved at the average cost seen so far (a search reserves every page it may read).
  const budget = scout.profile.budget.usd_per_day;
  const spentBefore = budget === undefined ? 0 : (opts.spentToday ?? store.costOn(now));
  let reserved = 0;
  const searchPageUsd = () => (ledger.tregCalls ? ledger.tregUsd / ledger.tregCalls : FIRST_CALL_USD);
  const jevCallUsd = () => (ledger.jevCalls ? ledger.jevUsd / ledger.jevCalls : FIRST_CALL_USD);
  const spend = async <T>(usd: number, call: () => Promise<T>): Promise<T> => {
    reserved += usd;
    try {
      return await call();
    } finally {
      reserved -= usd;
    }
  };
  const overBudget = (next = jevCallUsd()) => {
    if (budget === undefined || spentBefore + ledger.tregUsd + ledger.jevUsd + reserved + next < budget) return false;
    if (!report.budgetReached) report.errors.push(`daily budget of $${budget} reached`);
    report.budgetReached = true;
    return true;
  };
  const write = (a: Alert) => {
    if (alertsFile) {
      mkdirSync(dirname(alertsFile), { recursive: true });
      appendFileSync(alertsFile, `${JSON.stringify(a)}\n`);
    }
    report.alerts.push(a);
  };

  // 1. Collect: accounts on every run, keywords every keyword_every_minutes with a look-back (fresh posts need time to gather likes)
  const scan = opts.scanHours !== undefined;
  const accounts = [...Object.keys(scout.profile.sources.primary), ...Object.keys(scout.profile.sources.amplifiers)];
  const accountsSince = scan
    ? nowUnix - opts.scanHours! * 3600
    : Math.max(
        Math.floor((store.lastRun("accounts")?.getTime() ?? now.getTime() - 3_600_000) / 1000) - 300,
        nowUnix - P.maxEventAgeHours * 3600, // after a long outage, older posts could not alert anyway
      );
  const kwLast = store.lastRun("keywords");
  const kwDue = scan || !kwLast || now.getTime() - kwLast.getTime() >= (src.keyword_every_minutes - 2) * 60_000;
  const kwSince = scan ? accountsSince : nowUnix - src.keyword_lookback_hours * 3600;
  const jobs = [
    ...(accounts.length
      ? accountQueries(accounts, accountsSince, scan ? SCAN_CHUNK : ACCOUNT_CHUNK).map((q) => ({
          q,
          since: accountsSince,
          kind: "accounts" as const,
          source: "accounts",
        }))
      : []),
    ...(kwDue
      ? Object.entries(src.keywords).map(([name, k]) => ({
          q: keywordQuery(k.query, kwSince, { lang: scout.profile.locale.lang, minFaves: k.min_faves }),
          since: kwSince,
          kind: "keywords" as const,
          source: `keyword:${name}`,
        }))
      : []),
  ];
  // Live account searches page back to the previous run, so a gap (sleep, outage) is filled in.
  // A failed or skipped search keeps the previous run time, so the next run covers it again.
  const failed = new Set<"accounts" | "keywords">();
  report.searches = jobs.length;
  const batches = await mapLimit(jobs, CONCURRENCY, async ({ q, since, kind, source }): Promise<(XPost & { source: string })[]> => {
    const pages = scan ? SCAN_PAGES : kind === "accounts" ? CATCH_UP_PAGES : 1;
    const usd = pages * searchPageUsd();
    if (overBudget(usd)) {
      failed.add(kind);
      return [];
    }
    return (
      await spend(usd, () => searchX(q, since, ledger, opts.fetchImpl, scan ? "Top" : "Latest", pages)).catch((e: Error) => {
        report.errors.push(e.message);
        report.failedSearches++;
        failed.add(kind);
        return [];
      })
    ).map((p) => ({ ...p, source }));
  });
  // A post found by several searches keeps the first one as its source.
  const byId = new Map<string, XPost & { source: string }>();
  for (const p of batches.flat()) if (!byId.has(p.id)) byId.set(p.id, p);
  report.fetched = byId.size;
  for (const p of byId.values()) report.bySource[p.source] = (report.bySource[p.source] ?? 0) + 1;
  const fresh = new Set(store.unseenIds([...byId.keys()]));
  const touched = new Set<number>();
  // Posts we already know: refresh their counts (velocity) and re-evaluate their event.
  store.tx(() => {
    for (const p of byId.values()) {
      if (fresh.has(p.id)) continue;
      store.refreshCounts(p.id, p);
      const ev = store.eventOfPost(p.id);
      if (ev !== null) touched.add(ev);
    }
  });
  const posts = [...fresh].map((id) => byId.get(id)!).sort((a, b) => a.createdUtc - b.createdUtc);
  report.fresh = posts.length;
  // Posts not judged this run (Jev error or budget) are not stored; the next run restarts from the oldest of them.
  let oldestSkipped = Number.POSITIVE_INFINITY;
  const skip = (p: XPost, error?: unknown) => {
    if (error) report.errors.push(`${p.id}: ${(error as Error).message}`);
    oldestSkipped = Math.min(oldestSkipped, p.createdUtc);
    return null;
  };

  // 2. Filter (Jev call 1) in parallel
  const filtered = await mapLimit(posts, CONCURRENCY, async (p) => {
    if (isBlocklisted(scout, p)) return { p, answers: {}, verdict: { keep: false, topic: "", reason: "excluded (blocklist)" } };
    if (overBudget()) return skip(p);
    try {
      const r = await spend(jevCallUsd(), () =>
        decide({ author: authorState(scout, p), text: p.text.slice(0, 900) }, scout.filterQuestions, ledger, opts.fetchImpl),
      );
      return { p, answers: r.answers, verdict: filterDecision(scout, p, r.answers) };
    } catch (e) {
      return skip(p, e);
    }
  });

  // 3a. Score (Jev call 2) in parallel. Posts below their topic's floor cannot start an event, but still count as coverage of one.
  const base = adjustedThreshold(scout, store.feedbackStats(now));
  const floorFor = (topic: string) => thresholdFor(scout, topic, base) - P.watchMargin;
  const scoredPosts = await mapLimit(filtered, CONCURRENCY, async (f) => {
    if (!f) return null;
    const { p, answers, verdict } = f;
    const row = {
      id: p.id,
      author: p.author,
      text: p.text,
      url: p.url,
      createdUtc: p.createdUtc,
      topic: verdict.topic || null,
      metrics: p,
      source: p.source,
    };
    if (!verdict.keep) {
      store.insertPost({ ...row, reason: verdict.reason, kept: false, answers, eventId: null }, now);
      return null;
    }
    if (overBudget()) return skip(p);
    try {
      const scored = await spend(jevCallUsd(), () =>
        decide({ author: authorState(scout, p), text: p.text.slice(0, 900) }, scout.scoreQuestions, ledger, opts.fetchImpl),
      );
      const s = scorePost(scout, scored.answers);
      const all = { ...answers, ...scored.answers };
      return { p, row, verdict, s, all, weak: s.score < floorFor(verdict.topic) };
    } catch (e) {
      return skip(p, e);
    }
  });

  // 3b. Group into events (Jev call 3), sequentially so a new event is visible to the next post.
  // Posts above the floor go first, so the events they start are there when the weaker posts look for a match.
  const kept = scoredPosts.filter((x) => x !== null);
  for (const x of [...kept.filter((k) => !k.weak), ...kept.filter((k) => k.weak)]) {
    const { p, row, verdict, s, all, weak } = x;
    if (overBudget()) {
      skip(p);
      continue;
    }
    try {
      const official = isPrimary(scout, p.author);
      const open = scan ? store.allEvents() : store.openEvents(P.eventWindowHours, now);
      const matched = await matchEvent(
        p.text,
        open.map((e) => ({ id: e.id, title: e.title })),
        (st, q) => spend(jevCallUsd(), () => decide(st, q, ledger, opts.fetchImpl)),
        scout.stopwords,
      );
      const below = `score ${s.score.toFixed(2)} below floor`;
      // A weak post only adds coverage to an event that already started: it never starts one, predates one, or becomes its title.
      if (weak && (!matched || p.createdUtc < (store.eventPosts(matched)[0]?.createdUtc ?? 0))) {
        store.insertPost({ ...row, reason: below, kept: false, answers: all, eventId: null }, now);
        continue;
      }
      const title = oneLine(p.text, 200);
      const titleRank = weak ? 0 : official ? 3 : isAmplifier(scout, p.author) ? 2 : 1;
      const ev = matched
        ? store.addToEvent(matched, { author: p.author, ...s, title, titleRank }, now)
        : store.createEvent({ title, titleRank, topic: verdict.topic, url: p.url, author: p.author, ...s }, now);
      if (!matched) report.events++;
      store.insertPost(
        { ...row, reason: weak ? `${below}, counted as coverage` : verdict.reason, kept: true, answers: all, eventId: ev.id },
        now,
      );
      report.kept++;
      touched.add(ev.id);
      // A significant follow-up from an official or news account on an event already flagged → update, not a new alert.
      if (!scan && ev.status === "alerted" && isSource(scout, p.author) && s.score >= floorFor(ev.topic)) {
        write({
          kind: "update",
          at: now.toISOString(),
          eventId: ev.id,
          tier: ev.tier ?? "",
          topic: ev.topic,
          score: s.score,
          why: `new post from @${p.author}`,
          title: oneLine(p.text, 200),
          actions: s.actions,
          authors: ev.authors,
          sources: [p.url],
          prompt: "",
        });
      }
    } catch (e) {
      skip(p, e);
    }
  }

  // 4. Decide (live only): touched events + everything held or watched
  if (!scan) {
    const candidates = new Map<number, EventRow>();
    for (const e of store.heldAndWatched()) candidates.set(e.id, e);
    for (const id of touched) candidates.set(id, store.event(id)!);
    for (const e of candidates.values()) {
      const evPosts = store.eventPosts(e.id);
      if (evPosts.length === 0) continue;
      const heat = computeHeat(scout, evPosts, nowUnix);
      const d = decideAlert(scout, e, heat, {
        now,
        alertsToday: store.alertsLast24h(now),
        threshold: thresholdFor(scout, e.topic, base),
        respectQuietHours: opts.quietHours ?? P.respectQuietHours,
      });
      if (d.action === "alert") {
        store.setStatus(e.id, "alerted", now, d.tier);
        write({
          kind: "alert",
          at: now.toISOString(),
          eventId: e.id,
          tier: d.tier,
          topic: e.topic,
          score: e.score,
          why: d.why,
          title: e.title,
          actions: e.actions,
          authors: e.authors,
          sources: evPosts.map((x) => x.url),
          prompt: draftPrompt(scout, e, evPosts.slice(0, PROMPT_POSTS)),
        });
      } else if (e.status !== "alerted") {
        store.setStatus(e.id, d.action === "hold" ? "held" : d.action === "watch" ? "watch" : "dropped", now);
      }
    }
  }

  if (!scan) store.setLastRun("run", now);
  if (!failed.has("accounts")) store.setLastRun("accounts", Number.isFinite(oldestSkipped) ? new Date(oldestSkipped * 1000) : now);
  if (kwDue && !failed.has("keywords")) store.setLastRun("keywords", now);
  return {
    ...report,
    threshold: base,
    tregUsd: ledger.tregUsd,
    jevUsd: ledger.jevUsd,
    tregCalls: ledger.tregCalls,
    jevCalls: ledger.jevCalls,
  };
}
