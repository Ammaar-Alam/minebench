export const ARENA_VOTE_REASONS = [
  { key: "followed_prompt", label: "Followed prompt" },
  { key: "more_accurate", label: "More accurate" },
  { key: "clearer", label: "Clearer" },
  { key: "better_style", label: "Better style" },
  { key: "more_creative", label: "More creative" },
] as const;

export type ArenaVoteReason = (typeof ARENA_VOTE_REASONS)[number]["key"];

export const ARENA_VOTE_REASON_KEYS = ARENA_VOTE_REASONS.map((reason) => reason.key) as [
  ArenaVoteReason,
  ...ArenaVoteReason[],
];
