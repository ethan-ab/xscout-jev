import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { backtest } from "../src/backtest";
import { loadScout } from "../src/profile";

const scout = loadScout("profiles/ai-apps.yaml");

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "k";
  process.env.TREG_TOKEN = "t";
});

describe("backtest", () => {
  it("scores each post against its topic's threshold and counts recall and false alerts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-"));
    const labels = join(dir, "labels.tsv");
    writeFileSync(
      labels,
      [
        "expected\turl\tnote",
        "personal_agent\thttps://x.com/a/status/1\tagent launch",
        "protocol\thttps://x.com/b/status/2\tprotocol news",
        "out\thttps://x.com/c/status/3\tnoise",
      ].join("\n"),
    );
    // Cached posts, so no treg call is made.
    const cacheFile = join(dir, "cache.json");
    const detail = (text: string, author: string) => ({ data: { text, author: { screen_name: author } } });
    writeFileSync(cacheFile, JSON.stringify({ "1": detail("agent", "a"), "2": detail("protocol", "b"), "3": detail("noise", "c") }));
    const topicOf: Record<string, string> = { agent: "personal_agent", protocol: "protocol", noise: "off_topic" };
    const f = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const topic = topicOf[body.state.text]!;
      const score = (s: number) => ({ type: "score", score: s, confidence: 0.8, probabilities: {} });
      const answers = body.questions.topic
        ? {
            topic: { type: "choice", choice: topic, confidence: 0.9, probabilities: { [topic]: 0.9 } },
            speaker: { type: "choice", choice: "maker", probabilities: {} },
          }
        : { significance: score(1.1), relevance: score(1.1) };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 1000 } }));
    }) as typeof fetch;

    const r = await backtest(scout, labels, cacheFile, f);
    // Both on-topic posts score 2.2: under the 3.0 threshold, over personal_agent's 2.0 (threshold_offset -1).
    expect(r.results.map((x) => [x.expected, x.hit])).toEqual([
      ["personal_agent", true],
      ["protocol", false],
      ["out", false],
    ]);
    expect(r.recall).toEqual({ hits: 1, total: 2 });
    expect(r.falseAlerts).toEqual({ hits: 0, total: 1 });
    expect(r.byThreshold.find((b) => b.threshold === 2.5)?.recall).toBe(1);
    expect(r.tregUsd).toBe(0);
  });
});
