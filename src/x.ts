import { ACCOUNT_CHUNK, SEARCH_PAGE_SIZE } from "./config";
import { type FetchLike, type Ledger, tregCall } from "./treg";
import type { XPost } from "./types";

interface AnyapiItem {
  id: string;
  text: string;
  createdUtc: number;
  authorUsername: string;
  authorFollowers: number;
  isReply: boolean;
  likeCount: number;
  retweetCount: number;
  quoteCount?: number;
}

const since = (t: number) => ` since_time:${t}`;
const TAIL = "-filter:replies -filter:retweets";

// X search binds OR tighter than AND, so every OR group is parenthesised.
export function accountQueries(handles: readonly string[], sinceUnix: number, chunk = ACCOUNT_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < handles.length; i += chunk) {
    out.push(
      `(${handles
        .slice(i, i + chunk)
        .map((h) => `from:${h}`)
        .join(" OR ")})${since(sinceUnix)} ${TAIL}`,
    );
  }
  return out;
}

export function keywordQuery(terms: string, sinceUnix: number, opts: { lang?: string; minFaves: number }): string {
  const lang = opts.lang ? ` lang:${opts.lang}` : "";
  return `(${terms})${lang}${since(sinceUnix)} min_faves:${opts.minFaves} ${TAIL}`;
}

export function normalize(i: AnyapiItem): XPost {
  return {
    id: i.id,
    url: `https://x.com/${i.authorUsername}/status/${i.id}`,
    text: i.text,
    author: i.authorUsername,
    followers: i.authorFollowers,
    createdUtc: i.createdUtc,
    likes: i.likeCount,
    reposts: i.retweetCount,
    quotes: i.quoteCount ?? 0,
  };
}

export async function searchX(
  query: string,
  sinceUnix: number,
  ledger: Ledger,
  fetchImpl?: FetchLike,
  queryType: "Latest" | "Top" = "Latest",
  pages = 1,
  limit = SEARCH_PAGE_SIZE,
): Promise<XPost[]> {
  const out: XPost[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const res = await tregCall<{ output?: { data?: { items?: AnyapiItem[]; nextCursor?: string } } }>(
      "anyapi.x.search.posts",
      { body: { query, limit, queryType, ...(cursor ? { cursor } : {}) } },
      ledger,
      fetchImpl,
    );
    const data = res.output?.data;
    out.push(...(data?.items ?? []).filter((i) => !i.isReply && i.createdUtc >= sinceUnix).map(normalize));
    cursor = data?.nextCursor;
    if (!cursor || !data?.items?.length) break;
    // Latest is newest first: once a page reaches back past `since`, later pages are older still.
    if (queryType === "Latest" && data.items.some((i) => i.createdUtc < sinceUnix)) break;
  }
  return out;
}
