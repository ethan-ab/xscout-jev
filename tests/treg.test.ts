import { beforeEach, describe, expect, it } from "vitest";
import { Ledger, tregCall } from "../src/treg";

beforeEach(() => {
  process.env.TREG_TOKEN = "t";
});

describe("tregCall", () => {
  it("POSTs the body to /call/<id>, sends the token, records cost from X-Treg-Cost-Micro", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const f = (async (u: any, i?: RequestInit) => {
      url = String(u);
      init = i;
      return new Response('{"ok":1}', { headers: { "X-Treg-Cost-Micro": "750" } });
    }) as typeof fetch;
    const l = new Ledger();
    const r = await tregCall<{ ok: number }>("anyapi.x.search.posts", { body: { query: "x" } }, l, f);
    expect(url).toBe("https://treg.to/call/anyapi.x.search.posts");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["X-Treg-Token"]).toBe("t");
    expect(r).toEqual({ ok: 1 });
    expect(l.tregUsd).toBeCloseTo(0.00075);
  });

  it("uses GET with a query string when there is no body", async () => {
    let url = "";
    let method = "";
    const f = (async (u: any, i?: RequestInit) => {
      url = String(u);
      method = i!.method!;
      return new Response("{}");
    }) as typeof fetch;
    await tregCall("tikhub.x.twitter-web-fetch-tweet-detail", { query: { tweet_id: "1" } }, new Ledger(), f);
    expect(url).toBe("https://treg.to/call/tikhub.x.twitter-web-fetch-tweet-detail?tweet_id=1");
    expect(method).toBe("GET");
  });

  it("retries 5xx with the same Idempotency-Key and throws on 4xx", async () => {
    const keys: string[] = [];
    let n = 0;
    const flaky = (async (_u: any, i?: RequestInit) => {
      keys.push((i!.headers as Record<string, string>)["Idempotency-Key"]!);
      return ++n === 1 ? new Response("busy", { status: 503, headers: { "Retry-After": "0" } }) : new Response("{}");
    }) as typeof fetch;
    await tregCall("a.b", { body: {} }, new Ledger(), flaky);
    expect(keys[0]).toBe(keys[1]);
    const bad = (async () => new Response('{"error":"malformed_query"}', { status: 400 })) as typeof fetch;
    await expect(tregCall("a.b", { body: {} }, new Ledger(), bad)).rejects.toThrow(/treg a\.b → 400.*malformed_query/);
  });
});

describe("tregAuth", () => {
  it("adds X-Treg-Org for identity tokens", async () => {
    process.env.TREG_ORG = "acme";
    let h: Record<string, string> = {};
    const f = (async (_u: any, i?: RequestInit) => {
      h = i!.headers as Record<string, string>;
      return new Response("{}");
    }) as typeof fetch;
    try {
      await tregCall("a.b", { body: {} }, new Ledger(), f);
      expect(h["X-Treg-Org"]).toBe("acme");
    } finally {
      delete process.env.TREG_ORG;
    }
  });
});
