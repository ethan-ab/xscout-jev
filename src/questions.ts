import type { Profile, Speaker, Topic } from "./profile";
import type { Question } from "./types";

// The shape of the Jev questions is fixed here; their content comes from the profile.

// A criterion with only a description is sent as a plain string.
const criterion = (c: { what: string; not_for?: string; examples?: string[] }) =>
  c.not_for === undefined && c.examples === undefined
    ? c.what
    : {
        what: c.what,
        ...(c.not_for !== undefined ? { not_for: c.not_for } : {}),
        ...(c.examples !== undefined ? { examples: c.examples } : {}),
      };

const SPEAKERS: Record<Speaker, { what: string; examples: string[] }> = {
  maker: {
    what: "the author or the author's company built and is launching or updating the product",
    examples: ["We're excited to announce that our new release is available today"],
  },
  reporter: {
    what: "the author reports or comments on someone else's product or news",
    examples: ["Acme's new app passed 2 million downloads in its first week"],
  },
  promoter: {
    what: "the author promotes someone else's product with hype or a call to action, like a paid influencer",
    examples: ["You won't believe what this tool can do. Sign up with my link and get 50% off"],
  },
  user: {
    what: "the author shares their own experience using a product",
    examples: ["I've used this app every day for a month and it saves me an hour"],
  },
};

const speakerQuestion = (p: Profile): Question => ({
  type: "choice",
  instructions: "Who is speaking, relative to the product in the post?",
  criteria: {
    ...Object.fromEntries(
      Object.entries(SPEAKERS).map(([k, v]) => [
        k,
        { what: v.what, examples: p.classification.speaker_examples[k as Speaker] ?? v.examples },
      ]),
    ),
    no_product: "no specific product: opinion, tutorial, course, meme",
  },
});

export function buildFilterQuestions(p: Profile): Record<string, Question> {
  const { classification: c } = p;
  const criteria: Record<string, unknown> = Object.fromEntries(p.topics.map((t: Topic) => [t.id, criterion(t)]));
  criteria[c.other.id] = c.other.what;
  criteria.off_topic = criterion(c.off_topic);
  return {
    topic: { type: "choice", instructions: { question: c.question, context: c.context }, criteria },
    speaker: speakerQuestion(p),
    ...(p.exclude.question
      ? { excluded: { type: "noul", instructions: { context: p.org.about, question: p.exclude.question } } satisfies Question }
      : {}),
  };
}

export function buildScoreQuestions(p: Profile): Record<string, Question> {
  const { significance: sig, relevance: rel } = p.scoring;
  return {
    significance: {
      type: "score",
      instructions: { question: sig.question, ...(sig.focus !== undefined ? { focus: sig.focus } : {}) },
      criteria: sig.levels,
    },
    relevance: { type: "score", instructions: { context: p.org.about, question: rel.question }, criteria: rel.levels },
    ...Object.fromEntries(
      p.actions.map((a) => [
        `action_${a.id}`,
        { type: "noul", instructions: { context: p.org.about, question: a.question } } satisfies Question,
      ]),
    ),
  };
}
