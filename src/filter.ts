import { isPrimary, type Scout } from "./profile";
import type { Answer, ChoiceAnswer } from "./types";

export function isBlocklisted(scout: Scout, p: { text: string; author: string }): boolean {
  return !!scout.blocklist && (scout.blocklist.test(p.text) || scout.blocklist.test(p.author));
}

// On-topic = total probability on our topics (a post can be split between two of them).
export function filterDecision(
  scout: Scout,
  p: { text: string; author: string },
  a: Record<string, Answer>,
): { keep: boolean; topic: string; reason: string } {
  const topic = a.topic as ChoiceAnswer;
  const speaker = a.speaker as ChoiceAnswer;
  const excluded = a.excluded?.type === "noul" ? a.excluded.noul : 0;
  const prob = (t: string) => topic.probabilities[t] ?? 0;
  const mass = scout.topics.reduce((s, t) => s + prob(t), 0);
  const best = scout.topics.reduce((x, y) => (prob(y) > prob(x) ? y : x));
  const drop = (reason: string) => ({ keep: false, topic: mass >= 0.5 ? best : topic.choice, reason });
  if (isBlocklisted(scout, p)) return drop("excluded (blocklist)");
  if (mass < 0.5) return drop(`${topic.choice} (on-topic ${mass.toFixed(2)})`);
  // An official account announcing a partner's product is news, not promotion.
  if (speaker.choice === "promoter" && !isPrimary(scout, p.author)) return drop("promoter");
  if (excluded >= 0.6) return drop(`excluded ${excluded.toFixed(2)}`);
  return { keep: true, topic: best, reason: "on topic" };
}
