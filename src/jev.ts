import { JEV_USD_PER_TOKEN } from "./config";
import { type FetchLike, type Ledger, sleep } from "./treg";
import type { Answer, Question } from "./types";

export interface JevResult {
  answers: Record<string, Answer>;
}

// Same variables as TypeSafe's SDKs, so any System One endpoint works (TypeSafe, OpenRouter, Vercel AI Gateway).
export function jevConfig() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set");
  const base = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
  return { key, url: `${base}/v1/systemone`, model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-1.13.0" };
}

export async function decide(
  state: unknown,
  questions: Record<string, Question>,
  ledger: Ledger,
  fetchImpl: FetchLike = fetch,
  baseMs = 500,
  attempts = 5,
): Promise<JevResult> {
  const { key, url, model } = jevConfig();
  for (let i = 1; ; i++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
    });
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && i < attempts) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(after > 0 ? after * 1000 : baseMs * 2 ** (i - 1));
      continue;
    }
    if (!res.ok) throw new Error(`jev → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { answers: Record<string, Answer>; usage: { input_tokens: number; cost?: number } };
    // Gateways such as OpenRouter report the charged cost; TypeSafe bills input tokens at list price.
    ledger.jevUsd += body.usage.cost ?? body.usage.input_tokens * JEV_USD_PER_TOKEN;
    ledger.jevCalls += 1;
    return { answers: body.answers };
  }
}
