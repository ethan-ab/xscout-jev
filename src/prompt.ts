import type { Scout } from "./profile";

// No LLM API: the scout hands you a ready-to-paste prompt for Claude (or any assistant you already use).
export function draftPrompt(
  scout: Scout,
  e: { title: string; actions: string[] },
  posts: { author: string; text: string; url: string }[],
): string {
  const { org, draft } = scout.profile;
  const values: Record<string, string> = {
    org: org.name,
    about: org.about,
    title: e.title,
    actions: e.actions.join(", ") || "pick the best one",
    sources: posts.map((p) => `- @${p.author} (${p.url}): ${p.text.replace(/\s+/g, " ")}`).join("\n"),
  };
  // One pass, so braces inside post text are never treated as placeholders.
  return draft.template.replace(/\{([a-z_]+)\}/g, (m, name: string) => values[name] ?? m);
}
