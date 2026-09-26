// Engine settings. Everything about what to watch lives in the YAML profile (see profiles/).

// Alert policy defaults. A profile can override any of them under `policy:`.
export const DEFAULT_POLICY = {
  alertThreshold: 3.0, // score = significance + relevance; each scale runs from 0 to (levels - 1), 0-3 with four levels
  majorThreshold: 4.0, // score at which a corroborated event is "big"
  watchMargin: 0.6, // events within this margin below the threshold are watched
  minConfidence: 0.5,
  dailyCap: 5, // rolling 24 h cap on notable alerts
  quietStartHour: 20,
  quietEndHour: 9,
  respectQuietHours: false,
  eventWindowHours: 72, // how long an event can absorb new posts
  maxEventAgeHours: 24, // no alert once the first post is older than this
  noisyRejectRate: 0.5,
  minFeedbackForTuning: 6,
  thresholdStep: 0.25,
  actionMin: 0.6, // minimum probability for a suggested action
  trendingMaxAgeHours: 12,
  trendingBurst: 3, // distinct accounts within 6 h
  trendingVelocity: 300, // engagements per hour: likes + 2 reposts + 3 quotes
  bigBurst: 6,
  bigBurstWithPrimary: 4,
  bigAmplifiers: 2,
  bigPrimary: 2,
  notableMinAccounts: 2, // accounts needed for a notable alert when no primary account posted; 1 allows a single unofficial post
};
export type Policy = typeof DEFAULT_POLICY;

export const JEV_USD_PER_TOKEN = 0.042e-6;
export const FIRST_CALL_USD = 0.001; // budget estimate for a call before any cost has been observed
export const CONCURRENCY = 8;
export const PROMPT_POSTS = 8; // posts quoted in a drafting prompt
export const SEARCH_PAGE_SIZE = 20; // X search returns at most this many posts per page
export const ACCOUNT_CHUNK = 12; // accounts per live search query
export const SCAN_CHUNK = 4; // accounts per scan query, so busy accounts do not crowd out others
export const SCAN_PAGES = 2;
export const CATCH_UP_PAGES = 5; // live account searches: pages read at most to reach back to the previous run
