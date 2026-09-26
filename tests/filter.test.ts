import { describe, expect, it } from "vitest";
import { filterDecision, isBlocklisted } from "../src/filter";
import { compileProfile, loadScout } from "../src/profile";

const scout = loadScout("profiles/ai-apps.yaml");

const post = (text: string, author = "someone") => ({ text, author });
const ans = (probabilities: Record<string, number>, speaker = "maker", excluded = 0.1) => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return {
    topic: { type: "choice", choice, confidence: 0.5, probabilities },
    speaker: { type: "choice", choice: speaker, confidence: 0.9, probabilities: {} },
    excluded: { type: "noul", noul: excluded },
  } as any;
};

describe("filter", () => {
  it("matches blocklisted names and handles as whole words", () => {
    const blocking = compileProfile({ ...scout.profile, exclude: { blocklist: ["Globex", "initech.io"] } });
    expect(isBlocklisted(blocking, post("these guys at Globex just released an agent"))).toBe(true);
    expect(isBlocklisted(blocking, post("hello", "initech.io"))).toBe(true);
    expect(isBlocklisted(blocking, post("Stripe implemented WebMCP"))).toBe(false);
    expect(isBlocklisted(scout, post("Globex"))).toBe(false); // the example has no blocklist
    expect(filterDecision(blocking, post("Globex ships agents"), ans({ protocol: 0.9 })).reason).toBe("excluded (blocklist)");
  });
  it("keeps a post whose probability is split across two of our topics", () => {
    // Stripe + WebMCP: 0.40 protocol / 0.35 agentic_commerce — no single confident topic, but clearly on-topic
    expect(filterDecision(scout, post("x"), ans({ protocol: 0.4, agentic_commerce: 0.35, other_ai: 0.25 }))).toEqual({
      keep: true,
      topic: "protocol",
      reason: "on topic",
    });
  });
  it("drops off-topic, promoters and excluded posts with a reason", () => {
    expect(filterDecision(scout, post("x"), ans({ other_ai: 0.7, protocol: 0.3 }))).toMatchObject({
      keep: false,
      reason: "other_ai (on-topic 0.30)",
    });
    expect(filterDecision(scout, post("x"), ans({ protocol: 0.9 }, "promoter")).reason).toBe("promoter");
    // An official account announcing a partner is kept even when it reads like promotion.
    expect(filterDecision(scout, post("x", "stripe"), ans({ protocol: 0.9 }, "promoter")).keep).toBe(true);
    expect(filterDecision(scout, post("x"), ans({ protocol: 0.9 }, "maker", 0.75)).reason).toBe("excluded 0.75");
  });
});
