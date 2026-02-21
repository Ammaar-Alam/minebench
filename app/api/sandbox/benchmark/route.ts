import { NextResponse } from "next/server";
import {
  deriveArenaBuildLoadHints,
  pickInitialBuild,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import type { ArenaBuildDeliveryClass, ArenaBuildLoadHints, ArenaBuildRef } from "@/lib/arena/types";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";

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
  selectedModels: {
    a: string | null;
    b: string | null;
  };
  builds: {
    a: BenchmarkBuild | null;
    b: BenchmarkBuild | null;
  };
};

function pickPair(models: ModelOption[], requestedA?: string, requestedB?: string) {
  if (models.length < 2) return { a: null as string | null, b: null as string | null };

  const has = (key: string | undefined) => Boolean(key && models.some((m) => m.key === key));
  const first = models[0]?.key ?? null;
  const second = models[1]?.key ?? null;

  let a = has(requestedA) ? (requestedA as string) : first;
  let b = has(requestedB) ? (requestedB as string) : null;

  if (!a) return { a: null, b: null };
  if (!b || b === a) {
    b = models.find((m) => m.key !== a)?.key ?? null;
  }

  if (!b) return { a: null, b: null };
  return { a, b };
}

function shouldInlineInAdaptiveMode(deliveryClass: ArenaBuildDeliveryClass): boolean {
  return deliveryClass === "inline";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedPromptId = url.searchParams.get("promptId") ?? undefined;
    const requestedModelA = url.searchParams.get("modelA") ?? undefined;
    const requestedModelB = url.searchParams.get("modelB") ?? undefined;

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
      displayName: m.displayName,
      eloRating: Number(m.eloRating),
    }));

    const selection = pickPair(models, requestedModelA, requestedModelB);
    const modelIdByKey = new Map(modelRows.map((m) => [m.key, m.id]));
    const selectedModelAId = selection.a ? modelIdByKey.get(selection.a) ?? null : null;
    const selectedModelBId = selection.b ? modelIdByKey.get(selection.b) ?? null : null;

    const compatiblePromptIds =
      selectedModelAId && selectedModelBId
        ? promptOptions
            .filter((p) => {
              const ids = modelIdsByPromptId.get(p.id);
              return Boolean(ids?.has(selectedModelAId) && ids?.has(selectedModelBId));
            })
            .map((p) => p.id)
        : [];

    const selectedPrompt = requestedPromptId
      ? promptOptions.find((p) => p.id === requestedPromptId) ??
        promptOptions.find((p) => compatiblePromptIds.includes(p.id)) ??
        promptOptions[0]
      : promptOptions.find((p) => compatiblePromptIds.includes(p.id)) ?? promptOptions[0];

    const [buildA, buildB] = await Promise.all([
      selection.a
        ? prisma.build.findFirst({
            where: {
              promptId: selectedPrompt.id,
              gridSize: ARENA_GRID_SIZE,
              palette: ARENA_PALETTE,
              mode: ARENA_MODE,
              model: { key: selection.a },
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
              model: {
                select: {
                  key: true,
                  provider: true,
                  displayName: true,
                  eloRating: true,
                },
              },
            },
          })
        : null,
      selection.b
        ? prisma.build.findFirst({
            where: {
              promptId: selectedPrompt.id,
              gridSize: ARENA_GRID_SIZE,
              palette: ARENA_PALETTE,
              mode: ARENA_MODE,
              model: { key: selection.b },
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
              model: {
                select: {
                  key: true,
                  provider: true,
                  displayName: true,
                  eloRating: true,
                },
              },
            },
          })
        : null,
    ]);

    const hintsA = buildA ? deriveArenaBuildLoadHints(buildA) : null;
    const hintsB = buildB ? deriveArenaBuildLoadHints(buildB) : null;
    const shouldProbeA = Boolean(hintsA && hintsA.fullEstimatedBytes == null);
    const shouldProbeB = Boolean(hintsB && hintsB.fullEstimatedBytes == null);
    const shouldPrepareA = hintsA
      ? shouldInlineInAdaptiveMode(hintsA.deliveryClass) || shouldProbeA
      : false;
    const shouldPrepareB = hintsB
      ? shouldInlineInAdaptiveMode(hintsB.deliveryClass) || shouldProbeB
      : false;

    let preparedA: Awaited<ReturnType<typeof prepareArenaBuild>> | null = null;
    let preparedB: Awaited<ReturnType<typeof prepareArenaBuild>> | null = null;

    if (shouldPrepareA || shouldPrepareB) {
      try {
        const [buildAForPrepare, buildBForPrepare] = await Promise.all([
          shouldPrepareA && buildA
            ? prisma.build.findUnique({
                where: { id: buildA.id },
                select: {
                  id: true,
                  gridSize: true,
                  palette: true,
                  blockCount: true,
                  voxelByteSize: true,
                  voxelCompressedByteSize: true,
                  voxelSha256: true,
                  voxelData: true,
                  voxelStorageBucket: true,
                  voxelStoragePath: true,
                  voxelStorageEncoding: true,
                },
              })
            : Promise.resolve(null),
          shouldPrepareB && buildB
            ? prisma.build.findUnique({
                where: { id: buildB.id },
                select: {
                  id: true,
                  gridSize: true,
                  palette: true,
                  blockCount: true,
                  voxelByteSize: true,
                  voxelCompressedByteSize: true,
                  voxelSha256: true,
                  voxelData: true,
                  voxelStorageBucket: true,
                  voxelStoragePath: true,
                  voxelStorageEncoding: true,
                },
              })
            : Promise.resolve(null),
        ]);

        [preparedA, preparedB] = await Promise.all([
          buildAForPrepare ? prepareArenaBuild(buildAForPrepare) : Promise.resolve(null),
          buildBForPrepare ? prepareArenaBuild(buildBForPrepare) : Promise.resolve(null),
        ]);
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
      const shouldInline = shouldInlineInAdaptiveMode(effectiveHints.deliveryClass);
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
          displayName: build.model.displayName,
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
      builds: {
        a: toBenchmarkBuild(buildA, hintsA, preparedA),
        b: toBenchmarkBuild(buildB, hintsB, preparedB),
      },
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load benchmark builds";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
