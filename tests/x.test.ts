import { beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/treg";
import { accountQueries, keywordQuery, normalize, searchX } from "../src/x";

beforeEach(() => {
  process.env.TREG_TOKEN = "t";
});

const item = {
  id: "2102444357508902978",
  text: "Stripe now supports WebMCP",
  createdUtc: 1790100000,
  authorUsername: "jeff_weinstein",
  authorName: "Jeff Weinstein",
  authorFollowers: 91000,
  isReply: false,
  viewCount: 91000,
  likeCount: 900,
  retweetCount: 80,
  replyCount: 40,
};

describe("queries", () => {
  it("chunks accounts into from: OR groups", () => {
    expect(accountQueries(["OpenAI", "stripe", "claudeai"], 1790000000, 2)).toEqual([
      "(from:OpenAI OR from:stripe) since_time:1790000000 -filter:replies -filter:retweets",
      "(from:claudeai) since_time:1790000000 -filter:replies -filter:retweets",
    ]);
  });
  it("builds a keyword query with a language and an engagement floor", () => {
    expect(keywordQuery("WebMCP", 1790000000, { lang: "en", minFaves: 10 })).toBe(
      "(WebMCP) lang:en since_time:1790000000 min_faves:10 -filter:replies -filter:retweets",
    );
    expect(keywordQuery("WebMCP", 1790000000, { minFaves: 0 })).toBe(
      "(WebMCP) since_time:1790000000 min_faves:0 -filter:replies -filter:retweets",
    );
  });
});

describe("searchX", () => {
  it("normalizes items and drops replies and posts older than since", async () => {
    let body: any;
    const f = (async (_u: any, i?: RequestInit) => {
      body = JSON.parse(String(i!.body));
      return new Response(
        JSON.stringify({
          output: { data: { items: [item, { ...item, id: "2", isReply: true }, { ...item, id: "3", createdUtc: 1780000000 }] } },
        }),
      );
    }) as typeof fetch;
    const posts = await searchX("q", 1790000000, new Ledger(), f);
    expect(body).toEqual({ query: "q", limit: 20, queryType: "Latest" });
    expect(posts).toEqual([normalize(item)]);
    expect(posts[0]).toMatchObject({ url: "https://x.com/jeff_weinstein/status/2102444357508902978", followers: 91000, reposts: 80 });
  });

  it("reads further pages until it reaches back to since", async () => {
    let calls = 0;
    const page = (ids: string[], created: number, next?: string) =>
      new Response(
        JSON.stringify({ output: { data: { items: ids.map((id) => ({ ...item, id, createdUtc: created })), nextCursor: next } } }),
      );
    const f = (async () => {
      calls++;
      return calls === 1 ? page(["a", "b"], 1790100000, "c1") : calls === 2 ? page(["c", "d"], 1789999000, "c2") : page(["e"], 1789000000);
    }) as typeof fetch;
    const posts = await searchX("q", 1790000000, new Ledger(), f, "Latest", 5);
    expect(calls).toBe(2); // the second page already reached past since
    expect(posts.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
