import type { Heat } from "./heat";
import type { Scout } from "./profile";
import type { Answer, EventState, ScoreAnswer } from "./types";

export function scorePost(scout: Scout, a: Record<string, Answer>): { score: number; confidence: number; actions: string[] } {
  const sig = a.significance as ScoreAnswer;
  const rel = a.relevance as ScoreAnswer;
  const actions = Object.entries(scout.actionLabels)
    .filter(([id]) => {
      const x = a[`action_${id}`];
      return x?.type === "noul" && x.noul >= scout.policy.actionMin;
    })
    .map(([, label]) => label);
  return { score: Math.round((sig.score + rel.score) * 100) / 100, confidence: sig.confidence ?? 0, actions };
}

export function isQuiet(scout: Scout, now: Date): boolean {
  const P = scout.policy;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: scout.profile.locale.timezone,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const weekday = parts.find((p) => p.type === "weekday")!.value;
  return weekday === "Sat" || weekday === "Sun" || hour >= P.quietStartHour || hour < P.quietEndHour;
}

export function adjustedThreshold(scout: Scout, feedback: { total: number; rejected: number }): number {
  const P = scout.policy;
  const noisy = feedback.total >= P.minFeedbackForTuning && feedback.rejected / feedback.total > P.noisyRejectRate;
  return P.alertThreshold + (noisy ? P.thresholdStep : 0);
}

export function thresholdFor(scout: Scout, topic: string, base: number): number {
  return base + (scout.profile.topics.find((t) => t.id === topic)?.threshold_offset ?? 0);
}

type Tier = "big" | "trending" | "notable";
export type Decision = { action: "alert"; tier: Tier; why: string } | { action: "watch" | "hold" | "drop"; reason: string };

// Importance comes from Jev (score); momentum comes from code (heat). Big news needs either a very high score or broad coverage.
export function decideAlert(
  scout: Scout,
  e: EventState,
  heat: Heat,
  ctx: { alertsToday: number; threshold: number; respectQuietHours: boolean; now: Date },
): Decision {
  const P = scout.policy;
  if (e.status === "alerted") return { action: "drop", reason: "already alerted" };
  // An event held for quiet hours may be released after a weekend, so it gets the longer event window.
  const maxAge = e.status === "held" ? P.eventWindowHours : P.maxEventAgeHours;
  if (heat.ageHours > maxAge) return { action: "drop", reason: `stale (${heat.ageHours.toFixed(0)}h)` };
  const relevant = e.score >= ctx.threshold - P.watchMargin;
  if (!relevant) return { action: "drop", reason: `score ${e.score.toFixed(2)}` };

  const quiet = ctx.respectQuietHours && isQuiet(scout, ctx.now);
  const coverage = `${heat.primary} official · ${heat.amplifiers} news · ${heat.burst6h} acc/6h`;
  // A very high score alone isn't enough: big news needs at least one official source, one news account or two accounts.
  const corroborated = heat.primary >= 1 || heat.amplifiers >= 1 || heat.accounts >= 2;
  const big =
    (e.score >= P.majorThreshold && corroborated) ||
    heat.amplifiers >= P.bigAmplifiers ||
    heat.primary >= P.bigPrimary ||
    (heat.primary >= 1 && heat.burst6h >= P.bigBurstWithPrimary) ||
    heat.burst6h >= P.bigBurst;
  if (big)
    return quiet
      ? { action: "hold", reason: "quiet hours" }
      : { action: "alert", tier: "big", why: `score ${e.score.toFixed(1)} · ${coverage}` };

  const trending =
    heat.ageHours <= P.trendingMaxAgeHours && (heat.burst6h >= P.trendingBurst || (heat.velocity ?? 0) >= P.trendingVelocity);
  if (trending)
    return quiet
      ? { action: "hold", reason: "quiet hours" }
      : { action: "alert", tier: "trending", why: `${coverage}${heat.velocity ? ` · ${Math.round(heat.velocity)}/h` : ""}` };

  if (e.score < ctx.threshold) return { action: "watch", reason: `score ${e.score.toFixed(2)} < ${ctx.threshold}` };
  if (e.confidence < P.minConfidence) return { action: "watch", reason: `confidence ${e.confidence.toFixed(2)}` };
  if (heat.primary === 0 && heat.accounts < P.notableMinAccounts)
    return { action: "watch", reason: heat.accounts === 1 ? "single unofficial source" : `${heat.accounts} unofficial accounts` };
  if (quiet) return { action: "hold", reason: "quiet hours" };
  if (ctx.alertsToday >= P.dailyCap) return { action: "hold", reason: "daily cap" };
  return { action: "alert", tier: "notable", why: `score ${e.score.toFixed(1)} · ${coverage}` };
}
