import { describe, expect, it } from "vitest";
import { filterDecision } from "../src/filter";
import { compileProfile, loadScout, parseProfile } from "../src/profile";

// Smallest useful profile: one topic, one keyword, the two score rubrics.
const minimal = () => ({
  name: "coffee",
  org: { name: "Bean Co", about: "Bean Co roasts specialty coffee and sells it online." },
  topics: [{ id: "roasting", what: "coffee roasting news" }],
  sources: { keywords: { roast: '"coffee roasting"' } },
  scoring: {
    significance: {
      question: "How big is this news?",
      levels: [
        { summary: "minor", signals: ["a tip"] },
        { summary: "major", signals: ["a launch"] },
      ],
    },
    relevance: {
      question: "How relevant is it to Bean Co?",
      levels: [
        { summary: "none", signals: ["other drinks"] },
        { summary: "core", signals: ["roasting"] },
      ],
    },
  },
});

describe("profile", () => {
  it("loads the ai-apps example", () => {
    const r = loadScout("profiles/ai-apps.yaml");
    expect(r.topics).toEqual(["ai_host", "protocol", "agentic_commerce", "personal_agent"]);
    expect(r.labels.personal_agent).toBe("Personal agents");
    expect(Object.keys(r.filterQuestions)).toEqual(["topic", "speaker", "excluded"]);
  });

  // What Jev receives for the ai-apps example, byte for byte (key order included). Any change here changes the scout's judgments.
  it("keeps the questions Jev receives for the ai-apps example", () => {
    const r = loadScout("profiles/ai-apps.yaml");
    expect(JSON.stringify({ filter: r.filterQuestions, score: r.scoreQuestions }, null, 1)).toMatchSnapshot();
  });

  it("fills sensible defaults for a minimal profile", () => {
    const r = compileProfile(parseProfile(minimal()));
    expect(r.profile.locale).toEqual({ timezone: "UTC" });
    expect(r.labels).toEqual({ roasting: "roasting" });
    expect(Object.keys((r.filterQuestions.topic as { criteria: object }).criteria)).toEqual(["roasting", "other", "off_topic"]);
    // No exclusion question configured: Jev is not asked, and the filter keeps the post.
    expect(r.filterQuestions.excluded).toBeUndefined();
    expect(r.blocklist).toBeNull();
    expect(r.policy.alertThreshold).toBe(3);
    const answers = {
      topic: { type: "choice", choice: "roasting", confidence: 0.9, probabilities: { roasting: 0.9 } },
      speaker: { type: "choice", choice: "reporter", confidence: 0.9, probabilities: {} },
    } as const;
    expect(filterDecision(r, { text: "x", author: "y" }, answers)).toEqual({ keep: true, topic: "roasting", reason: "on topic" });
  });

  it("uses neutral speaker examples unless the profile gives its own", () => {
    const speaker = (r: ReturnType<typeof compileProfile>) =>
      (r.filterQuestions.speaker as { criteria: Record<string, { examples: string[] }> }).criteria;
    expect(speaker(compileProfile(parseProfile(minimal()))).maker!.examples[0]).toMatch(/new release/);
    const custom = compileProfile(parseProfile({ ...minimal(), classification: { speaker_examples: { maker: ["Our roast is out"] } } }));
    expect(speaker(custom).maker!.examples).toEqual(["Our roast is out"]);
    expect(speaker(custom).reporter!.examples[0]).toMatch(/downloads/);
  });

  it("accepts a likes threshold per keyword", () => {
    const r = parseProfile({
      ...minimal(),
      sources: { keyword_min_faves: 20, keywords: { busy: "coffee", rare: { query: '"roastery fire"', min_faves: 0 } } },
    });
    expect(r.sources.keywords).toEqual({ busy: { query: "coffee", min_faves: 20 }, rare: { query: '"roastery fire"', min_faves: 0 } });
    expect(() => parseProfile({ ...minimal(), sources: { keywords: { bad: 3 } } })).toThrow(
      "sources.keywords.bad must be a search expression",
    );
  });

  it("applies policy overrides", () => {
    expect(compileProfile(parseProfile({ ...minimal(), policy: { alertThreshold: 3.5 } })).policy.alertThreshold).toBe(3.5);
  });

  it("explains what is wrong", () => {
    expect(() => parseProfile({ ...minimal(), topics: [] })).toThrow("profile: topics must list at least one topic");
    expect(() => parseProfile({ ...minimal(), locale: "Paris" })).toThrow("profile: locale must be a mapping");
    expect(() => parseProfile({ ...minimal(), sources: { keywords: { k: "x" }, keyword_every_minutes: 0 } })).toThrow(
      "sources.keyword_every_minutes must be greater than 0",
    );
    expect(() => parseProfile({ ...minimal(), classification: { other: { id: "off_topic" } } })).toThrow(
      "classification.other.id must not be off_topic",
    );
    expect(() =>
      parseProfile({
        ...minimal(),
        actions: [
          { id: "post", question: "a?" },
          { id: "post", question: "b?" },
        ],
      }),
    ).toThrow("actions has a duplicate id: post");
    expect(() =>
      parseProfile({
        ...minimal(),
        topics: [
          { id: "a", what: "x" },
          { id: "a", what: "y" },
        ],
      }),
    ).toThrow("duplicate id: a");
    expect(() => parseProfile({ ...minimal(), topics: [{ id: "off_topic", what: "x" }] })).toThrow("reserved ids");
    expect(() => parseProfile({ ...minimal(), sources: {} })).toThrow("sources must list at least one account or keyword");
    expect(() => parseProfile({ ...minimal(), policy: { alertTreshold: 3 } })).toThrow("policy.alertTreshold is not a known setting");
    expect(() => parseProfile({ ...minimal(), policy: { alertThreshold: "high" } })).toThrow("policy.alertThreshold must be a number");
    expect(() => parseProfile({ ...minimal(), org: { name: "Bean Co" } })).toThrow("profile: org.about must be a non-empty string");
    expect(() => parseProfile({ ...minimal(), draft: { template: "{company}" } })).toThrow(
      "draft.template uses unknown placeholder {company}",
    );
    expect(() => parseProfile({ ...minimal(), locale: { timezone: "Europe/Pari" } })).toThrow(
      "locale.timezone is not a known time zone: Europe/Pari",
    );
    expect(() => parseProfile({ ...minimal(), classification: { speaker_examples: { fan: ["x"] } } })).toThrow(
      "speaker_examples.fan must be one of",
    );
  });
});
