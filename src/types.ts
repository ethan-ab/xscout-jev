export type Question =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] }
  | { type: "noul"; instructions: unknown };

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence?: number;
  probabilities: Record<string, number>;
}
interface NoulAnswer {
  type: "noul";
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface XPost {
  id: string;
  url: string;
  text: string;
  author: string;
  followers: number;
  createdUtc: number;
  likes: number;
  reposts: number;
  quotes: number;
}

export const STATUSES = ["open", "watch", "held", "alerted", "dropped"] as const;

export interface EventState {
  id: number;
  title: string;
  status: (typeof STATUSES)[number];
  score: number; // best post: significance + relevance (0–6 with four levels on each scale)
  confidence: number; // significance confidence of the best post
  authors: string[];
  actions: string[];
}
