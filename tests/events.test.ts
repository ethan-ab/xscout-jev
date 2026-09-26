import { describe, expect, it } from "vitest";
import { candidates, matchEvent } from "../src/events";
import { loadScout } from "../src/profile";

const scout = loadScout("profiles/ai-apps.yaml");

const open = [
  { id: 7, title: "ChatGPT Voice can now use plugins like email and calendar" },
  { id: 9, title: "Meta and Stripe partner on agentic payments via the Muse Connector Platform" },
  { id: 12, title: "Shopify partners with Muse for agentic checkout with Shop Pay" },
];
const fakeDecide = (choice: string, confidence: number, expectKeys?: string[]) => async (_s: unknown, q: any) => {
  if (expectKeys) expect(Object.keys(q.same.criteria)).toEqual(expectKeys);
  return { answers: { same: { type: "choice", choice, confidence, probabilities: {} } } } as any;
};

describe("candidates", () => {
  it("keeps only events sharing key terms, best overlap first", () => {
    expect(candidates("Stripe x Meta: accept agentic payments in Muse", open, scout.stopwords).map((e) => e.id)).toEqual([9, 12]);
    expect(candidates("Anthropic ships a new model", open, scout.stopwords)).toEqual([]);
  });
});

describe("matchEvent", () => {
  it("asks Jev to choose among the pre-selected events only", async () => {
    expect(
      await matchEvent(
        "Stripe x Meta: accept agentic payments in Muse",
        open,
        fakeDecide("e9", 0.9, ["e9", "e12", "new_event"]),
        scout.stopwords,
      ),
    ).toBe(9);
  });
  it("returns null for new_event, low confidence or no candidate", async () => {
    expect(await matchEvent("Stripe payments via Muse", open, fakeDecide("new_event", 0.9), scout.stopwords)).toBeNull();
    expect(await matchEvent("Stripe payments via Muse", open, fakeDecide("e9", 0.3), scout.stopwords)).toBeNull();
    expect(await matchEvent("Anthropic ships a new model", open, fakeDecide("e7", 1), scout.stopwords)).toBeNull();
    // An answer naming an event that was not offered is ignored.
    expect(await matchEvent("Stripe payments via Muse", open, fakeDecide("e7", 1), scout.stopwords)).toBeNull();
  });
});
