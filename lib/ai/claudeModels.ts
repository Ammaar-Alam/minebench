// Single source of truth for what each Claude generation supports.
//
// Anthropic capabilities do not follow one clean version threshold: 4.6 gained
// adaptive thinking but not xhigh effort, only Opus dropped sampling controls
// before 5, and the 1M-token beta header applies to a specific pair of older
// releases. Resolving all of that here keeps the direct Anthropic route, the
// OpenRouter fallback, and the reasoning-effort profiles from drifting apart.
//
// Onboarding a Claude model usually needs no change to this file. Add an
// EFFORT_ENV_VARS entry to expose an effort override, and adjust a threshold
// below only when Anthropic changes what a generation supports.

export type ClaudeCapabilities = {
  // Thinking is always on and is steered by an effort level, not a token budget
  adaptiveThinking: boolean;
  // Effort ladder starts at max and includes xhigh
  xhighEffort: boolean;
  // Provider rejects non-default temperature, top_p, and top_k
  defaultSamplingOnly: boolean;
  // Thinking budget must be requested explicitly instead of by effort level
  legacyManualThinking: boolean;
  // Long-context beta header is required to reach a 1M-token window
  context1mBeta: boolean;
  // Synchronous Messages API output ceiling, when the model caps below the
  // MineBench default request
  maxOutputTokens: number | null;
  // Environment variable that overrides the starting effort, if any
  effortEnvVar: string | null;
};

type ClaudeVersion = {
  family: "opus" | "sonnet" | "fable" | "mythos";
  major: number;
  minor: number;
};

const NO_CAPABILITIES: ClaudeCapabilities = {
  adaptiveThinking: false,
  xhighEffort: false,
  defaultSamplingOnly: false,
  legacyManualThinking: false,
  context1mBeta: false,
  maxOutputTokens: null,
  effortEnvVar: null,
};

// Messages API synchronous output maximum, first documented for Opus 4.7
const MESSAGES_API_OUTPUT_MAX = 128_000;

const EFFORT_ENV_VARS: Record<string, string> = {
  "fable-5.0": "ANTHROPIC_FABLE_5_EFFORT",
  "mythos-5.0": "ANTHROPIC_FABLE_5_EFFORT",
  "opus-5.0": "ANTHROPIC_OPUS_5_EFFORT",
  "sonnet-5.0": "ANTHROPIC_SONNET_5_EFFORT",
  "opus-4.8": "ANTHROPIC_OPUS_4_8_EFFORT",
  "opus-4.7": "ANTHROPIC_OPUS_4_7_EFFORT",
  "opus-4.6": "ANTHROPIC_OPUS_4_6_EFFORT",
  "sonnet-4.6": "ANTHROPIC_SONNET_4_6_EFFORT",
};

// Matches direct Anthropic IDs (claude-opus-4-8, claude-opus-5) and the
// vendor-prefixed OpenRouter forms, which reorder the family and may carry a
// variant suffix (anthropic/claude-opus-4.8, anthropic/claude-4.8-opus:beta).
// A release named without a minor, such as claude-opus-5, resolves to minor 0.
const VERSIONED_ID = /(?:^|\/)claude-(opus|sonnet|fable|mythos)-(\d+)(?:[.-](\d+))?(?:[.:-]|$)/;
const FAMILY_SUFFIXED_ID = /(?:^|\/)claude-(\d+)(?:[.-](\d+))?-(opus|sonnet)(?:[.:-]|$)/;

function parseClaudeVersion(modelId: string): ClaudeVersion | null {
  const normalized = modelId.toLowerCase();
  const versioned = VERSIONED_ID.exec(normalized);
  const suffixed = versioned ? null : FAMILY_SUFFIXED_ID.exec(normalized);

  const family = (versioned?.[1] ?? suffixed?.[3]) as ClaudeVersion["family"] | undefined;
  const rawMajor = versioned?.[2] ?? suffixed?.[1];
  const rawMinor = versioned?.[3] ?? suffixed?.[2];
  if (!family || rawMajor === undefined) return null;

  const major = Number.parseInt(rawMajor, 10);
  const minor = rawMinor === undefined ? 0 : Number.parseInt(rawMinor, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { family, major, minor };
}

function atLeast(version: ClaudeVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

export function claudeCapabilities(modelId: string): ClaudeCapabilities {
  const version = parseClaudeVersion(modelId);
  if (!version) return NO_CAPABILITIES;

  const isOpus = version.family === "opus";
  // Opus 4.7 introduced both the documented 128k output maximum and the
  // rejection of non-default sampling; the 5 generation applies both everywhere
  const modernOpusOrLater = atLeast(version, 5, 0) || (isOpus && atLeast(version, 4, 7));
  return {
    adaptiveThinking: atLeast(version, 4, 6),
    xhighEffort: atLeast(version, 4, 7),
    defaultSamplingOnly: modernOpusOrLater,
    legacyManualThinking: version.major === 4 && version.minor === 5,
    context1mBeta:
      (isOpus && version.major === 4 && version.minor === 6) ||
      (version.family === "sonnet" && version.major === 4),
    maxOutputTokens: modernOpusOrLater ? MESSAGES_API_OUTPUT_MAX : null,
    effortEnvVar:
      EFFORT_ENV_VARS[`${version.family}-${version.major}.${version.minor}`] ?? null,
  };
}
