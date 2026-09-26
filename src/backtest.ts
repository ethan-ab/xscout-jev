import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { filterDecision } from "./filter";
import { decide } from "./jev";
import { authorState, mapLimit } from "./pipeline";
import { adjustedThreshold, scorePost, thresholdFor } from "./policy";
import type { Scout } from "./profile";
import { type FetchLike, Ledger, tregCall } from "./treg";

export interface BacktestRow {
  expected: string;
  url: string;
  note: string;
  hit: boolean;
  score: number | null;
  reason: string;
  topic: string | null;
  text: string;
}

// Replays a labelled set of posts through filter and score, against each topic's threshold. Coverage rules cannot be replayed
// on isolated posts. Fetched posts are cached in `cacheFile`, so re-running while tuning costs nothing on treg.
export async function backtest(scout: Scout, file: string, cacheFile: string, fetchImpl?: FetchLike) {
  const ledger = new Ledger();
  const threshold = adjustedThreshold(scout, { total: 0, rejected: 0 });
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => {
      const [expected, url, note] = l.split("\t");
      return { expected: expected!, url: url!, note: note ?? "" };
    });
  type Detail = { data?: { text: string; author: { screen_name: string; sub_count?: number } } };
  const cache: Record<string, Detail> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const results = await mapLimit(rows, 4, async (r): Promise<BacktestRow> => {
    try {
      return await judge(r);
    } catch (e) {
      return { ...r, hit: false, score: null, reason: `error: ${(e as Error).message.slice(0, 80)}`, topic: null, text: "" };
    }
  }).finally(() => {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  });
  async function judge(r: { expected: string; url: string; note: string }): Promise<BacktestRow> {
    const id = r.url.match(/status\/(\d+)/)?.[1];
    let d: Detail | null = id ? (cache[id] ?? null) : null;
    if (id && !d) {
      d = await tregCall<Detail>("tikhub.x.twitter-web-fetch-tweet-detail", { query: { tweet_id: id } }, ledger, fetchImpl).catch(
        () => null,
      );
      if (d?.data) cache[id] = d;
    }
    if (!d?.data) return { ...r, hit: false, score: null, reason: "unavailable", topic: null, text: "" };
    const post = { text: d.data.text, author: d.data.author.screen_name, followers: d.data.author.sub_count };
    const state = { author: authorState(scout, post), text: post.text.slice(0, 900) };
    const f = await decide(state, scout.filterQuestions, ledger, fetchImpl);
    const v = filterDecision(scout, post, f.answers);
    if (!v.keep) return { ...r, hit: false, score: null, reason: v.reason, topic: v.topic, text: post.text };
    const s = scorePost(scout, (await decide(state, scout.scoreQuestions, ledger, fetchImpl)).answers);
    return {
      ...r,
      hit: s.score >= thresholdFor(scout, v.topic, threshold),
      score: s.score,
      reason: v.reason,
      topic: v.topic,
      text: post.text,
    };
  }
  // Posts that could not be fetched or judged are left out of the counts.
  const judged = results.filter((r) => r.reason !== "unavailable" && !r.reason.startsWith("error"));
  const onTopic = judged.filter((r) => scout.topics.includes(r.expected));
  const out = judged.filter((r) => r.expected === "out");
  return {
    results,
    recall: { hits: onTopic.filter((r) => r.hit).length, total: onTopic.length },
    falseAlerts: { hits: out.filter((r) => r.hit).length, total: out.length },
    // The same counts for other base thresholds; each topic still adds its threshold_offset.
    byThreshold: [threshold - 0.5, threshold, threshold + 0.5, threshold + 1].map((t) => {
      const clears = (r: BacktestRow) => r.score !== null && r.topic !== null && r.score >= thresholdFor(scout, r.topic, t);
      return { threshold: t, recall: onTopic.filter(clears).length, falseAlerts: out.filter(clears).length };
    }),
    threshold,
    tregUsd: ledger.tregUsd,
    jevUsd: ledger.jevUsd,
  };
}
