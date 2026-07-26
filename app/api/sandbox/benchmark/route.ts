import { NextResponse } from "next/server";
import {
  deriveArenaBuildLoadHints,
  pickInitialBuild,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import type { ArenaBuildDeliveryClass, ArenaBuildLoadHints, ArenaBuildRef } from "@/lib/arena/types";
import {
  databaseUnavailableBody,
  databaseUnavailableHeaders,
  isDatabaseUnavailableError,
} from "@/lib/db/errors";
import {
  SANDBOX_COMPARISON_MODEL_PARAMS,
  SANDBOX_COMPARISON_SLOTS,
  type SandboxComparisonSelection,
  normalizeSandboxComparisonSelection,
} from "@/lib/sandbox/benchmarkComparison";
import { prisma } from "@/lib/prisma";
import { resolveModelDisplayName } from "@/lib/ai/modelCatalog";

export const runtime = "nodejs";

const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";
const BENCHMARK_INLINE_MAX_BYTES = Number.parseInt(
  process.env.SANDBOX_BENCHMARK_INLINE_MAX_BYTES ?? process.env.ARENA_MATCHUP_INLINE_MAX_BYTES ?? "0",
  10,
);

type PromptOption = {
  id: string;
  text: string;
  modelCount: number;
};

type ModelOption = {
  key: string;
  provider: string;
  displayName: string;
  eloRating: number;
};

type BenchmarkBuild = {
  buildId: string;
  checksum: string | null;
  serverValidated: boolean;
  buildRef: ArenaBuildRef;
  previewRef: ArenaBuildRef;
  buildLoadHints: ArenaBuildLoadHints;
  voxelBuild: unknown | null;
  model: ModelOption;
  metrics: {
    blockCount: number;
    generationTimeMs: number;
  };
};

type BenchmarkResponse = {
  settings: {
    gridSize: number;
    palette: string;
    mode: string;
  };
  prompts: PromptOption[];
  selectedPrompt: {
    id: string;
    text: string;
  } | null;
  models: ModelOption[];
  selectedModels: SandboxComparisonSelection<string | null>;
  builds: SandboxComparisonSelection<BenchmarkBuild | null>;
};

function shouldInlineInAdaptiveMode(hints: ArenaBuildLoadHints): boolean {
  if (getInitialAdaptiveDeliveryClass(hints) !== "inline") return false;
  if (!Number.isFinite(BENCHMARK_INLINE_MAX_BYTES) || BENCHMARK_INLINE_MAX_BYTES <= 0) return false;
  const estimatedBytes = hints.initialEstimatedBytes;
  return typeof estimatedBytes === "number" && estimatedBytes > 0 && estimatedBytes <= BENCHMARK_INLINE_MAX_BYTES;
}

function getInitialAdaptiveDeliveryClass(hints: ArenaBuildLoadHints): ArenaBuildDeliveryClass {
  return hints.initialDeliveryClass ?? hints.deliveryClass;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedPromptId = url.searchParams.get("promptId") ?? undefined;
    const requestedModels = Object.fromEntries(
      SANDBOX_COMPARISON_SLOTS.map((slot) => [
        slot,
        url.searchParams.get(SANDBOX_COMPARISON_MODEL_PARAMS[slot]) ?? undefined,
      ]),
    ) as Partial<SandboxComparisonSelection<string | undefined>>;

    const grouped = await prisma.build.groupBy({
      by: ["promptId", "modelId"],
      where: {
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
        model: { enabled: true, isBaseline: false },
        prompt: { active: true },
      },
    });

    const modelIdsByPromptId = new Map<string, Set<string>>();
    for (const row of grouped) {
      const set = modelIdsByPromptId.get(row.promptId) ?? new Set<string>();
      set.add(row.modelId);
      modelIdsByPromptId.set(row.promptId, set);
    }

    const eligiblePromptIds = Array.from(modelIdsByPromptId.entries())
      .filter(([, modelIds]) => modelIds.size >= 2)
      .map(([promptId]) => promptId);

    if (eligiblePromptIds.length === 0) {
      return NextResponse.json(
        { error: "No benchmark prompts with at least two seeded models were found." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const promptRows = await prisma.prompt.findMany({
      where: { id: { in: eligiblePromptIds }, active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, text: true },
    });

    const promptOptions: PromptOption[] = promptRows.map((p) => ({
      id: p.id,
      text: p.text,
      modelCount: modelIdsByPromptId.get(p.id)?.size ?? 0,
    }));

    if (promptOptions.length === 0) {
      return NextResponse.json(
        { error: "No active benchmark prompts are available yet." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const modelRows = await prisma.model.findMany({
      where: {
        enabled: true,
        isBaseline: false,
        builds: {
          some: {
            promptId: { in: eligiblePromptIds },
            gridSize: ARENA_GRID_SIZE,
            palette: ARENA_PALETTE,
            mode: ARENA_MODE,
          },
        },
      },
      orderBy: [{ conservativeRating: "desc" }, { displayName: "asc" }],
      select: {
        id: true,
        key: true,
        provider: true,
        displayName: true,
        eloRating: true,
      },
    });

    const models: ModelOption[] = modelRows.map((m) => ({
      key: m.key,
      provider: m.provider,
      displayName: resolveModelDisplayName(m.key, m.displayName),
      eloRating: Number(m.eloRating),
    }));

    const selection = normalizeSandboxComparisonSelection(
      models.map((model) => model.key),
      requestedModels,
    );
    const modelIdByKey = new Map(modelRows.map((m) => [m.key, m.id]));
    const selectedModelIds = SANDBOX_COMPARISON_SLOTS.flatMap((slot) => {
      const modelKey = selection[slot];
      const modelId = modelKey ? modelIdByKey.get(modelKey) : null;
      return modelId ? [modelId] : [];
    });

    const compatiblePromptIds =
      selectedModelIds.length >= 2
        ? promptOptions
            .filter((p) => {
              const ids = modelIdsByPromptId.get(p.id);
              return Boolean(ids && selectedModelIds.every((modelId) => ids.has(modelId)));
            })
            .map((p) => p.id)
        : [];

    const selectedPrompt = requestedPromptId
      ? promptOptions.find((p) => p.id === requestedPromptId) ??
        promptOptions.find((p) => compatiblePromptIds.includes(p.id)) ??
        promptOptions[0]
      : promptOptions.find((p) => compatiblePromptIds.includes(p.id)) ?? promptOptions[0];

    const selectedModelKeys = SANDBOX_COMPARISON_SLOTS.flatMap((slot) => {
      const modelKey = selection[slot];
      return modelKey ? [modelKey] : [];
    });
    const selectedBuildRows = await prisma.build.findMany({
      where: {
        promptId: selectedPrompt.id,
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
        model: { key: { in: selectedModelKeys } },
      },
      select: {
        id: true,
        gridSize: true,
        palette: true,
        mode: true,
        blockCount: true,
        generationTimeMs: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        arenaBuildHints: true,
        model: {
          select: {
            key: true,
            provider: true,
            displayName: true,
            eloRating: true,
          },
        },
      },
    });
    const buildByModelKey = new Map(
      selectedBuildRows.map((build) => [build.model.key, build]),
    );
    const buildRows = SANDBOX_COMPARISON_SLOTS.map((slot) => {
      const modelKey = selection[slot];
      return modelKey ? buildByModelKey.get(modelKey) ?? null : null;
    });
    const builds = Object.fromEntries(
      SANDBOX_COMPARISON_SLOTS.map((slot, index) => [slot, buildRows[index] ?? null]),
    ) as SandboxComparisonSelection<(typeof buildRows)[number]>;
    const hints = Object.fromEntries(
      SANDBOX_COMPARISON_SLOTS.map((slot) => [
        slot,
        builds[slot] ? deriveArenaBuildLoadHints(builds[slot]) : null,
      ]),
    ) as SandboxComparisonSelection<ArenaBuildLoadHints | null>;
    const shouldPrepare = Object.fromEntries(
      SANDBOX_COMPARISON_SLOTS.map((slot) => {
        const slotHints = hints[slot];
        const shouldProbe = Boolean(slotHints && slotHints.initialEstimatedBytes == null);
        return [slot, slotHints ? shouldInlineInAdaptiveMode(slotHints) || shouldProbe : false];
      }),
    ) as SandboxComparisonSelection<boolean>;
    const prepared = Object.fromEntries(
      SANDBOX_COMPARISON_SLOTS.map((slot) => [slot, null]),
    ) as SandboxComparisonSelection<Awaited<ReturnType<typeof prepareArenaBuild>> | null>;

    if (SANDBOX_COMPARISON_SLOTS.some((slot) => shouldPrepare[slot])) {
      try {
        const prepareBuildIds = SANDBOX_COMPARISON_SLOTS.flatMap((slot) => {
          const build = builds[slot];
          return shouldPrepare[slot] && build ? [build.id] : [];
        });
        const buildsForPrepare = await prisma.build.findMany({
          where: { id: { in: prepareBuildIds } },
          select: {
            id: true,
            gridSize: true,
            palette: true,
            blockCount: true,
            voxelByteSize: true,
            voxelCompressedByteSize: true,
            voxelSha256: true,
            arenaBuildHints: true,
            voxelData: true,
            voxelStorageBucket: true,
            voxelStoragePath: true,
            voxelStorageEncoding: true,
          },
        });
        const prepareBuildById = new Map(
          buildsForPrepare.map((build) => [build.id, build]),
        );
        const preparedRows = await Promise.all(
          SANDBOX_COMPARISON_SLOTS.map((slot) => {
            const buildId = builds[slot]?.id;
            const build = buildId ? prepareBuildById.get(buildId) : null;
            return build ? prepareArenaBuild(build) : Promise.resolve(null);
          }),
        );
        for (const [index, slot] of SANDBOX_COMPARISON_SLOTS.entries()) {
          prepared[slot] = preparedRows[index] ?? null;
        }
      } catch (err) {
        console.warn("sandbox benchmark inline prepare failed", err);
      }
    }

    const toBenchmarkBuild = (
      build:
        | {
            id: string;
            mode: string;
            blockCount: number;
            generationTimeMs: number;
            voxelSha256: string | null;
            model: {
              key: string;
              provider: string;
              displayName: string;
              eloRating: number;
            };
          }
        | null,
      hints: ArenaBuildLoadHints | null,
      prepared: Awaited<ReturnType<typeof prepareArenaBuild>> | null,
    ): BenchmarkBuild | null => {
      if (!build || !hints) return null;

      const checksum = (prepared?.checksum ?? build.voxelSha256)?.trim() || null;
      const effectiveHints = prepared?.hints ?? hints;
      const shouldInline = shouldInlineInAdaptiveMode(effectiveHints);
      const buildRef: ArenaBuildRef = prepared?.buildRef ?? {
        buildId: build.id,
        variant: "full",
        checksum,
      };
      const previewRef: ArenaBuildRef = prepared?.previewRef ?? {
        buildId: build.id,
        variant: "preview",
        checksum,
      };

      return {
        buildId: build.id,
        checksum,
        serverValidated: Boolean(prepared),
        buildRef,
        previewRef,
        buildLoadHints: effectiveHints,
        voxelBuild: prepared && shouldInline ? pickInitialBuild(prepared) : null,
        model: {
          key: build.model.key,
          provider: build.model.provider,
          displayName: resolveModelDisplayName(build.model.key, build.model.displayName),
          eloRating: Number(build.model.eloRating),
        },
        metrics: {
          blockCount: build.blockCount,
          generationTimeMs: build.generationTimeMs,
        },
      };
    };

    const body: BenchmarkResponse = {
      settings: {
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
      },
      prompts: promptOptions,
      selectedPrompt: {
        id: selectedPrompt.id,
        text: selectedPrompt.text,
      },
      models,
      selectedModels: selection,
      builds: Object.fromEntries(
        SANDBOX_COMPARISON_SLOTS.map((slot) => [
          slot,
          toBenchmarkBuild(builds[slot], hints[slot], prepared[slot]),
        ]),
      ) as SandboxComparisonSelection<BenchmarkBuild | null>,
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isDatabaseUnavailableError(err)) {
      console.warn("sandbox benchmark database unavailable", err);
      return NextResponse.json(databaseUnavailableBody(), {
        status: 503,
        headers: {
          ...databaseUnavailableHeaders(),
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(
      { error: "Failed to load benchmark builds." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
