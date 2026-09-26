import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { EventState } from "./types";

const SCHEMA = `
create table if not exists events (
  id integer primary key autoincrement,
  title text not null,
  topic text not null,
  status text not null default 'open',
  score real not null default 0,
  confidence real not null default 0,
  authors text not null default '[]',
  actions text not null default '[]',
  first_url text not null,
  title_rank real not null default 0,
  tier text,
  alerted_at integer,
  feedback text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists posts (
  id text primary key,
  author text not null,
  text text not null,
  url text not null,
  created_utc integer not null,
  kept integer not null,
  reason text not null,
  topic text,
  answers text not null,
  event_id integer references events(id),
  seen_at integer not null,
  likes integer, reposts integer, quotes integer,
  source text
);
create table if not exists polls (source text primary key, last_run integer not null);
create table if not exists costs (day text primary key, treg_usd real not null default 0, jev_usd real not null default 0);
create index if not exists events_status on events(status);
create index if not exists events_created on events(created_at);
create index if not exists posts_event on posts(event_id);
`;

type Raw = Record<string, unknown>;

export interface EventRow extends EventState {
  topic: string;
  firstUrl: string;
  tier: string | null;
  alertedAt: number | null;
  feedback: string | null;
}

export interface Metrics {
  likes: number;
  reposts: number;
  quotes: number;
}

export interface PostInput {
  id: string;
  author: string;
  text: string;
  url: string;
  createdUtc: number;
  kept: boolean;
  reason: string;
  topic: string | null;
  answers: unknown;
  eventId: number | null;
  metrics?: Metrics;
  source?: string; // "accounts" or "keyword:<name>": the search that found the post
}

export interface StoredPost {
  id: string;
  author: string;
  text: string;
  url: string;
  createdUtc: number;
  answers: string;
  engagement: number | null;
}

const toEvent = (r: Raw): EventRow => ({
  id: Number(r.id),
  title: String(r.title),
  topic: String(r.topic),
  status: r.status as EventState["status"],
  score: Number(r.score),
  confidence: Number(r.confidence),
  authors: JSON.parse(String(r.authors)),
  actions: JSON.parse(String(r.actions)),
  firstUrl: String(r.first_url),
  tier: (r.tier as string | null) ?? null,
  alertedAt: r.alerted_at == null ? null : Number(r.alerted_at),
  feedback: (r.feedback as string | null) ?? null,
});

export class Store {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.db.exec(SCHEMA);
  }

  // Prepared once, reused on every call.
  private q(sql: string): StatementSync {
    const cached = this.stmts.get(sql);
    if (cached) return cached;
    const st = this.db.prepare(sql);
    this.stmts.set(sql, st);
    return st;
  }

  // Runs synchronous writes in one transaction (one fsync instead of one per row).
  tx<T>(fn: () => T): T {
    this.db.exec("begin");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  lastRun(source: string): Date | null {
    const r = this.q("select last_run from polls where source = ?").get(source) as Raw | undefined;
    return r ? new Date(Number(r.last_run)) : null;
  }

  setLastRun(source: string, at: Date): void {
    this.q("insert into polls (source, last_run) values (?, ?) on conflict(source) do update set last_run = excluded.last_run").run(
      source,
      at.getTime(),
    );
  }

  unseenIds(ids: string[]): string[] {
    if (!ids.length) return [];
    const seen = new Set(
      (this.q("select p.id from posts p join json_each(?) j on j.value = p.id").all(JSON.stringify(ids)) as Raw[]).map((r) => String(r.id)),
    );
    return ids.filter((id) => !seen.has(id));
  }

  insertPost(p: PostInput, now: Date): void {
    const m = p.metrics;
    this.q(`insert or ignore into posts (id, author, text, url, created_utc, kept, reason, topic, answers, event_id, seen_at, likes, reposts, quotes, source)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      p.id,
      p.author,
      p.text,
      p.url,
      p.createdUtc,
      p.kept ? 1 : 0,
      p.reason,
      p.topic,
      JSON.stringify(p.answers),
      p.eventId,
      now.getTime(),
      m?.likes ?? null,
      m?.reposts ?? null,
      m?.quotes ?? null,
      p.source ?? null,
    );
  }

  // Collected posts, newest first, for reviewing what was kept or dropped and why.
  listPosts(filter?: "kept" | "dropped", limit = 50) {
    const where = filter === "kept" ? "where kept = 1" : filter === "dropped" ? "where kept = 0" : "";
    return (
      this.q(
        `select id, author, text, url, created_utc, kept, reason, topic, event_id, source from posts ${where} order by created_utc desc limit ?`,
      ).all(limit) as Raw[]
    ).map((r) => ({
      id: String(r.id),
      author: String(r.author),
      text: String(r.text),
      url: String(r.url),
      createdUtc: Number(r.created_utc),
      kept: Number(r.kept) === 1,
      reason: String(r.reason),
      topic: (r.topic as string | null) ?? null,
      eventId: r.event_id == null ? null : Number(r.event_id),
      source: (r.source as string | null) ?? null,
    }));
  }

  // When a search returns a post already stored, refresh its counts: engagement velocity is computed from them.
  refreshCounts(postId: string, m: Metrics): void {
    this.q("update posts set likes = ?, reposts = ?, quotes = ? where id = ?").run(m.likes, m.reposts, m.quotes, postId);
  }

  eventOfPost(postId: string): number | null {
    const r = this.q("select event_id from posts where id = ?").get(postId) as Raw | undefined;
    return r?.event_id == null ? null : Number(r.event_id);
  }

  eventPosts(eventId: number): StoredPost[] {
    return (
      this.q(
        "select id, author, text, url, created_utc, answers, likes, reposts, quotes from posts where event_id = ? order by created_utc",
      ).all(eventId) as Raw[]
    ).map((r) => ({
      id: String(r.id),
      author: String(r.author),
      text: String(r.text),
      url: String(r.url),
      createdUtc: Number(r.created_utc),
      answers: String(r.answers),
      engagement: r.likes == null ? null : Number(r.likes) + 2 * Number(r.reposts) + 3 * Number(r.quotes),
    }));
  }

  // Events a new post can join. Dropped ones are included so a small story that grows is revived, not duplicated.
  openEvents(windowHours: number, now: Date): EventRow[] {
    const since = now.getTime() - windowHours * 3_600_000;
    return (this.q("select * from events where created_at > ? order by updated_at desc").all(since) as Raw[]).map(toEvent);
  }

  event(id: number): EventRow | null {
    const r = this.q("select * from events where id = ?").get(id) as Raw | undefined;
    return r ? toEvent(r) : null;
  }

  createEvent(
    e: {
      title: string;
      topic: string;
      url: string;
      author: string;
      score: number;
      confidence: number;
      actions: string[];
      titleRank: number;
    },
    now: Date,
  ): EventRow {
    const r = this.q(`insert into events (title, title_rank, topic, first_url, authors, score, confidence, actions, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      e.title,
      e.titleRank,
      e.topic,
      e.url,
      JSON.stringify([e.author]),
      e.score,
      e.confidence,
      JSON.stringify(e.actions),
      now.getTime(),
      now.getTime(),
    );
    return this.event(Number(r.lastInsertRowid))!;
  }

  // Merges a post into an event. The event keeps its best score, and takes the post's text as its title when the post comes from
  // a higher-ranked source (official account, then news account, then anyone), so a hype post that came first does not stay the headline.
  addToEvent(
    id: number,
    p: { author: string; score: number; confidence: number; actions: string[]; title: string; titleRank: number },
    now: Date,
  ): EventRow {
    const cur = this.event(id)!;
    const better = p.score > cur.score;
    const rank = this.q("select title_rank from events where id = ?").get(id) as Raw;
    if (p.titleRank > Number(rank.title_rank))
      this.q("update events set title = ?, title_rank = ? where id = ?").run(p.title, p.titleRank, id);
    this.q("update events set authors = ?, score = ?, confidence = ?, actions = ?, updated_at = ? where id = ?").run(
      JSON.stringify([...new Set([...cur.authors, p.author])]),
      better ? p.score : cur.score,
      better ? p.confidence : cur.confidence,
      JSON.stringify(better ? p.actions : cur.actions),
      now.getTime(),
      id,
    );
    return this.event(id)!;
  }

  setStatus(id: number, status: EventState["status"], now: Date, tier?: string): void {
    if (tier)
      this.q("update events set status = ?, tier = ?, alerted_at = ?, updated_at = ? where id = ?").run(
        status,
        tier,
        now.getTime(),
        now.getTime(),
        id,
      );
    else this.q("update events set status = ?, updated_at = ? where id = ?").run(status, now.getTime(), id);
  }

  heldAndWatched(): EventRow[] {
    return (this.q("select * from events where status in ('held', 'watch')").all() as Raw[]).map(toEvent);
  }

  allEvents(): EventRow[] {
    return (this.q("select * from events order by id").all() as Raw[]).map(toEvent);
  }

  // Rolling 24 h cap on notable alerts.
  alertsLast24h(now: Date): number {
    const r = this.q("select count(*) as n from events where tier = 'notable' and alerted_at > ?").get(now.getTime() - 86_400_000) as Raw;
    return Number(r.n);
  }

  feedbackStats(now: Date): { total: number; rejected: number } {
    const r = this.q(`select count(*) as total, sum(case when feedback = 'skip' then 1 else 0 end) as rejected
      from events where feedback is not null and alerted_at > ?`).get(now.getTime() - 7 * 86_400_000) as Raw;
    return { total: Number(r.total), rejected: Number(r.rejected ?? 0) };
  }

  setFeedback(id: number, feedback: "good" | "skip"): void {
    this.q("update events set feedback = ? where id = ?").run(feedback, id);
  }

  listEvents(status?: string, limit = 30): EventRow[] {
    const rows = status
      ? this.q("select * from events where status = ? order by updated_at desc limit ?").all(status, limit)
      : this.q("select * from events order by updated_at desc limit ?").all(limit);
    return (rows as Raw[]).map(toEvent);
  }

  addCost(now: Date, treg: number, jev: number): void {
    this.q(`insert into costs (day, treg_usd, jev_usd) values (?, ?, ?)
      on conflict(day) do update set treg_usd = treg_usd + excluded.treg_usd, jev_usd = jev_usd + excluded.jev_usd`).run(
      now.toISOString().slice(0, 10),
      treg,
      jev,
    );
  }

  status(now: Date) {
    const events = Object.fromEntries(
      (this.q("select status, count(*) as n from events group by status order by status").all() as Raw[]).map((r) => [
        String(r.status),
        Number(r.n),
      ]),
    );
    const alerts = this.q("select count(*) as n from events where alerted_at > ?").get(now.getTime() - 86_400_000) as Raw;
    return {
      lastRun: this.lastRun("run"),
      lastKeywords: this.lastRun("keywords"),
      events,
      alerts24h: Number(alerts.n),
    };
  }

  costOn(now: Date): number {
    const r = this.q("select treg_usd + jev_usd as usd from costs where day = ?").get(now.toISOString().slice(0, 10)) as Raw | undefined;
    return r ? Number(r.usd) : 0;
  }

  // Spend per UTC day over the last `days` days, today included.
  costs(days: number, now: Date): { day: string; treg_usd: number; jev_usd: number }[] {
    const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.q("select day, treg_usd, jev_usd from costs where day >= ? order by day desc").all(from) as {
      day: string;
      treg_usd: number;
      jev_usd: number;
    }[];
  }
}
