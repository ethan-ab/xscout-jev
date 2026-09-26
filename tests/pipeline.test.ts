import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runPoll } from "../src/pipeline";
import { compileProfile, loadScout } from "../src/profile";
import { replay } from "../src/replay";
import { Store } from "../src/store";

const scout = loadScout("profiles/ai-apps.yaml");

beforeEach(() => {
  process.env.TREG_TOKEN = "t";
  process.env.TYPESAFE_API_KEY = "k";
});

const NOW = new Date("2026-09-23T09:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const item = (id: string, author: string, text: string, ago: number) => ({
  id,
  text,
  createdUtc: T - ago,
  authorUsername: author,
  authorName: author,
  authorFollowers: 500000,
  isReply: false,
  viewCount: 100000,
  likeCount: 1000,
  retweetCount: 100,
  replyCount: 50,
});
const OFFICIAL = item("100", "OpenAI", "ChatGPT Voice can now use plugins like email and calendar", 600);
const ECHO = item("101", "reach_vb", "Massive update: ChatGPT Voice can use plugins now", 300);
const NOISE = item("102", "someone", "Canadians back closer ties with the EU", 200);

// Fake treg + Jev: answers depend on which question set is asked.
function fakeFetch(calls: { treg: number; jev: number }): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init!.body));
    if (url.startsWith("https://treg.to/")) {
      calls.treg++;
      const items = body.query.includes("from:") ? [OFFICIAL] : [ECHO, NOISE];
      return new Response(JSON.stringify({ output: { data: { items } } }), { headers: { "X-Treg-Cost-Micro": "750" } });
    }
    calls.jev++;
    const text: string = body.state.text ?? body.state.post;
    const q = body.questions;
    const onTopic = text.includes("plugins");
    let answers: any;
    if (q.topic) {
      answers = {
        topic: {
          type: "choice",
          choice: onTopic ? "ai_host" : "off_topic",
          confidence: 0.95,
          probabilities: onTopic ? { ai_host: 0.95, other_ai: 0.05 } : { off_topic: 0.95, other_ai: 0.05 },
        },
        speaker: { type: "choice", choice: "maker", confidence: 0.9, probabilities: {} },
        excluded: { type: "noul", noul: 0.05 },
      };
    } else if (q.significance) {
      answers = {
        significance: { type: "score", score: 2.4, confidence: 0.8, probabilities: {} },
        relevance: { type: "score", score: 2.6, confidence: 0.9, probabilities: {} },
        action_how_to: { type: "noul", noul: 0.3 },
        action_explainer: { type: "noul", noul: 0.9 },
        action_hot_take: { type: "noul", noul: 0.2 },
        action_brand_showcase: { type: "noul", noul: 0.1 },
        action_data_point: { type: "noul", noul: 0.1 },
      };
    } else {
      const first = Object.keys(q.same.criteria)[0]!;
      answers = { same: { type: "choice", choice: first, confidence: 0.9, probabilities: {} } };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } }));
  }) as typeof fetch;
}

describe("runPoll", () => {
  it("collects, filters, groups into one event, alerts once and writes the alert file", async () => {
    const store = new Store(":memory:");
    const alertsFile = join(mkdtempSync(join(tmpdir(), "scout-")), "alerts.jsonl");
    const calls = { treg: 0, jev: 0 };
    const r = await runPoll(scout, store, { now: NOW, fetchImpl: fakeFetch(calls), alertsFile });

    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ fetched: 3, fresh: 3, kept: 2, events: 1 });
    // Each post remembers the search that found it, for `scout posts`.
    const keyword = Object.keys(scout.profile.sources.keywords)[0];
    expect(r.bySource).toEqual({ accounts: 1, [`keyword:${keyword}`]: 2 });
    expect(store.listPosts("dropped").map((p) => [p.id, p.source, p.reason])).toEqual([
      ["102", `keyword:${keyword}`, "off_topic (on-topic 0.00)"],
    ]);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({
      kind: "alert",
      tier: "big",
      topic: "ai_host",
      score: 5,
      actions: ["explainer"],
      authors: ["OpenAI", "reach_vb"],
    });
    expect(r.alerts[0]!.prompt).toContain("https://x.com/reach_vb/status/101");
    expect(readFileSync(alertsFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(r.tregCalls).toBe(calls.treg);
    expect(r.tregUsd).toBeCloseTo(calls.treg * 0.00075);

    const again = await runPoll(scout, store, { now: new Date(NOW.getTime() + 31 * 60_000), fetchImpl: fakeFetch(calls), alertsFile });
    expect(again.fresh).toBe(0);
    expect(again.alerts).toEqual([]);
  });
});

describe("runPoll limits", () => {
  const withBudget = (usd: number) => compileProfile({ ...scout.profile, budget: { usd_per_day: usd } });
  const alertsFile = () => join(mkdtempSync(join(tmpdir(), "scout-")), "alerts.jsonl");

  it("makes no call once today's budget is spent, and does not skip the window", async () => {
    const store = new Store(":memory:");
    store.addCost(NOW, 0.5, 0.5);
    const calls = { treg: 0, jev: 0 };
    const r = await runPoll(withBudget(1), store, { now: NOW, fetchImpl: fakeFetch(calls), alertsFile: alertsFile() });
    expect(calls).toEqual({ treg: 0, jev: 0 });
    expect(r).toMatchObject({ budgetReached: true, errors: ["daily budget of $1 reached"] });
    expect(store.lastRun("accounts")).toBeNull();
  });

  it("counts what was already spent today elsewhere, as a scan does with the live database", async () => {
    const calls = { treg: 0, jev: 0 };
    const r = await runPoll(withBudget(1), new Store(":memory:"), { now: NOW, fetchImpl: fakeFetch(calls), scanHours: 24, spentToday: 1 });
    expect(calls).toEqual({ treg: 0, jev: 0 });
    expect(r.budgetReached).toBe(true);
  });

  it("stops before the budget runs out, even with calls in parallel, and keeps skipped searches for later", async () => {
    const store = new Store(":memory:");
    const calls = { treg: 0, jev: 0 };
    // Searches cost $0.00075 each and run eight at a time: without counting calls in flight, the first wave alone would overspend.
    const r = await runPoll(withBudget(0.002), store, { now: NOW, fetchImpl: fakeFetch(calls), alertsFile: alertsFile() });
    expect(r.budgetReached).toBe(true);
    expect(r.tregUsd + r.jevUsd).toBeLessThanOrEqual(0.002);
    expect(calls.treg).toBeLessThan(r.searches);
    // Some account searches were skipped, so the next run searches the same window again.
    expect(store.lastRun("accounts")).toBeNull();
  });

  it("keeps the previous run time for a source whose search failed", async () => {
    const store = new Store(":memory:");
    const ok = fakeFetch({ treg: 0, jev: 0 });
    const keywordsDown = (async (input: any, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (String(input).startsWith("https://treg.to/") && !body.query.includes("from:")) return new Response("down", { status: 400 });
      return ok(input, init);
    }) as typeof fetch;
    const r = await runPoll(scout, store, { now: NOW, fetchImpl: keywordsDown, alertsFile: alertsFile() });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(store.lastRun("accounts")).toEqual(NOW);
    expect(store.lastRun("keywords")).toBeNull();
  });
});

describe("runPoll details", () => {
  const alertsFile = () => join(mkdtempSync(join(tmpdir(), "scout-")), "alerts.jsonl");

  it("drops blocklisted posts without asking Jev", async () => {
    const r2 = compileProfile({ ...scout.profile, exclude: { ...scout.profile.exclude, blocklist: ["Canadians"] } });
    const store = new Store(":memory:");
    const asked: string[] = [];
    const base = fakeFetch({ treg: 0, jev: 0 });
    const f = (async (input: any, init?: RequestInit) => {
      if (String(input).includes("systemone")) asked.push(JSON.parse(String(init!.body)).state.text ?? "");
      return base(input, init);
    }) as typeof fetch;
    await runPoll(r2, store, { now: NOW, fetchImpl: f, alertsFile: alertsFile() });
    expect(asked.some((t) => t.includes("Canadians"))).toBe(false);
    expect(store.listPosts("dropped").find((p) => p.id === "102")?.reason).toBe("excluded (blocklist)");
    expect(store.eventOfPost("102")).toBeNull();
  });

  it("matches handles case-insensitively", async () => {
    const primary = Object.fromEntries(Object.entries(scout.profile.sources.primary).map(([h, role]) => [h.toUpperCase(), role]));
    const upper = compileProfile({ ...scout.profile, sources: { ...scout.profile.sources, primary } });
    const r = await runPoll(upper, new Store(":memory:"), {
      now: NOW,
      fetchImpl: fakeFetch({ treg: 0, jev: 0 }),
      alertsFile: alertsFile(),
    });
    // OpenAI (returned as "OpenAI", listed as "OPENAI") still counts as an official source.
    expect(r.alerts[0]?.why).toContain("1 official");
  });

  it("counts a post below the floor as coverage of an existing event, but never starts one with it", async () => {
    const WEAK = item("103", "someone2", "meh, ChatGPT Voice plugins again", 100);
    const LONE = item("104", "someone3", "plugins plugins everywhere", 50);
    const base = fakeFetch({ treg: 0, jev: 0 });
    const f = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init!.body));
      if (url.startsWith("https://treg.to/") && !body.query.includes("from:"))
        return new Response(JSON.stringify({ output: { data: { items: [ECHO, WEAK, LONE] } } }));
      const text: string = body.state?.text ?? body.state?.post ?? "";
      if (body.questions?.significance && (text.includes("meh") || text.includes("everywhere"))) {
        const low = { type: "score", score: 0.5, confidence: 0.8, probabilities: {} };
        return new Response(JSON.stringify({ model: "m", answers: { significance: low, relevance: low }, usage: { input_tokens: 1 } }));
      }
      // Jev judges the lone post to be about a different update.
      if (body.questions?.same && text.includes("everywhere"))
        return new Response(
          JSON.stringify({
            model: "m",
            answers: { same: { type: "choice", choice: "new_event", confidence: 0.9, probabilities: {} } },
            usage: { input_tokens: 1 },
          }),
        );
      return base(input, init);
    }) as typeof fetch;
    const store = new Store(":memory:");
    const r = await runPoll(scout, store, { now: NOW, fetchImpl: f, alertsFile: alertsFile() });
    expect(r.events).toBe(1);
    expect(store.eventOfPost("103")).toBe(store.eventOfPost("100"));
    expect(store.listPosts("kept").find((p) => p.id === "103")?.reason).toBe("score 1.00 below floor, counted as coverage");
    expect(store.eventOfPost("104")).toBeNull();
    // The event keeps the official post's score and headline.
    expect(store.event(store.eventOfPost("100")!)).toMatchObject({
      score: 5,
      title: "ChatGPT Voice can now use plugins like email and calendar",
    });
  });

  it("counts searches so a scheduler can tell a total failure from a partial one", async () => {
    const down = (async () => new Response("down", { status: 400 })) as typeof fetch;
    const r = await runPoll(scout, new Store(":memory:"), { now: NOW, fetchImpl: down, alertsFile: alertsFile() });
    expect(r.searches).toBeGreaterThan(0);
    expect(r.failedSearches).toBe(r.searches);
  });
});

describe("replay", () => {
  it("finds when an event would have been flagged, from post timestamps only", async () => {
    const store = new Store(":memory:");
    const alertsFile = join(mkdtempSync(join(tmpdir(), "scout-")), "alerts.jsonl");
    await runPoll(scout, store, { now: NOW, fetchImpl: fakeFetch({ treg: 0, jev: 0 }), alertsFile, scanHours: 24 });
    const flags = replay(scout, store, 3.0);
    expect(flags).toHaveLength(1);
    // First post (OpenAI) scores 5 → big at once; accounts are searched every 10 minutes
    expect(flags[0]).toMatchObject({ tier: "big", lagMin: 10, accounts: 2, firstUtc: T - 600 });
  });
});
