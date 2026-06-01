import type {
  CustomBuildArtifactKind,
  CustomBuildJobStatus,
  CustomBuildJobType,
  CustomBuildStatus,
  Prisma,
} from "@prisma/client";
import type { ProviderApiKeys } from "@/lib/ai/types";
import type { CustomBuildExportFormat } from "@/lib/custom-builds/types";

export type CustomBuildApiErrorCode =
  | "invalid_request"
  | "custom_builds_disabled"
  | "missing_provider_key"
  | "invalid_custom_api_url"
  | "rate_limited"
  | "not_found"
  | "job_not_ready"
  | "artifact_not_ready"
  | "export_not_supported"
  | "provider_key_expired"
  | "provider_request_failed"
  | "validation_failed"
  | "storage_upload_failed"
  | "storage_sign_failed"
  | "worker_failed"
  | "canceled";

export type CustomBuildProviderCredential = {
  provider: keyof ProviderApiKeys;
  providerKey: string;
};

export type SerializableCustomBuild = {
  publicId: string;
  status: CustomBuildStatus;
  currentStage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  promptText: string;
  gridSize: number;
  palette: string;
  modelKind: string;
  modelKey: string | null;
  modelProvider: string;
  modelId: string;
  modelDisplayName: string;
  blockCount: number | null;
  generationTimeMs: number | null;
  warnings: Prisma.JsonValue | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  buildSha256: string | null;
};

export type SerializableArtifact = {
  kind: CustomBuildArtifactKind;
  format: string;
  contentType: string;
  byteSize: number;
  compressedByteSize: number | null;
  sha256: string;
  sourceBuildSha256: string | null;
};

export type SerializableJob = {
  type: CustomBuildJobType;
  status: CustomBuildJobStatus;
  payload: Prisma.JsonValue | null;
};

export function customBuildArtifactMatchesCurrentBuild(
  artifact: Pick<SerializableArtifact, "kind" | "sourceBuildSha256">,
  buildSha256: string | null | undefined,
): boolean {
  if (
    artifact.kind === "build_json" ||
    artifact.kind === "preview_json" ||
    artifact.kind === "glb" ||
    artifact.kind === "stl" ||
    artifact.kind === "schem"
  ) {
    return Boolean(buildSha256 && artifact.sourceBuildSha256 === buildSha256);
  }
  return true;
}

function noIndexHeaders() {
  return {
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function customBuildError(
  code: CustomBuildApiErrorCode,
  message: string,
  status: number,
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: noIndexHeaders(),
    },
  );
}

export function customBuildNoStoreHeaders(): HeadersInit {
  return {
    ...noIndexHeaders(),
    "Cache-Control": "no-store",
  };
}

export function customBuildPrivateTerminalHeaders(): HeadersInit {
  return {
    ...noIndexHeaders(),
    "Cache-Control": "private, max-age=15",
  };
}

export function chooseCustomBuildProviderCredential(args: {
  modelProvider: string;
  openRouterModelId?: string | null;
  preferOpenRouter?: boolean;
  forceOpenRouter?: boolean;
  providerKeys?: ProviderApiKeys;
}): CustomBuildProviderCredential {
  const keys = args.providerKeys ?? {};
  const provider = args.modelProvider as keyof ProviderApiKeys;
  const directKey = keys[provider]?.trim();
  const openRouterKey = keys.openrouter?.trim();

  if (args.forceOpenRouter) {
    if (args.openRouterModelId && openRouterKey) {
      return { provider: "openrouter", providerKey: openRouterKey };
    }
    throw new Error("missing_provider_key");
  }

  if (args.preferOpenRouter && args.openRouterModelId && openRouterKey) {
    return { provider: "openrouter", providerKey: openRouterKey };
  }
  if (directKey) return { provider, providerKey: directKey };
  if (args.openRouterModelId && openRouterKey) {
    return { provider: "openrouter", providerKey: openRouterKey };
  }

  throw new Error("missing_provider_key");
}

export function artifactKindForDownloadFormat(format: string): CustomBuildArtifactKind | null {
  if (format === "json" || format === "json.gz") return "build_json";
  if (format === "preview-json") return "preview_json";
  if (format === "glb") return "glb";
  if (format === "stl") return "stl";
  if (format === "schem") return "schem";
  return null;
}

export function downloadFormatForArtifactKind(kind: CustomBuildArtifactKind): string {
  if (kind === "build_json") return "json";
  if (kind === "preview_json") return "preview-json";
  return kind;
}

function exportFormatFromJob(job: SerializableJob): CustomBuildExportFormat | null {
  if (job.type !== "export") return null;
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) return null;
  const format = (job.payload as { format?: unknown }).format;
  return format === "glb" || format === "stl" || format === "schem" ? format : null;
}

function exportJobMatchesCurrentBuild(job: SerializableJob, buildSha256: string | null | undefined): boolean {
  if (job.type !== "export") return true;
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) return true;
  const sourceBuildSha256 = (job.payload as { sourceBuildSha256?: unknown }).sourceBuildSha256;
  if (typeof sourceBuildSha256 !== "string") return true;
  return Boolean(buildSha256 && sourceBuildSha256 === buildSha256);
}

export function serializeCustomBuildStatus(args: {
  customBuild: SerializableCustomBuild;
  artifacts: SerializableArtifact[];
  exportJobs: SerializableJob[];
}) {
  const build = args.customBuild;
  const currentArtifacts = args.artifacts.filter((artifact) =>
    customBuildArtifactMatchesCurrentBuild(artifact, build.buildSha256),
  );
  const artifactResponses = currentArtifacts.map((artifact) => ({
    kind: artifact.kind,
    format: artifact.format,
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    compressedByteSize: artifact.compressedByteSize,
    sha256: artifact.sha256,
    downloadUrl: `/api/custom-builds/${build.publicId}/artifacts/${downloadFormatForArtifactKind(artifact.kind)}`,
  }));

  const exports: Record<CustomBuildExportFormat, { status: string; downloadUrl?: string }> = {
    glb: { status: "not_requested" },
    stl: { status: "not_requested" },
    schem: { status: "not_requested" },
  };
  for (const job of args.exportJobs) {
    if (!exportJobMatchesCurrentBuild(job, build.buildSha256)) continue;
    const format = exportFormatFromJob(job);
    if (!format) continue;
    exports[format] = { status: job.status };
  }
  for (const artifact of currentArtifacts) {
    if (artifact.kind === "glb" || artifact.kind === "stl" || artifact.kind === "schem") {
      exports[artifact.kind] = {
        status: "available",
        downloadUrl: `/api/custom-builds/${build.publicId}/artifacts/${artifact.kind}`,
      };
    }
  }

  return {
    id: build.publicId,
    status: build.status,
    currentStage: build.currentStage,
    createdAt: build.createdAt.toISOString(),
    startedAt: build.startedAt?.toISOString() ?? null,
    completedAt: build.completedAt?.toISOString() ?? null,
    prompt: build.promptText,
    gridSize: build.gridSize,
    palette: build.palette,
    model: {
      kind: build.modelKind,
      modelKey: build.modelKey,
      provider: build.modelProvider,
      modelId: build.modelId,
      displayName: build.modelDisplayName,
    },
    metrics: {
      blockCount: build.blockCount,
      generationTimeMs: build.generationTimeMs,
      warnings: build.warnings,
    },
    error: build.errorCode
      ? {
          code: build.errorCode,
          message: build.errorMessage,
          retryable: build.errorRetryable,
        }
      : null,
    artifacts: artifactResponses,
    exports,
  };
}

export type CustomBuildStatusPayload = ReturnType<typeof serializeCustomBuildStatus>;
