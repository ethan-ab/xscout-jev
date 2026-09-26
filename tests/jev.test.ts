import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "../src/jev";
import { Ledger } from "../src/treg";

const ENV = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"];
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.TYPESAFE_API_KEY = "k";
});
const ok = { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1000, output_tokens: 20 } };

describe("decide", () => {
  it("calls the direct TypeSafe endpoint and prices input tokens at $0.042/M", async () => {
    let sent: any;
    let url = "";
    const f = (async (u: any, i?: RequestInit) => {
      url = String(u);
      sent = JSON.parse(String(i!.body));
      return new Response(JSON.stringify(ok));
    }) as typeof fetch;
    const l = new Ledger();
    const r = await decide({ a: 1 }, { q: { type: "noul", instructions: "?" } }, l, f);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent.model).toBe("jev-1.13.0");
    expect(r.answers.q).toEqual({ type: "noul", noul: 0.9 });
    expect(l.jevUsd).toBeCloseTo(0.000042);
  });
  it("uses TYPESAFE_BASE_URL and the cost reported by a gateway", async () => {
    process.env.TYPESAFE_BASE_URL = "https://openrouter.ai/api/";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-1.13";
    let url = "";
    let sent: any;
    const f = (async (u: any, i?: RequestInit) => {
      url = String(u);
      sent = JSON.parse(String(i!.body));
      return new Response(JSON.stringify({ ...ok, usage: { input_tokens: 1000, cost: 0.00003 } }));
    }) as typeof fetch;
    const l = new Ledger();
    await decide({}, {}, l, f);
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(sent.model).toBe("jev-1.13");
    expect(l.jevUsd).toBeCloseTo(0.00003);
  });

  it("explains a missing key", async () => {
    delete process.env.TYPESAFE_API_KEY;
    await expect(decide({}, {}, new Ledger(), (async () => new Response(JSON.stringify(ok))) as typeof fetch)).rejects.toThrow(
      "TYPESAFE_API_KEY is not set",
    );
  });

  it("backs off on 429/529 and throws on 422", async () => {
    let n = 0;
    const f = (async () =>
      ++n < 3 ? new Response("", { status: n === 1 ? 429 : 529 }) : new Response(JSON.stringify(ok))) as typeof fetch;
    await decide({}, {}, new Ledger(), f, 0);
    expect(n).toBe(3);
    const bad = (async () => new Response('{"detail":"bad question"}', { status: 422 })) as typeof fetch;
    await expect(decide({}, {}, new Ledger(), bad, 0)).rejects.toThrow(/jev → 422/);
  });
});
