import { describe, expect, it } from "vitest";
import type { Heat } from "../src/heat";
import { adjustedThreshold, decideAlert, isQuiet, scorePost, thresholdFor } from "../src/policy";
import { compileProfile, loadScout } from "../src/profile";
import type { EventState } from "../src/types";

const scout = loadScout("profiles/ai-apps.yaml");

// Thresholds from the default policy: alert 3.0, major 4.0, watch margin 0.6 (score floor 2.4).
const WORKDAY = new Date("2026-09-23T09:00:00Z"); // Wed 11:00 Paris
const ev = (over: Partial<EventState>): EventState => ({
  id: 1,
  title: "t",
  status: "open",
  score: 3.5,
  confidence: 0.8,
  authors: ["someone"],
  actions: [],
  ...over,
});
const heat = (over: Partial<Heat>): Heat => ({
  firstUtc: 0,
  ageHours: 1,
  accounts: 1,
  burst6h: 1,
  primary: 0,
  amplifiers: 0,
  velocity: null,
  ...over,
});
const ctx = { now: WORKDAY, alertsToday: 0, threshold: 3.0, respectQuietHours: false };

describe("scorePost", () => {
  it("adds significance and relevance and keeps actions above the noul floor", () => {
    const s = scorePost(scout, {
      significance: { type: "score", score: 2.2, confidence: 0.7, probabilities: {} },
      relevance: { type: "score", score: 2.8, confidence: 0.9, probabilities: {} },
      action_how_to: { type: "noul", noul: 0.8 },
      action_explainer: { type: "noul", noul: 0.4 },
      action_hot_take: { type: "noul", noul: 0.65 },
      action_brand_showcase: { type: "noul", noul: 0.1 },
      action_data_point: { type: "noul", noul: 0.2 },
    });
    expect(s).toEqual({ score: 5, confidence: 0.7, actions: ["how-to", "hot take"] });
  });
});

describe("decideAlert: big news", () => {
  it("flags very important updates straight away when corroborated", () => {
    expect(decideAlert(scout, ev({ score: 4.2 }), heat({ primary: 1 }), ctx)).toMatchObject({ action: "alert", tier: "big" });
    expect(decideAlert(scout, ev({ score: 4.2 }), heat({ amplifiers: 1 }), ctx)).toMatchObject({ tier: "big" });
  });
  it("does not make a single unknown account big news, however high the score", () => {
    expect(decideAlert(scout, ev({ score: 4.4 }), heat({}), ctx)).toMatchObject({ action: "watch", reason: "single unofficial source" });
  });
  it("flags broad coverage even when Jev's score is only moderate", () => {
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ amplifiers: 2 }), ctx)).toMatchObject({ tier: "big" });
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ primary: 2 }), ctx)).toMatchObject({ tier: "big" });
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ primary: 1, burst6h: 4 }), ctx)).toMatchObject({ tier: "big" });
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ burst6h: 6 }), ctx)).toMatchObject({ tier: "big" });
  });
  it("never lets irrelevant chatter through, however viral", () => {
    expect(decideAlert(scout, ev({ score: 1.5 }), heat({ burst6h: 20, amplifiers: 5 }), ctx).action).toBe("drop");
  });
});

describe("decideAlert: trending and notable", () => {
  it("flags a young event spreading across accounts or growing fast", () => {
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ burst6h: 3 }), ctx)).toMatchObject({ tier: "trending" });
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ velocity: 400 }), ctx)).toMatchObject({ tier: "trending" });
    expect(decideAlert(scout, ev({ score: 2.6 }), heat({ burst6h: 3, ageHours: 20 }), ctx).action).toBe("watch");
  });
  it("keeps the notable rule for important single-source updates", () => {
    expect(decideAlert(scout, ev({}), heat({ primary: 1 }), ctx)).toMatchObject({ tier: "notable" });
    expect(decideAlert(scout, ev({}), heat({}), ctx)).toMatchObject({ action: "watch", reason: "single unofficial source" });
    expect(decideAlert(scout, ev({}), heat({ primary: 1 }), { ...ctx, alertsToday: 5 }).action).toBe("hold");
  });
  it("lets a single unofficial post alert when notableMinAccounts is 1", () => {
    const loose = compileProfile({ ...scout.profile, policy: { notableMinAccounts: 1 } });
    expect(decideAlert(loose, ev({}), heat({}), ctx)).toMatchObject({ action: "alert", tier: "notable" });
  });

  it("drops stale or already-alerted events", () => {
    expect(decideAlert(scout, ev({ score: 4.5 }), heat({ ageHours: 30, primary: 1 }), ctx).action).toBe("drop");
    expect(decideAlert(scout, ev({ status: "alerted", score: 4.5 }), heat({}), ctx).action).toBe("drop");
  });
  it("still releases an event held over a weekend", () => {
    const monday = { ...ctx, now: new Date("2026-09-28T07:05:00Z") };
    const held = ev({ status: "held", score: 4.5 });
    expect(decideAlert(scout, held, heat({ ageHours: 47, primary: 1 }), monday)).toMatchObject({ action: "alert", tier: "big" });
    expect(decideAlert(scout, held, heat({ ageHours: 80, primary: 1 }), monday).action).toBe("drop");
  });

  it("holds during quiet hours when enabled", () => {
    const night = { ...ctx, now: new Date("2026-09-23T21:00:00Z"), respectQuietHours: true };
    expect(decideAlert(scout, ev({ score: 4.5 }), heat({ primary: 1 }), night).action).toBe("hold");
  });
});

describe("thresholds and quiet hours", () => {
  it("lowers the bar for personal-agent news only", () => {
    expect(thresholdFor(scout, "personal_agent", 3.0)).toBe(2.0);
    expect(thresholdFor(scout, "protocol", 3.0)).toBe(3.0);
  });
  it("raises the threshold when most feedback is negative", () => {
    expect(adjustedThreshold(scout, { total: 8, rejected: 5 })).toBe(3.25);
    expect(adjustedThreshold(scout, { total: 4, rejected: 4 })).toBe(3.0);
  });
  it("knows Paris quiet hours and weekends", () => {
    expect(isQuiet(scout, WORKDAY)).toBe(false);
    expect(isQuiet(scout, new Date("2026-09-23T19:00:00Z"))).toBe(true); // Wednesday 21:00 in Paris
    expect(isQuiet(scout, new Date("2026-09-26T10:00:00Z"))).toBe(true); // Saturday
  });
});
