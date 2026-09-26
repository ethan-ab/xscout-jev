import { describe, expect, it } from "vitest";
import { Store } from "../src/store";

const NOW = new Date("2026-09-23T09:00:00Z");

describe("Store", () => {
  it("dedupes posts and tracks poll times", () => {
    const s = new Store(":memory:");
    s.insertPost(
      {
        id: "1",
        author: "a",
        text: "t",
        url: "u",
        createdUtc: 1,
        kept: false,
        reason: "off_topic",
        topic: "off_topic",
        answers: {},
        eventId: null,
      },
      NOW,
    );
    expect(s.unseenIds(["1", "2"])).toEqual(["2"]);
    expect(s.lastRun("accounts")).toBeNull();
    s.setLastRun("accounts", NOW);
    expect(s.lastRun("accounts")).toEqual(NOW);
  });

  it("merges authors and keeps the best score and its actions", () => {
    const s = new Store(":memory:");
    const e = s.createEvent(
      {
        title: "Voice uses plugins",
        topic: "ai_host",
        url: "u",
        author: "reach_vb",
        score: 3.9,
        confidence: 0.6,
        actions: ["explainer"],
        titleRank: 1,
      },
      NOW,
    );
    const official = { author: "OpenAI", title: "ChatGPT Voice can now use plugins", titleRank: 3 };
    const up = s.addToEvent(e.id, { ...official, score: 4.9, confidence: 0.8, actions: ["how-to"] }, NOW);
    expect(up).toMatchObject({ authors: ["reach_vb", "OpenAI"], score: 4.9, confidence: 0.8, actions: ["how-to"] });
    // The official post becomes the headline; a later, weaker post does not take it back.
    expect(up.title).toBe("ChatGPT Voice can now use plugins");
    const same = s.addToEvent(e.id, { ...official, title: "wow", titleRank: 2, score: 2.0, confidence: 0.9, actions: [] }, NOW);
    expect(same).toMatchObject({
      authors: ["reach_vb", "OpenAI"],
      score: 4.9,
      actions: ["how-to"],
      title: "ChatGPT Voice can now use plugins",
    });
  });

  it("counts notable alerts over 24h and 7-day feedback", () => {
    const s = new Store(":memory:");
    const e = s.createEvent(
      { title: "t", topic: "protocol", url: "u", author: "a", score: 4.5, confidence: 0.8, actions: [], titleRank: 3 },
      NOW,
    );
    s.setStatus(e.id, "alerted", NOW, "notable");
    s.setFeedback(e.id, "skip");
    expect(s.alertsLast24h(NOW)).toBe(1);
    expect(s.alertsLast24h(new Date(NOW.getTime() + 25 * 3_600_000))).toBe(0);
    expect(s.feedbackStats(NOW)).toEqual({ total: 1, rejected: 1 });
  });

  it("refreshes a post's counts for velocity", () => {
    const s = new Store(":memory:");
    const e = s.createEvent(
      { title: "t", topic: "protocol", url: "u", author: "a", score: 4, confidence: 0.8, actions: [], titleRank: 1 },
      NOW,
    );
    const base = {
      id: "1",
      author: "a",
      text: "t",
      url: "u",
      createdUtc: 1,
      kept: true,
      reason: "on topic",
      topic: "protocol",
      answers: {},
    };
    s.insertPost({ ...base, eventId: e.id, metrics: { likes: 1, reposts: 0, quotes: 0 } }, NOW);
    s.refreshCounts("1", { likes: 10, reposts: 2, quotes: 1 });
    expect(s.eventPosts(e.id)[0]!.engagement).toBe(10 + 2 * 2 + 3 * 1);
  });

  it("reports spend for the last N days", () => {
    const s = new Store(":memory:");
    s.addCost(new Date("2026-09-10T12:00:00Z"), 1, 0);
    s.addCost(new Date("2026-09-22T12:00:00Z"), 0.5, 0.1);
    s.addCost(NOW, 0.25, 0);
    expect(s.costs(7, NOW).map((c) => c.day)).toEqual(["2026-09-23", "2026-09-22"]);
  });
});
