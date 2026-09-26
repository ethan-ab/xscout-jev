import type { JevResult } from "./jev";
import type { Question } from "./types";

export type DecideFn = (state: unknown, questions: Record<string, Question>) => Promise<JevResult>;

const keyTerms = (s: string, stop: Set<string>) =>
  new Set(
    (
      s
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .match(/[@$]?[a-z0-9][a-z0-9_.-]{3,}/g) ?? []
    )
      .map((w) => w.replace(/^[@$]/, "").replace(/[.-]+$/, ""))
      .filter((w) => w.length >= 4 && !stop.has(w)),
  );

// Code pre-selects the few open events sharing key terms with the post (product names, companies, handles), then Jev picks
// among them. A short list is far more reliable than a choice over every open event.
export function candidates(
  text: string,
  open: { id: number; title: string }[],
  stop: Set<string>,
  max = 12,
): { id: number; title: string }[] {
  const terms = keyTerms(text, stop);
  return open
    .map((e) => ({ e, overlap: [...keyTerms(e.title, stop)].filter((w) => terms.has(w)).length }))
    .filter((x) => x.overlap >= 1)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, max)
    .map((x) => x.e);
}

// Code owns the post→event link; Jev only says "same update or not".
export async function matchEvent(
  text: string,
  open: { id: number; title: string }[],
  decideFn: DecideFn,
  stop: Set<string>,
): Promise<number | null> {
  const short = candidates(text, open, stop);
  if (short.length === 0) return null;
  const criteria: Record<string, string> = Object.fromEntries(short.map((e) => [`e${e.id}`, e.title]));
  criteria.new_event = "none of the listed updates: this post is about a different update";
  const r = await decideFn(
    { post: text.slice(0, 900) },
    { same: { type: "choice", instructions: "Which listed update is this post about?", criteria } },
  );
  const a = r.answers.same;
  if (a?.type !== "choice") throw new Error("jev: event match answer missing");
  if (a.choice === "new_event" || (a.confidence ?? 0) < 0.5) return null;
  const id = Number(a.choice.slice(1));
  return short.some((e) => e.id === id) ? id : null;
}
