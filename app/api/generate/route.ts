import { z } from "zod";
import { NextResponse } from "next/server";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent, GenerateRequest } from "@/lib/ai/types";

export const runtime = "nodejs";

const providerKeysSchema = z
  .object({
    openai: z.string().trim().min(1).max(4000).optional(),
    anthropic: z.string().trim().min(1).max(4000).optional(),
    gemini: z.string().trim().min(1).max(4000).optional(),
    moonshot: z.string().trim().min(1).max(4000).optional(),
    deepseek: z.string().trim().min(1).max(4000).optional(),
    openrouter: z.string().trim().min(1).max(4000).optional(),
  })
  .optional();

const reqSchema = z.object({
  prompt: z.string().min(1).max(800),
  gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  modelKeys: z.array(z.string()).min(1).max(8),
  providerKeys: providerKeysSchema,
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
  const modelKeys = body.modelKeys.filter(isModelKey);
  if (modelKeys.length === 0) {
    return NextResponse.json({ error: "No valid modelKeys" }, { status: 400 });
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

      let pending = modelKeys.length;
      for (const modelKey of modelKeys) {
        send({ type: "start", modelKey });

        void generateVoxelBuild({
          modelKey,
          prompt: body.prompt,
          gridSize: body.gridSize,
          palette: body.palette,
          providerKeys,
          allowServerKeys,
          onRetry: (attempt, reason) => send({ type: "retry", modelKey, attempt, reason }),
          onDelta: (delta) => send({ type: "delta", modelKey, delta }),
        })
          .then((r) => {
            if (r.ok) {
              send({
                type: "result",
                modelKey,
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
                modelKey,
                message: r.error,
                rawText: debugRaw && r.rawText ? r.rawText.slice(0, RAW_TEXT_MAX) : undefined,
              });
            }
          })
          .catch((err: unknown) => {
            send({
              type: "error",
              modelKey,
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
