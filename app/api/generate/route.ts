import { z } from "zod";
import { NextResponse } from "next/server";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { assertSafeCustomApiUrl } from "@/lib/ai/providers/nvidia";
import type { GenerateEvent, GenerateModelRequest, GenerateRequest } from "@/lib/ai/types";

export const runtime = "nodejs";

const providerKeysSchema = z
  .object({
    openai: z.string().trim().min(1).max(4000).optional(),
    anthropic: z.string().trim().min(1).max(4000).optional(),
    gemini: z.string().trim().min(1).max(4000).optional(),
    moonshot: z.string().trim().min(1).max(4000).optional(),
    deepseek: z.string().trim().min(1).max(4000).optional(),
    openrouter: z.string().trim().min(1).max(4000).optional(),
    custom: z.string().trim().min(1).max(4000).optional(),
  })
  .optional();

const modelRequestSchema = z.union([
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("catalog"),
    modelKey: z.string().trim().min(1).max(200),
  }),
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("custom"),
    provider: z.literal("custom"),
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(240),
    baseUrl: z.string().trim().url().max(4000),
  }),
]);

const reqSchema = z.object({
  prompt: z.string().min(1).max(800),
  gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
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
    if (model.kind !== "custom") continue;
    try {
      await assertSafeCustomApiUrl(model.baseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid custom API server URL";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const providerKeys = body.providerKeys;
  const allowServerKeys =
    process.env.NODE_ENV !== "production" || process.env.MINEBENCH_ALLOW_SERVER_KEYS === "1";
  if (!allowServerKeys && (!providerKeys || Object.values(providerKeys).every((v) => !v))) {
    return NextResponse.json(
      {
        error:
          "No API keys provided. Add an OpenRouter key or a provider key (OpenAI/Anthropic/Gemini/etc.) in Sandbox settings.",
      },
      { status: 401 }
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
      for (const model of models) {
        const requestModelKey = model.id;
        send({ type: "start", modelKey: requestModelKey });

        void generateVoxelBuild(
          model.kind === "catalog"
            ? {
                modelKey: model.modelKey,
                prompt: body.prompt,
                gridSize: body.gridSize,
                palette: body.palette,
                providerKeys,
                allowServerKeys,
                abortSignal: req.signal,
                onRetry: (attempt, reason) =>
                  send({ type: "retry", modelKey: requestModelKey, attempt, reason }),
                onDelta: (delta) => send({ type: "delta", modelKey: requestModelKey, delta }),
              }
            : {
                model: {
                  key: model.id,
                  provider: "custom",
                  modelId: model.modelId,
                  displayName: model.displayName,
                  baseUrl: model.baseUrl,
                },
                prompt: body.prompt,
                gridSize: body.gridSize,
                palette: body.palette,
                providerKeys,
                allowServerKeys,
                abortSignal: req.signal,
                onRetry: (attempt, reason) =>
                  send({ type: "retry", modelKey: requestModelKey, attempt, reason }),
                onDelta: (delta) => send({ type: "delta", modelKey: requestModelKey, delta }),
              },
        )
          .then((r) => {
            if (r.ok) {
              send({
                type: "result",
                modelKey: requestModelKey,
                voxelBuild: r.build,
                metrics: {
                  blockCount: r.blockCount,
                  warnings: r.warnings,
                  generationTimeMs: r.generationTimeMs,
                },
              });
            } else {
              send({
                type: "error",
                modelKey: requestModelKey,
                message: r.error,
                rawText: r.rawText ? r.rawText.slice(0, RAW_TEXT_MAX) : undefined,
              });
            }
          })
          .catch((err: unknown) => {
            send({
              type: "error",
              modelKey: requestModelKey,
              message: err instanceof Error ? err.message : "Generation failed",
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
