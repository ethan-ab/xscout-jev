import { computeHeat } from "./heat";
import { decideAlert, scorePost, thresholdFor } from "./policy";
import { isSource, type Scout } from "./profile";
import type { Store } from "./store";

// Delay before a live run would have seen the post: accounts are searched on every run (every 10 minutes when scheduled as
// documented), keywords every keyword_every_minutes.
const latencySec = (scout: Scout, author: string) => (isSource(scout, author) ? 10 : scout.profile.sources.keyword_every_minutes) * 60;

export interface Flag {
  eventId: number;
  title: string;
  topic: string;
  url: string;
  tier: string;
  why: string;
  firstUtc: number;
  flaggedUtc: number;
  lagMin: number;
  accounts: number;
  updates: { utc: number; author: string }[];
}

// Re-evaluates every event at each of its posts, in time order, as if it had been polled live. No engagement data (it would leak the future).
export function replay(scout: Scout, store: Store, base: number): Flag[] {
  const flags: Flag[] = [];
  for (const e of store.allEvents()) {
    const posts = store.eventPosts(e.id);
    if (!posts.length) continue;
    let flag: Flag | null = null;
    let best = { score: 0, confidence: 0 };
    for (let k = 0; k < posts.length; k++) {
      const p = posts[k]!;
      const s = scorePost(scout, JSON.parse(p.answers));
      if (flag) {
        if (isSource(scout, p.author) && s.score >= thresholdFor(scout, e.topic, base) - scout.policy.watchMargin)
          flag.updates.push({ utc: p.createdUtc + latencySec(scout, p.author), author: p.author });
        continue;
      }
      if (s.score > best.score) best = { score: s.score, confidence: s.confidence };
      const sub = posts.slice(0, k + 1).map((x) => ({ author: x.author, createdUtc: x.createdUtc }));
      const heat = computeHeat(scout, sub, p.createdUtc);
      const state = {
        ...e,
        status: "open" as const,
        score: best.score,
        confidence: best.confidence,
        authors: [...new Set(sub.map((x) => x.author))],
      };
      const d = decideAlert(scout, state, heat, {
        now: new Date(p.createdUtc * 1000),
        alertsToday: 0,
        threshold: thresholdFor(scout, e.topic, base),
        respectQuietHours: false,
      });
      if (d.action === "alert") {
        const flaggedUtc = p.createdUtc + latencySec(scout, p.author);
        flag = {
          eventId: e.id,
          title: e.title,
          topic: e.topic,
          url: e.firstUrl,
          tier: d.tier,
          why: d.why,
          firstUtc: heat.firstUtc,
          flaggedUtc,
          lagMin: Math.round((flaggedUtc - heat.firstUtc) / 60),
          accounts: 0,
          updates: [],
        };
      }
    }
    if (flag) {
      flag.accounts = new Set(posts.map((p) => p.author)).size;
      flags.push(flag);
    }
  }
  return flags.sort((a, b) => a.flaggedUtc - b.flaggedUtc);
}
