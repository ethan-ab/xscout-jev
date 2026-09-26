import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { Alert } from "./pipeline";
import type { Scout } from "./profile";

export const TIER: Record<string, string> = { big: "BIG", trending: "TRENDING", notable: "NOTABLE" };

// Slack mrkdwn requires escaping these three characters.
const escapeMrkdwn = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (s: string, n: number) => escapeMrkdwn(s.replace(/\s+/g, " ").trim().slice(0, n));
const handle = (url: string) => url.match(/x\.com\/([^/]+)\//)?.[1] ?? "source";

// One Slack message per tick; empty string when there is nothing to post.
export function formatSlack(scout: Scout, alerts: Alert[]): string {
  return alerts
    .map((a) => {
      const link = a.sources[0] ? `<${a.sources[0]}|@${handle(a.sources[0])}>` : "";
      if (a.kind === "update") return `*UPDATE* on #${a.eventId} · ${link}\n${oneLine(a.title, 200)}`;
      return [
        `*${TIER[a.tier] ?? a.tier}* · ${scout.labels[a.topic] ?? a.topic} · #${a.eventId}`,
        oneLine(a.title, 280),
        `${link} · ${a.authors.length} ${a.authors.length === 1 ? "account" : "accounts"} · ${escapeMrkdwn(a.why)}`,
      ].join("\n");
    })
    .join("\n\n");
}

// Posts to a Slack incoming webhook. Throws so a scheduler sees the failure; the alerts stay in alerts.jsonl.
export async function postToSlack(webhookUrl: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false }),
  });
  if (!res.ok) throw new Error(`slack webhook → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Sends the message, preceded by any message Slack refused earlier. A refused message is kept in `pendingFile` for next time.
export async function deliverToSlack(
  webhookUrl: string,
  message: string,
  pendingFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const previous = existsSync(pendingFile) ? readFileSync(pendingFile, "utf8").trim() : "";
  const text = [previous, message].filter(Boolean).join("\n\n");
  if (!text) return;
  try {
    await postToSlack(webhookUrl, text, fetchImpl);
    rmSync(pendingFile, { force: true });
  } catch (e) {
    if (message) appendFileSync(pendingFile, `${message}\n\n`);
    throw e;
  }
}
