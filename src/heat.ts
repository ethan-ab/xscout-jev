import { isAmplifier, isPrimary, type Scout } from "./profile";

export interface HeatPost {
  author: string;
  createdUtc: number;
  engagement?: number | null; // likes + 2×reposts + 3×quotes when observed (live); unknown in replays
}

export interface Heat {
  firstUtc: number;
  ageHours: number; // since the event's first post
  accounts: number; // distinct authors so far
  burst6h: number; // most distinct authors within any 6 h window
  primary: number; // distinct primary (official) accounts
  amplifiers: number; // distinct amplifier (news) accounts
  velocity: number | null; // best engagement per hour among observed posts
}

// Everything here is arithmetic on timestamps and counts: code's job, not Jev's.
export function computeHeat(scout: Scout, posts: HeatPost[], nowUnix: number): Heat {
  const seen = posts.filter((p) => p.createdUtc <= nowUnix).sort((a, b) => a.createdUtc - b.createdUtc);
  if (seen.length === 0) throw new Error("computeHeat: no posts");
  const firstUtc = seen[0]!.createdUtc;
  const authors = new Set(seen.map((p) => p.author));
  let burst6h = 0;
  for (const start of seen) {
    const inWindow = new Set(
      seen.filter((p) => p.createdUtc >= start.createdUtc && p.createdUtc <= start.createdUtc + 6 * 3600).map((p) => p.author),
    );
    burst6h = Math.max(burst6h, inWindow.size);
  }
  const velocities = seen.filter((p) => p.engagement != null).map((p) => p.engagement! / Math.max((nowUnix - p.createdUtc) / 3600, 0.5));
  return {
    firstUtc,
    ageHours: (nowUnix - firstUtc) / 3600,
    accounts: authors.size,
    burst6h,
    primary: [...authors].filter((a) => isPrimary(scout, a)).length,
    amplifiers: [...authors].filter((a) => isAmplifier(scout, a)).length,
    velocity: velocities.length ? Math.max(...velocities) : null,
  };
}
