import { z } from "zod";
import { NextResponse } from "next/server";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent, GenerateRequest } from "@/lib/ai/types";

export const runtime = "nodejs";

const reqSchema = z.object({
  prompt: z.string().min(1).max(800),
  gridSize: z.union([z.literal(32), z.literal(64), z.literal(128)]),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  mode: z.union([z.literal("precise"), z.literal("creative")]),
  modelKeys: z.array(z.string()).min(1).max(8),
});

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (evt: GenerateEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
      };

      let pending = modelKeys.length;
      for (const modelKey of modelKeys) {
        send({ type: "start", modelKey });

        void generateVoxelBuild({
          modelKey,
          prompt: body.prompt,
          gridSize: body.gridSize,
          palette: body.palette,
          mode: body.mode,
          onRetry: (attempt, reason) => send({ type: "retry", modelKey, attempt }),
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
            if (pending === 0) controller.close();
          });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

