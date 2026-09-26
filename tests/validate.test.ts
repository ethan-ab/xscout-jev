import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { compileProfile, loadScout, parseProfile } from "../src/profile";
import { checkOffline, checkOnline, keywordProblems } from "../src/validate";

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "k";
  process.env.TREG_TOKEN = "t";
});

describe("keywordProblems", () => {
  it("accepts well-formed X queries", () => {
    expect(keywordProblems('("personal agent" OR "AI assistant") (launch OR "now available")')).toEqual([]);
  });

  it("flags syntax that silently breaks a search", () => {
    const messages = (q: string) => keywordProblems(q).map((p) => p.message);
    expect(messages('"MCP App OR WebMCP')).toContain("unbalanced double quotes");
    expect(messages("(MCP OR WebMCP")).toContain("unbalanced parentheses");
    expect(messages("MCP) OR (WebMCP")).toContain("unbalanced parentheses");
    expect(messages("MCP OR")).toContain("dangling OR");
    expect(keywordProblems("coffee or tea")).toEqual([
      { level: "warning", message: "lowercase or/and are searched as words; X operators are OR and a space" },
    ]);
  });
});

describe("checkOffline", () => {
  it("estimates daily searches", () => {
    // ai-apps example: 43 accounts in 4 groups every 10 minutes, 17 keywords every 30 minutes.
    expect(checkOffline(loadScout("profiles/ai-apps.yaml")).find((c) => c.where === "cost")?.message).toMatch(/^about 1392 searches a day/);
  });

  it("passes every example profile without errors", () => {
    for (const f of readdirSync("profiles").filter((name) => name.endsWith(".yaml")))
      expect(checkOffline(loadScout(`profiles/${f}`)).filter((c) => c.level === "error")).toEqual([]);
  });

  it("reports bad handles, broken keywords, scales too short to alert and missing keys", () => {
    delete process.env.TYPESAFE_API_KEY;
    const r = compileProfile(
      parseProfile({
        name: "t",
        org: { name: "T", about: "T sells things." },
        topics: [{ id: "a", what: "a" }],
        sources: { primary: { "@acme": "official" }, keywords: { k: '"broken' } },
        scoring: {
          significance: {
            question: "?",
            levels: [
              { summary: "a", signals: [] },
              { summary: "b", signals: [] },
            ],
          },
          relevance: {
            question: "?",
            levels: [
              { summary: "a", signals: [] },
              { summary: "b", signals: [] },
            ],
          },
        },
      }),
    );
    const errors = checkOffline(r)
      .filter((c) => c.level === "error")
      .map((c) => c.where);
    expect(errors).toEqual(["sources.primary.@acme", "sources.keywords.k", "topics.a", "env"]);
  });
});

describe("checkOnline", () => {
  it("tells missing accounts from quiet ones and reports keyword volume", async () => {
    const r = loadScout("profiles/competitive-intel.yaml");
    const now = new Date("2026-09-23T09:00:00Z");
    const t = Math.floor(now.getTime() / 1000);
    const post = (id: string, author: string, ago: number) => ({
      id,
      text: "x",
      createdUtc: t - ago,
      authorUsername: author,
      authorName: author,
      authorFollowers: 1,
      isReply: false,
      likeCount: 1,
      retweetCount: 0,
      replyCount: 0,
    });
    const f = (async (_u: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init!.body));
      const items = query.startsWith("from:convex ")
        ? []
        : query.startsWith("from:xata ")
          ? [post("0", "xata", 90 * 86400)]
          : query.startsWith("from:")
            ? [post("1", "a", 3600)]
            : [post("2", "b", 3600), post("3", "c", 3600)];
      return new Response(JSON.stringify({ output: { data: { items } } }), { headers: { "X-Treg-Cost-Micro": "1000" } });
    }) as typeof fetch;
    const { checks, tregUsd } = await checkOnline(r, f, now);
    expect(checks).toContainEqual({
      level: "warning",
      where: "@convex",
      message: "no original posts found (replies and reposts do not count): misspelled, renamed, protected, or it only replies",
    });
    expect(checks).toContainEqual({
      level: "warning",
      where: "@xata",
      message: "inactive: no original post in 30 days, last on 2026-06-25",
    });
    expect(checks).toContainEqual({
      level: "info",
      where: "sources.keywords.competitors",
      message: "2 posts with 10+ likes in the last 24 h",
    });
    expect(checks.filter((c) => c.level === "warning")).toHaveLength(2);
    expect(tregUsd).toBeCloseTo((6 + 3 + 1) * 0.001); // one search per account and per keyword
  });

  it("warns when most accounts are quiet, as when a field is thin on X", async () => {
    const r = loadScout("profiles/competitive-intel.yaml");
    const empty = (async () => new Response(JSON.stringify({ output: { data: { items: [] } } }))) as typeof fetch;
    const { checks } = await checkOnline(r, empty);
    expect(checks.find((c) => c.where === "sources")?.message).toMatch(
      /^9 of 9 accounts are missing or inactive: this field may be quiet on X/,
    );
  });
});
