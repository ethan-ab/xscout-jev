import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverToSlack, formatSlack, postToSlack } from "../src/notify";
import type { Alert } from "../src/pipeline";
import { loadScout } from "../src/profile";

const scout = loadScout("profiles/ai-apps.yaml");

const alert = (over: Partial<Alert>): Alert => ({
  kind: "alert",
  at: "2026-09-19T00:00:00Z",
  eventId: 12,
  tier: "big",
  topic: "ai_host",
  score: 4.7,
  why: "score 4.7 · 2 official · 0 news · 2 acc/6h",
  title: "Opening access for developers to build Muse connectors <beta> & more",
  actions: [],
  authors: ["finkd", "Muse"],
  sources: ["https://x.com/finkd/status/1"],
  prompt: "",
  ...over,
});

describe("formatSlack", () => {
  it("renders an alert with tier, topic, escaped title and source link", () => {
    expect(formatSlack(scout, [alert({})])).toBe(
      "*BIG* · AI hosts · #12\nOpening access for developers to build Muse connectors &lt;beta&gt; &amp; more\n<https://x.com/finkd/status/1|@finkd> · 2 accounts · score 4.7 · 2 official · 0 news · 2 acc/6h",
    );
  });

  it("renders updates compactly and separates messages", () => {
    const out = formatSlack(scout, [
      alert({}),
      alert({ kind: "update", title: "2,000 submissions", sources: ["https://x.com/jrlevine/status/2"] }),
    ]);
    expect(out.split("\n\n")).toHaveLength(2);
    expect(out).toContain("*UPDATE* on #12 · <https://x.com/jrlevine/status/2|@jrlevine>\n2,000 submissions");
  });

  it("is empty when there is nothing to post", () => {
    expect(formatSlack(scout, [])).toBe("");
  });
});

describe("postToSlack", () => {
  it("posts the message to the webhook and fails loudly on an error", async () => {
    let body: any;
    const ok = (async (_u: unknown, i?: RequestInit) => {
      body = JSON.parse(String(i!.body));
      return new Response("ok");
    }) as typeof fetch;
    await postToSlack("https://hooks.slack.com/services/x", "*BIG* news", ok);
    expect(body).toEqual({ text: "*BIG* news", unfurl_links: false });
    const gone = (async () => new Response("no_service", { status: 404 })) as typeof fetch;
    await expect(postToSlack("https://hooks.slack.com/services/x", "hi", gone)).rejects.toThrow("slack webhook → 404: no_service");
  });
});

describe("deliverToSlack", () => {
  it("keeps a refused message and sends it first next time", async () => {
    const pending = join(mkdtempSync(join(tmpdir(), "scout-")), "slack-pending.txt");
    const sent: string[] = [];
    let up = false;
    const f = (async (_u: unknown, i?: RequestInit) => {
      if (!up) return new Response("down", { status: 500 });
      sent.push(JSON.parse(String(i!.body)).text);
      return new Response("ok");
    }) as typeof fetch;
    await expect(deliverToSlack("https://hooks", "first alert", pending, f)).rejects.toThrow("500");
    expect(readFileSync(pending, "utf8")).toContain("first alert");
    // Once Slack is back, the refused message goes out ahead of the new one.
    up = true;
    await deliverToSlack("https://hooks", "second alert", pending, f);
    expect(sent).toEqual(["first alert\n\nsecond alert"]);
    expect(existsSync(pending)).toBe(false);
    // A pending message is also sent on a run with nothing new.
    await expect(
      deliverToSlack("https://hooks", "third alert", pending, (async () => new Response("", { status: 500 })) as typeof fetch),
    ).rejects.toThrow();
    await deliverToSlack("https://hooks", "", pending, f);
    expect(sent.at(-1)).toBe("third alert");
  });
});
