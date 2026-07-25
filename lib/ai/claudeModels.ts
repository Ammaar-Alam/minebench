// What each Claude release supports, declared per release
//
// Nothing is inferred from version ordering: Anthropic has changed capabilities
// mid-generation more than once, so 4.6 gained adaptive thinking without xhigh
// and only Opus dropped sampling controls before 5
//
// An unlisted release resolves to no capabilities rather than inheriting its
// predecessor, and claude-capabilities.test.ts fails when a catalogued model has
// no row, so values get looked up instead of assumed
//
// To add a release, read the model card and add one row to CLAUDE_RELEASES

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ClaudeRelease = {
  // Effort levels accepted, highest first
  // Empty means no adaptive effort control
  effortLadder: readonly ClaudeEffort[];
  // Provider rejects non-default temperature, top_p, and top_k
  defaultSamplingOnly: boolean;
  // Thinking budget must be requested explicitly instead of by effort level
  legacyManualThinking?: boolean;
  // Long-context beta header is required to reach a 1M-token window
  context1mBeta?: boolean;
  // Synchronous Messages API output ceiling, when the model caps below the
  // MineBench default request
  maxOutputTokens?: number;
  // Environment variable that overrides the starting effort
  effortEnvVar?: string;
};

export type ClaudeCapabilities = Required<
  Omit<ClaudeRelease, "maxOutputTokens" | "effortEnvVar">
> & {
  adaptiveThinking: boolean;
  maxOutputTokens: number | null;
  effortEnvVar: string | null;
};

const FULL_EFFORT_LADDER: readonly ClaudeEffort[] = ["max", "xhigh", "high", "medium", "low"];
// 4.6 accepts max but rejects xhigh
const NO_XHIGH_LADDER: readonly ClaudeEffort[] = ["max", "high", "medium", "low"];

// Messages API synchronous output maximum, first documented for Opus 4.7
const MESSAGES_API_OUTPUT_MAX = 128_000;

// Keyed by family and version
// A release named without a minor, such as claude-opus-5, keys at minor 0
const CLAUDE_RELEASES: Record<string, ClaudeRelease> = {
  "opus-5.0": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_OPUS_5_EFFORT",
  },
  "sonnet-5.0": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_SONNET_5_EFFORT",
  },
  "fable-5.0": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_FABLE_5_EFFORT",
  },
  "mythos-5.0": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_FABLE_5_EFFORT",
  },
  "opus-4.8": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_OPUS_4_8_EFFORT",
  },
  "opus-4.7": {
    effortLadder: FULL_EFFORT_LADDER,
    defaultSamplingOnly: true,
    maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
    effortEnvVar: "ANTHROPIC_OPUS_4_7_EFFORT",
  },
  "opus-4.6": {
    effortLadder: NO_XHIGH_LADDER,
    defaultSamplingOnly: false,
    context1mBeta: true,
    effortEnvVar: "ANTHROPIC_OPUS_4_6_EFFORT",
  },
  "sonnet-4.6": {
    effortLadder: NO_XHIGH_LADDER,
    defaultSamplingOnly: false,
    context1mBeta: true,
    effortEnvVar: "ANTHROPIC_SONNET_4_6_EFFORT",
  },
  "opus-4.5": {
    effortLadder: [],
    defaultSamplingOnly: false,
    legacyManualThinking: true,
  },
  "sonnet-4.5": {
    effortLadder: [],
    defaultSamplingOnly: false,
    legacyManualThinking: true,
    context1mBeta: true,
  },
};

const NO_CAPABILITIES: ClaudeCapabilities = {
  effortLadder: [],
  adaptiveThinking: false,
  defaultSamplingOnly: false,
  legacyManualThinking: false,
  context1mBeta: false,
  maxOutputTokens: null,
  effortEnvVar: null,
};

// Matches direct Anthropic IDs (claude-opus-4-8, claude-opus-5) and the
// vendor-prefixed OpenRouter forms, which reorder the family and may carry a
// variant suffix (anthropic/claude-opus-4.8, anthropic/claude-4.8-opus:beta)
const VERSIONED_ID = /(?:^|\/)claude-(opus|sonnet|fable|mythos)-(\d+)(?:[.-](\d+))?(?:[.:-]|$)/;
const FAMILY_SUFFIXED_ID = /(?:^|\/)claude-(\d+)(?:[.-](\d+))?-(opus|sonnet)(?:[.:-]|$)/;

function releaseKey(modelId: string): string | null {
  const normalized = modelId.toLowerCase();
  const versioned = VERSIONED_ID.exec(normalized);
  const suffixed = versioned ? null : FAMILY_SUFFIXED_ID.exec(normalized);

  const family = versioned?.[1] ?? suffixed?.[3];
  const rawMajor = versioned?.[2] ?? suffixed?.[1];
  const rawMinor = versioned?.[3] ?? suffixed?.[2];
  if (!family || rawMajor === undefined) return null;

  const major = Number.parseInt(rawMajor, 10);
  const minor = rawMinor === undefined ? 0 : Number.parseInt(rawMinor, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return `${family}-${major}.${minor}`;
}

export function claudeCapabilities(modelId: string): ClaudeCapabilities {
  const key = releaseKey(modelId);
  const release = key ? CLAUDE_RELEASES[key] : undefined;
  if (!release) return NO_CAPABILITIES;

  return {
    effortLadder: release.effortLadder,
    adaptiveThinking: release.effortLadder.length > 0,
    defaultSamplingOnly: release.defaultSamplingOnly,
    legacyManualThinking: release.legacyManualThinking ?? false,
    context1mBeta: release.context1mBeta ?? false,
    maxOutputTokens: release.maxOutputTokens ?? null,
    effortEnvVar: release.effortEnvVar ?? null,
  };
}

// True when the release is declared above, so callers and tests can tell an
// unlisted model apart from one that genuinely has no capabilities
export function isKnownClaudeRelease(modelId: string): boolean {
  const key = releaseKey(modelId);
  return key !== null && key in CLAUDE_RELEASES;
}
