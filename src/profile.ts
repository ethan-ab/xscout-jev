import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { DEFAULT_POLICY, type Policy } from "./config";
import { buildFilterQuestions, buildScoreQuestions } from "./questions";
import type { Question } from "./types";

// A profile: everything about what to watch and why, in one YAML file. Fields are documented in docs/profile.md.

export interface Topic {
  id: string;
  label: string;
  what: string;
  not_for?: string;
  examples?: string[];
  threshold_offset?: number;
}

interface Keyword {
  query: string; // X search expression
  min_faves: number;
}

interface Level {
  summary: string;
  signals: string[];
}

export interface Profile {
  name: string;
  org: { name: string; about: string };
  locale: { timezone: string; lang?: string }; // no lang: keyword searches cover every language
  topics: Topic[];
  classification: {
    question: string;
    context: string;
    other: { id: string; what: string };
    off_topic: { what: string; examples?: string[] };
    speaker_examples: Partial<Record<Speaker, string[]>>; // replaces the default example posts for each kind of speaker
  };
  sources: {
    primary: Record<string, string>; // official accounts: interesting from the first minute, no engagement floor
    amplifiers: Record<string, string>; // news accounts: coverage by several of them is the strongest "big news" signal
    keywords: Record<string, Keyword>; // written as `name: query` or `name: {query, min_faves}`
    keyword_min_faves: number; // default for keywords without their own min_faves
    keyword_lookback_hours: number; // re-scan this window so fresh posts can gather likes; the store dedupes
    keyword_every_minutes: number;
  };
  exclude: { blocklist: string[]; question?: string };
  scoring: {
    significance: { question: string; focus?: string; levels: Level[] };
    relevance: { question: string; levels: Level[] };
  };
  actions: { id: string; label: string; question: string }[];
  draft: { template: string }; // placeholders: {org} {about} {title} {actions} {sources}
  grouping: { stopwords: string[] };
  policy: Partial<Policy>;
  budget: { usd_per_day?: number }; // stop calling treg and Jev once today's spend (UTC) reaches this
}

// The profile compiled into what the engine needs at run time.
export interface Scout {
  profile: Profile;
  topics: string[];
  labels: Record<string, string>;
  primary: Map<string, string>; // lowercased handle → role (X handles are case-insensitive)
  amplifiers: Map<string, string>;
  blocklist: RegExp | null;
  stopwords: Set<string>;
  policy: Policy;
  filterQuestions: Record<string, Question>;
  scoreQuestions: Record<string, Question>;
  actionLabels: Record<string, string>; // action id → label
}

const SPEAKERS = ["maker", "reporter", "promoter", "user"] as const;
export type Speaker = (typeof SPEAKERS)[number];

const DRAFT_PLACEHOLDERS = ["org", "about", "title", "actions", "sources"];
const DEFAULT_DRAFT = `You write social media posts for {org}. {about}
Only state facts found in the sources below, and cite each one with its URL.

Update: {title}
Suggested actions: {actions}
Sources:
{sources}

Give me: the angle, a one-line hook, a 3–5 bullet outline, then a draft under 180 words.`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (path: string, msg: string): never => {
  throw new Error(`profile: ${path} ${msg}`);
};

function obj(v: unknown, path: string): Obj {
  return isObj(v) ? v : fail(path, "must be a mapping");
}
function str(o: Obj, key: string, path: string): string {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v : fail(`${path}.${key}`, "must be a non-empty string");
}
function optStr(o: Obj, key: string, path: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, path);
}
function num(o: Obj, key: string, path: string, fallback: number): number {
  const v = o[key] ?? fallback;
  return typeof v === "number" && Number.isFinite(v) ? v : fail(`${path}.${key}`, "must be a number");
}
function strList(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(path, "must be a list of strings");
  return v as string[];
}
function optStrList(o: Obj, key: string, path: string): string[] | undefined {
  return o[key] === undefined ? undefined : strList(o[key], `${path}.${key}`);
}
function strMap(v: unknown, path: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  const o = obj(v, path);
  for (const [k, x] of Object.entries(o)) if (typeof x !== "string") fail(`${path}.${k}`, "must be a string");
  return o as Record<string, string>;
}
// An optional section: absent is fine, present must be a mapping.
function section(o: Obj, key: string, prefix = ""): Obj {
  return o[key] === undefined ? {} : obj(o[key], `${prefix}${key}`);
}
function positive(o: Obj, key: string, path: string, fallback: number): number {
  const v = num(o, key, path, fallback);
  return v > 0 ? v : fail(`${path}.${key}`, "must be greater than 0");
}
function parseActions(list: unknown[]): Profile["actions"] {
  const actions = list.map((a, i) => {
    const o = obj(a, `actions[${i}]`);
    const id = str(o, "id", `actions[${i}]`);
    return { id, label: optStr(o, "label", `actions[${i}]`) ?? id, question: str(o, "question", `actions[${i}]`) };
  });
  const ids = actions.map((a) => a.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) fail("actions", `has a duplicate id: ${dup}`);
  return actions;
}
function levels(v: unknown, path: string): Level[] {
  if (!Array.isArray(v) || v.length < 2) fail(path, "must list at least two levels, lowest first");
  return (v as unknown[]).map((l, i) => {
    const o = obj(l, `${path}[${i}]`);
    return { summary: str(o, "summary", `${path}[${i}]`), signals: strList(o.signals, `${path}[${i}].signals`) };
  });
}
const withOptional = <T extends Obj>(base: T, extra: Obj): T => {
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (base as Obj)[k] = v;
  return base;
};

export function parseProfile(raw: unknown): Profile {
  const r = obj(raw, "(root)");
  const org = obj(r.org, "org");
  const orgName = str(org, "name", "org");
  const about = str(org, "about", "org");
  const locale = section(r, "locale");

  if (!Array.isArray(r.topics) || r.topics.length === 0) fail("topics", "must list at least one topic");
  const topics = (r.topics as unknown[]).map((t, i): Topic => {
    const o = obj(t, `topics[${i}]`);
    const path = `topics[${i}]`;
    const topic = withOptional(
      { id: str(o, "id", path), label: optStr(o, "label", path) ?? str(o, "id", path), what: str(o, "what", path) },
      { not_for: optStr(o, "not_for", path), examples: optStrList(o, "examples", path) },
    ) as Topic;
    if (o.threshold_offset !== undefined) topic.threshold_offset = num(o, "threshold_offset", path, 0);
    return topic;
  });
  const ids = topics.map((t) => t.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) fail("topics", `has a duplicate id: ${dup}`);

  const c = section(r, "classification");
  const otherRaw = section(c, "other", "classification.");
  const other = {
    id: optStr(otherRaw, "id", "classification.other") ?? "other",
    what: optStr(otherRaw, "what", "classification.other") ?? "none of the topics above",
  };
  const offRaw = section(c, "off_topic", "classification.");
  const offTopic = withOptional(
    { what: optStr(offRaw, "what", "classification.off_topic") ?? "unrelated to the topics we track" },
    { examples: optStrList(offRaw, "examples", "classification.off_topic") },
  );
  if (other.id === "off_topic") fail("classification.other.id", "must not be off_topic");
  if (ids.includes(other.id) || ids.includes("off_topic")) fail("topics", `must not use the reserved ids ${other.id} or off_topic`);
  const speakerRaw = c.speaker_examples === undefined ? {} : obj(c.speaker_examples, "classification.speaker_examples");
  const speakerExamples: Partial<Record<Speaker, string[]>> = {};
  for (const [k, v] of Object.entries(speakerRaw)) {
    if (!(SPEAKERS as readonly string[]).includes(k)) fail(`classification.speaker_examples.${k}`, `must be one of ${SPEAKERS.join(", ")}`);
    speakerExamples[k as Speaker] = strList(v, `classification.speaker_examples.${k}`);
  }

  const s = obj(r.sources, "sources");
  const minFaves = num(s, "keyword_min_faves", "sources", 10);
  const sources = {
    primary: strMap(s.primary, "sources.primary"),
    amplifiers: strMap(s.amplifiers, "sources.amplifiers"),
    keywords: keywords(s.keywords, minFaves),
    keyword_min_faves: minFaves,
    keyword_lookback_hours: positive(s, "keyword_lookback_hours", "sources", 3),
    keyword_every_minutes: positive(s, "keyword_every_minutes", "sources", 30),
  };
  if (!Object.keys(sources.primary).length && !Object.keys(sources.amplifiers).length && !Object.keys(sources.keywords).length)
    fail("sources", "must list at least one account or keyword");

  const ex = section(r, "exclude");
  const exclude = withOptional(
    { blocklist: ex.blocklist === undefined ? [] : strList(ex.blocklist, "exclude.blocklist") },
    { question: optStr(ex, "question", "exclude") },
  );

  const sc = obj(r.scoring, "scoring");
  const sig = obj(sc.significance, "scoring.significance");
  const rel = obj(sc.relevance, "scoring.relevance");
  const scoring = {
    significance: withOptional(
      { question: str(sig, "question", "scoring.significance") },
      { focus: optStr(sig, "focus", "scoring.significance"), levels: levels(sig.levels, "scoring.significance.levels") },
    ) as Profile["scoring"]["significance"],
    relevance: { question: str(rel, "question", "scoring.relevance"), levels: levels(rel.levels, "scoring.relevance.levels") },
  };

  const actions = (r.actions === undefined ? [] : Array.isArray(r.actions) ? r.actions : fail("actions", "must be a list")) as unknown[];
  const d = section(r, "draft");
  const g = section(r, "grouping");

  const policy = r.policy === undefined ? {} : obj(r.policy, "policy");
  for (const [k, v] of Object.entries(policy)) {
    if (!(k in DEFAULT_POLICY)) fail(`policy.${k}`, `is not a known setting (${Object.keys(DEFAULT_POLICY).join(", ")})`);
    if (typeof v !== typeof DEFAULT_POLICY[k as keyof Policy]) fail(`policy.${k}`, `must be a ${typeof DEFAULT_POLICY[k as keyof Policy]}`);
  }

  return {
    name: /^[a-z0-9][a-z0-9_-]*$/i.test(str(r, "name", "(root)"))
      ? String(r.name)
      : fail("name", "must be letters, digits, - or _ (it names the data folder)"),
    org: { name: orgName, about },
    locale: withOptional({ timezone: timezone(locale) }, { lang: optStr(locale, "lang", "locale") }),
    topics,
    classification: {
      question: optStr(c, "question", "classification") ?? "Which topic is this X post mainly about?",
      context:
        optStr(c, "context", "classification") ??
        `We track ${topics.length} topics. Pick ${other.id} for posts related to them but outside all of them and off_topic for anything else.`,
      other,
      off_topic: offTopic,
      speaker_examples: speakerExamples,
    },
    sources,
    exclude,
    scoring,
    actions: parseActions(actions),
    draft: { template: draftTemplate(d) },
    grouping: { stopwords: g.stopwords === undefined ? [] : strList(g.stopwords, "grouping.stopwords") },
    policy: policy as Partial<Policy>,
    budget: parseBudget(r.budget),
  };
}

function keywords(v: unknown, minFaves: number): Record<string, Keyword> {
  if (v === undefined || v === null) return {};
  const out: Record<string, Keyword> = {};
  for (const [name, k] of Object.entries(obj(v, "sources.keywords"))) {
    const path = `sources.keywords.${name}`;
    if (typeof k === "string" && k.trim()) out[name] = { query: k, min_faves: minFaves };
    else if (isObj(k)) out[name] = { query: str(k, "query", path), min_faves: num(k, "min_faves", path, minFaves) };
    else fail(path, "must be a search expression, or a mapping with query and min_faves");
  }
  return out;
}

function timezone(locale: Obj): string {
  const tz = optStr(locale, "timezone", "locale") ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    fail("locale.timezone", `is not a known time zone: ${tz} (use an IANA name such as Europe/Paris)`);
  }
  return tz;
}

function parseBudget(v: unknown): Profile["budget"] {
  if (v === undefined) return {};
  const b = obj(v, "budget");
  if (b.usd_per_day === undefined) return {};
  const usd = num(b, "usd_per_day", "budget", 0);
  if (usd <= 0) fail("budget.usd_per_day", "must be greater than 0");
  return { usd_per_day: usd };
}

function draftTemplate(d: Obj): string {
  const t = optStr(d, "template", "draft") ?? DEFAULT_DRAFT;
  for (const [, name] of t.matchAll(/\{([a-z_]+)\}/g))
    if (!DRAFT_PLACEHOLDERS.includes(name!))
      fail("draft.template", `uses unknown placeholder {${name}} (known: ${DRAFT_PLACEHOLDERS.join(", ")})`);
  return t;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Common words that never identify an update, used when matching posts to events.
const STOPWORDS =
  "about after again also been being could does from have here into just like make more most much news only other over same some such than that their them then there these they this very want were what when which while will with would your today launch launched launching introducing announced announcing".split(
    " ",
  );

const byHandle = (m: Record<string, string>) => new Map(Object.entries(m).map(([h, role]) => [h.toLowerCase(), role]));

export function compileProfile(profile: Profile): Scout {
  const block = profile.exclude.blocklist;
  return {
    profile,
    topics: profile.topics.map((t) => t.id),
    labels: Object.fromEntries(profile.topics.map((t) => [t.id, t.label])),
    primary: byHandle(profile.sources.primary),
    amplifiers: byHandle(profile.sources.amplifiers),
    blocklist: block.length ? new RegExp(`\\b(${block.map(escapeRegExp).join("|")})\\b`, "i") : null,
    stopwords: new Set([...STOPWORDS, ...profile.grouping.stopwords.map((w) => w.toLowerCase())]),
    policy: { ...DEFAULT_POLICY, ...profile.policy },
    filterQuestions: buildFilterQuestions(profile),
    scoreQuestions: buildScoreQuestions(profile),
    actionLabels: Object.fromEntries(profile.actions.map((a) => [a.id, a.label])),
  };
}

export function loadScout(file: string): Scout {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`profile: cannot read ${file}: ${(e as Error).message}`);
  }
  return compileProfile(parseProfile(raw));
}

export const isPrimary = (scout: Scout, author: string) => scout.primary.has(author.toLowerCase());
export const isAmplifier = (scout: Scout, author: string) => scout.amplifiers.has(author.toLowerCase());
export const isSource = (scout: Scout, author: string) => isPrimary(scout, author) || isAmplifier(scout, author);
export const roleOf = (scout: Scout, author: string) =>
  scout.primary.get(author.toLowerCase()) ?? scout.amplifiers.get(author.toLowerCase());
