import { isGridSize, MAX_GENERATION_PROMPT_CHARS, type GridSize } from "@/lib/ai/limits";
import { z } from "zod";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  normalizeCustomProviderRequestConfig,
  normalizeProviderRequestOverrides,
} from "@/lib/ai/customProviderConfig";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { captureProviderRequest } from "@/lib/ai/providers/shared";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { assertSafeCustomApiUrl } from "@/lib/ai/providers/customApiGuard";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { GalleryServiceError, requireMineBenchAdmin } from "@/lib/gallery/service";
import type { GenerateEvent, GenerateModelRequest, GenerateRequest } from "@/lib/ai/types";
import { publishGenerationError, publishGenerationSuccess } from "@/lib/observability/cloudwatch";

export const runtime = "nodejs";

const providerKeysSchema = z
  .object({
    openai: z.string().trim().min(1).max(4000).optional(),
    anthropic: z.string().trim().min(1).max(4000).optional(),
    gemini: z.string().trim().min(1).max(4000).optional(),
    moonshot: z.string().trim().min(1).max(4000).optional(),
    deepseek: z.string().trim().min(1).max(4000).optional(),
    minimax: z.string().trim().min(1).max(4000).optional(),
    xai: z.string().trim().min(1).max(4000).optional(),
    meta: z.string().trim().min(1).max(4000).optional(),
    zai: z.string().trim().min(1).max(4000).optional(),
    openrouter: z.string().trim().min(1).max(4000).optional(),
    custom: z.string().trim().min(1).max(4000).optional(),
  })
  .optional();

const customHeadersSchema = z
  .record(z.string().trim().min(1).max(128), z.string().max(16_384))
  .refine((value) => Object.keys(value).length <= 32, "Too many custom headers.")
  .optional();
const customBodySchema = z
  .record(z.string().trim().min(1).max(128), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 65_536, "Custom body is too large.")
  .optional();

const modelRequestSchema = z.union([
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("catalog"),
    modelKey: z.string().trim().min(1).max(200),
    headers: customHeadersSchema,
    body: customBodySchema,
  }),
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("custom"),
    provider: z.literal("custom"),
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(240),
    baseUrl: z.string().trim().url().max(4000),
    headers: customHeadersSchema,
    body: customBodySchema,
  }),
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("custom"),
    provider: z.literal("openrouter"),
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(240),
    headers: customHeadersSchema,
    body: customBodySchema,
  }),
]);

const reqSchema = z.object({
  prompt: z.string().max(MAX_GENERATION_PROMPT_CHARS, `Keep the prompt to ${MAX_GENERATION_PROMPT_CHARS} characters or fewer.`),
  gridSize: z.custom<GridSize>(isGridSize),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  modelKeys: z.array(z.string()).min(1).max(8).optional(),
  models: z.array(modelRequestSchema).min(1).max(8).optional(),
  providerKeys: providerKeysSchema,
}).superRefine((value, ctx) => {
  if ((!value.models || value.models.length === 0) && (!value.modelKeys || value.modelKeys.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one model.",
      path: ["models"],
    });
  }
});

const STREAM_PAD = " ".repeat(2048);
const PING_INTERVAL_MS = 15_000;

function isModelKey(v: string): v is ModelKey {
  try {
    getModelByKey(v as ModelKey);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = reqSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 }
    );
  }

  const body = parsed.data as GenerateRequest;
  const preview = new URL(req.url).searchParams.get("preview") === "1";
  if (body.gridSize > 512) {
    if (!preview) return NextResponse.json({ error: "Large grids require saved generation." }, { status: 400 });
    const ownerId = await getAuthenticatedUserId(req);
    if (!ownerId) return NextResponse.json({ error: "Sign in to preview this size." }, { status: 401 });
    try {
      await requireMineBenchAdmin(ownerId);
    } catch (error) {
      if (error instanceof GalleryServiceError && error.code === "forbidden") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      throw error;
    }
  }
  const requestedModels: GenerateModelRequest[] =
    body.models && body.models.length > 0
      ? body.models
      : (body.modelKeys ?? []).map((modelKey) => ({
          id: modelKey,
          kind: "catalog" as const,
          modelKey,
        }));
  const seenModelIds = new Set<string>();
  for (const model of requestedModels) {
    if (seenModelIds.has(model.id)) {
      return NextResponse.json({ error: "Model ids must be unique" }, { status: 400 });
    }
    seenModelIds.add(model.id);
  }
  const models = requestedModels.flatMap((model): GenerateModelRequest[] => {
    if (model.kind !== "catalog") return [model];
    return isModelKey(model.modelKey) ? [model] : [];
  });
  if (models.length === 0) {
    return NextResponse.json({ error: "No valid modelKeys" }, { status: 400 });
  }

  for (const model of models) {
    try {
      normalizeProviderRequestOverrides(model);
      if (model.kind === "custom" && model.provider === "custom") {
        const config = normalizeCustomProviderRequestConfig(model);
        await assertSafeCustomApiUrl(config.baseUrl);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request overrides";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const generationModels = models.map((model) => ({
    requestModelKey: model.id,
    generationModel: model.kind === "catalog"
      ? { ...getModelByKey(model.modelKey), customHeaders: model.headers, customBody: model.body }
      : model.provider === "openrouter"
        ? {
            key: model.id, provider: "custom" as const, modelId: model.modelId,
            displayName: model.displayName, openRouterModelId: model.modelId,
            forceOpenRouter: true, customHeaders: model.headers, customBody: model.body,
          }
        : {
            key: model.id, provider: "custom" as const, modelId: model.modelId,
            displayName: model.displayName, baseUrl: model.baseUrl,
            customHeaders: model.headers, customBody: model.body,
          },
  }));

  if (preview) {
    if (generationModels.length !== 1) return NextResponse.json({ error: "Select one model." }, { status: 400 });
    const generationModel = generationModels[0].generationModel;
    const previewKeys = Object.fromEntries(
      Object.entries(body.providerKeys ?? {}).filter(([, key]) => Boolean(key)).map(([name]) => [name, "request-preview"]),
    );
    if (Object.keys(previewKeys).length === 0) {
      previewKeys[generationModel.forceOpenRouter ? "openrouter" : generationModel.provider] = "request-preview";
    }
    try {
      const request = await captureProviderRequest(() => generateVoxelBuild({
        model: generationModel,
        prompt: body.prompt,
        gridSize: body.gridSize,
        palette: body.palette,
        maxAttempts: 1,
        providerKeys: previewKeys,
        allowServerKeys: false,
      }));
      return NextResponse.json({ request });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Request unavailable" }, { status: 400 });
    }
  }
  if (!body.prompt.trim()) return NextResponse.json({ error: "Enter a prompt." }, { status: 400 });

  const providerKeys = body.providerKeys;
  const allowServerKeys =
    process.env.NODE_ENV !== "production" || process.env.MINEBENCH_ALLOW_SERVER_KEYS === "1";
  if (!allowServerKeys && (!providerKeys || Object.values(providerKeys).every((v) => !v))) {
    return NextResponse.json(
      {
        error: "Add an OpenRouter or provider API key in Generate settings.",
      },
      { status: 400 }
    );
  }

  const debugRaw = process.env.AI_DEBUG === "1";
  const RAW_TEXT_MAX = 200_000;

  const encoder = new TextEncoder();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req.signal.addEventListener(
        "abort",
        () => {
          closed = true;
          if (ping) clearInterval(ping);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        { once: true }
      );

      const send = (evt: GenerateEvent) => {
        if (closed) return;
        if (debugRaw && evt.type === "error" && evt.rawText) {
          console.log(`[ai debug] ${evt.modelKey} error: ${evt.message}`);
          console.log(`[ai debug] ${evt.modelKey} rawText:\n${evt.rawText}`);
        }
        try {
          controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
        } catch {
          // client disconnected / stream already closed
          closed = true;
          if (ping) clearInterval(ping);
        }
      };

      ping = setInterval(() => {
        send({ type: "ping", ts: Date.now() });
      }, PING_INTERVAL_MS);

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          if (ping) clearInterval(ping);
          controller.close();
        } catch {
          // already closed
        }
      };

      // A larger first chunk helps avoid proxy buffering so the client receives events immediately.
      send({ type: "hello", ts: Date.now(), pad: STREAM_PAD });

      let pending = models.length;
      for (const { requestModelKey, generationModel } of generationModels) {
        send({ type: "start", modelKey: requestModelKey });

        void generateVoxelBuild({
          model: generationModel,
          prompt: body.prompt,
          gridSize: body.gridSize,
          palette: body.palette,
          maxAttempts: 2,
          providerKeys,
          allowServerKeys,
          abortSignal: req.signal,
          onRetry: (attempt, reason) =>
            send({ type: "retry", modelKey: requestModelKey, attempt, reason }),
          onDelta: (delta) => send({ type: "delta", modelKey: requestModelKey, delta }),
        })
          .then((r) => {
            if (r.ok) {
              waitUntil(publishGenerationSuccess({
                jobType: "stream",
                model: requestModelKey,
                durationMs: r.generationTimeMs ?? 0,
              }));
              send({
                type: "result",
                modelKey: requestModelKey,
                voxelBuild: r.build,
                metrics: {
                  blockCount: r.blockCount,
                  warnings: r.warnings,
                  generationTimeMs: r.generationTimeMs,
                  jsonBytes: Buffer.byteLength(r.rawText),
                },
              });
            } else {
              waitUntil(publishGenerationError({
                jobType: "stream",
                model: requestModelKey,
                errorType: r.error || "generation_error",
              }));
              send({
                type: "error",
                modelKey: requestModelKey,
                message: r.error,
                rawText: r.rawText ? r.rawText.slice(0, RAW_TEXT_MAX) : undefined,
              });
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : "Generation failed";
            waitUntil(publishGenerationError({
              jobType: "stream",
              model: requestModelKey,
              errorType: message,
            }));
            send({
              type: "error",
              modelKey: requestModelKey,
              message,
            });
          })
          .finally(() => {
            pending -= 1;
            if (pending === 0) safeClose();
          });
      }
    },
    cancel() {
      closed = true;
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
