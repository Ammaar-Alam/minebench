import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveBuildSpec } from "@/lib/storage/buildPayload";

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
        { status: 409, headers: { "Cache-Control": "no-store" } }
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
        { status: 409, headers: { "Cache-Control": "no-store" } }
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
      orderBy: [{ eloRating: "desc" }, { displayName: "asc" }],
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
              voxelData: true,
              voxelStorageBucket: true,
              voxelStoragePath: true,
              voxelStorageEncoding: true,
              blockCount: true,
              generationTimeMs: true,
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
              voxelData: true,
              voxelStorageBucket: true,
              voxelStoragePath: true,
              voxelStorageEncoding: true,
              blockCount: true,
              generationTimeMs: true,
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

    const [buildSpecA, buildSpecB] = await Promise.all([
      buildA ? resolveBuildSpec(buildA) : Promise.resolve(null),
      buildB ? resolveBuildSpec(buildB) : Promise.resolve(null),
    ]);

    const body = {
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
        a: buildA
          ? {
              model: {
                key: buildA.model.key,
                provider: buildA.model.provider,
                displayName: buildA.model.displayName,
                eloRating: Number(buildA.model.eloRating),
              },
              voxelBuild: buildSpecA,
              metrics: {
                blockCount: buildA.blockCount,
                generationTimeMs: buildA.generationTimeMs,
              },
            }
          : null,
        b: buildB
          ? {
              model: {
                key: buildB.model.key,
                provider: buildB.model.provider,
                displayName: buildB.model.displayName,
                eloRating: Number(buildB.model.eloRating),
              },
              voxelBuild: buildSpecB,
              metrics: {
                blockCount: buildB.blockCount,
                generationTimeMs: buildB.generationTimeMs,
              },
            }
          : null,
      },
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load benchmark builds";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
