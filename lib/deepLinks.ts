const MAX_SANDBOX_COMPARISON_MODELS = 4;
const SANDBOX_LEGACY_MODEL_PARAMS = ["modelA", "modelB", "modelC", "modelD"];

export type SandboxComparisonDeepLink = {
  modelKeys: string[];
  promptId: string | null;
};
export type SandboxUrlMode = "benchmark" | "live" | "import";

function buildPath(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function parseSandboxComparisonDeepLink(
  params: URLSearchParams,
): SandboxComparisonDeepLink {
  const modelKeys: string[] = [];
  const used = new Set<string>();

  for (const modelKey of (params.get("models") ?? "").split(",")) {
    const normalized = modelKey.trim();
    if (!normalized || used.has(normalized)) continue;
    modelKeys.push(normalized);
    used.add(normalized);
    if (modelKeys.length === MAX_SANDBOX_COMPARISON_MODELS) break;
  }

  const requestedPromptId = params.get("promptId")?.trim();
  return {
    modelKeys,
    promptId: requestedPromptId || null,
  };
}

export function buildSandboxComparisonPath(
  currentParams: URLSearchParams,
  modelKeys: string[],
  promptId: string | null,
): string {
  const params = new URLSearchParams(currentParams);
  const normalizedModelKeys = Array.from(
    new Set(modelKeys.map((modelKey) => modelKey.trim()).filter(Boolean)),
  ).slice(0, MAX_SANDBOX_COMPARISON_MODELS);

  params.delete("prompt");
  params.delete("mode");
  for (const param of SANDBOX_LEGACY_MODEL_PARAMS) params.delete(param);
  if (normalizedModelKeys.length > 0) {
    params.set("models", normalizedModelKeys.join(","));
  } else {
    params.delete("models");
  }

  if (promptId?.trim()) {
    params.set("promptId", promptId.trim());
  } else {
    params.delete("promptId");
  }

  return buildPath("/sandbox", params);
}

export function readSandboxUrlMode(params: URLSearchParams): SandboxUrlMode {
  if (params.has("models") || params.has("promptId")) return "benchmark";
  if (params.get("mode") === "import") return "import";
  if (params.get("mode") === "live" || params.get("prompt")?.trim()) return "live";
  return "benchmark";
}

export function buildSandboxModePath(
  currentParams: URLSearchParams,
  mode: SandboxUrlMode,
): string {
  const params = new URLSearchParams(currentParams);
  if (mode === "live") {
    params.delete("models");
    params.delete("promptId");
    for (const param of SANDBOX_LEGACY_MODEL_PARAMS) params.delete(param);
    params.set("mode", "live");
  } else if (mode === "import") {
    params.delete("models");
    params.delete("promptId");
    params.delete("prompt");
    for (const param of SANDBOX_LEGACY_MODEL_PARAMS) params.delete(param);
    params.set("mode", "import");
  } else {
    params.delete("prompt");
    params.delete("mode");
  }
  return buildPath("/sandbox", params);
}

export function buildLeaderboardBuildPath(
  pathname: string,
  currentParams: URLSearchParams,
  buildId: string | null,
): string {
  const params = new URLSearchParams(currentParams);
  if (buildId?.trim()) {
    params.set("build", buildId.trim());
  } else {
    params.delete("build");
  }
  return buildPath(pathname, params);
}
