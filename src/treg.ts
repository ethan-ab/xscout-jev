import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FetchLike = typeof fetch;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Ledger {
  tregUsd = 0;
  tregCalls = 0;
  jevUsd = 0;
  jevCalls = 0;
}

// TREG_TOKEN (+ TREG_ORG for identity tokens) from the environment, else the local `treg login` session.
export function tregAuth(): Record<string, string> {
  if (process.env.TREG_TOKEN) {
    return { "X-Treg-Token": process.env.TREG_TOKEN, ...(process.env.TREG_ORG ? { "X-Treg-Org": process.env.TREG_ORG } : {}) };
  }
  const file = join(homedir(), ".treg", "config.json");
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, "utf8")) as { token?: string; active_org?: string; identity?: boolean };
    if (c.token) return { "X-Treg-Token": c.token, ...(c.identity && c.active_org ? { "X-Treg-Org": c.active_org } : {}) };
  }
  throw new Error("no treg credentials: set TREG_TOKEN or run `treg login`");
}

export async function tregCall<T>(
  endpointId: string,
  req: { body?: unknown; query?: Record<string, string> },
  ledger: Ledger,
  fetchImpl: FetchLike = fetch,
  attempts = 3,
): Promise<T> {
  const url = new URL(endpointId, "https://treg.to/call/");
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const hasBody = req.body !== undefined;
  // Same key on every retry: a charged-but-lost answer is replayed for free.
  const headers: Record<string, string> = { ...tregAuth(), "Idempotency-Key": randomUUID() };
  if (hasBody) headers["Content-Type"] = "application/json";
  for (let i = 1; ; i++) {
    const res = await fetchImpl(url.href, {
      method: hasBody ? "POST" : "GET",
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && i < attempts) {
      const after = Number(res.headers.get("Retry-After"));
      await sleep((after > 0 ? after : i) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`treg ${endpointId} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    ledger.tregUsd += Number(res.headers.get("X-Treg-Cost-Micro") ?? 0) / 1e6;
    ledger.tregCalls += 1;
    return (await res.json()) as T;
  }
}
