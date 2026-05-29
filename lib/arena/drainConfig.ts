type ArenaDrainKind = "vote" | "shown";

type DrainDefaults = {
  defaultMaxJobs: number;
  defaultMaxMs: number;
  hardMaxJobs: number;
  hardMaxMs: number;
};

const DRAIN_DEFAULTS: Record<ArenaDrainKind, DrainDefaults> = {
  vote: {
    defaultMaxJobs: 32,
    defaultMaxMs: 5_000,
    hardMaxJobs: 256,
    hardMaxMs: 15_000,
  },
  shown: {
    defaultMaxJobs: 64,
    defaultMaxMs: 5_000,
    hardMaxJobs: 512,
    hardMaxMs: 15_000,
  },
};

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readBoolParam(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveArenaDrainRequestLimits(url: URL, kind: ArenaDrainKind) {
  const defaults = DRAIN_DEFAULTS[kind];
  return {
    maxJobs: parsePositiveInt(
      url.searchParams.get("maxJobs"),
      defaults.defaultMaxJobs,
      defaults.hardMaxJobs,
    ),
    maxMs: parsePositiveInt(
      url.searchParams.get("maxMs"),
      defaults.defaultMaxMs,
      defaults.hardMaxMs,
    ),
  };
}

export function shouldIncludeArenaDrainStatus(url: URL): boolean {
  return (
    readBoolParam(url.searchParams.get("status")) ||
    readBoolParam(url.searchParams.get("includeStatus"))
  );
}
