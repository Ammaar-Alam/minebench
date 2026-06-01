import { createHmac } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getModelByKey, type ModelKey } from "@/lib/ai/modelCatalog";
import { assertSafeCustomApiUrl } from "@/lib/ai/providers/nvidia";
import type { ProviderApiKeys } from "@/lib/ai/types";
import {
  chooseCustomBuildProviderCredential,
  customBuildsEnabled,
  customBuildError,
  customBuildNoStoreHeaders,
} from "@/lib/custom-builds/api";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildJobMaxAttempts } from "@/lib/custom-builds/jobs";
import { encryptProviderKey } from "@/lib/custom-builds/secrets";
import { sha256Hex } from "@/lib/custom-builds/artifacts";
import { CUSTOM_BUILD_EXPORT_FORMATS } from "@/lib/custom-builds/types";
import { prisma } from "@/lib/prisma";

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
    openrouter: z.string().trim().min(1).max(4000).optional(),
    custom: z.string().trim().min(1).max(4000).optional(),
  })
  .optional();

const modelRequestSchema = z.union([
  z.object({
    kind: z.literal("catalog"),
    modelKey: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal("custom"),
    provider: z.literal("custom"),
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(240),
    baseUrl: z.string().trim().url().max(4000),
  }),
]);

const createSchema = z.object({
  prompt: z.string().trim().min(1).max(800),
  gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  model: modelRequestSchema,
  providerKeys: providerKeysSchema,
  preferOpenRouter: z.boolean().optional(),
  reasoning: z.string().trim().min(1).max(64).optional(),
  exports: z.array(z.enum(CUSTOM_BUILD_EXPORT_FORMATS)).max(3).optional(),
});

function getSecretTtlMs(): number {
  const raw = Number.parseInt(process.env.CUSTOM_BUILD_SECRET_TTL_SECONDS ?? "7200", 10);
  const seconds = Number.isFinite(raw) ? Math.max(60, Math.min(raw, 60 * 60 * 24)) : 7200;
  return seconds * 1000;
}

function hashNullable(value: string | null): string | null {
  if (!value) return null;
  const secret = (
    process.env.CUSTOM_BUILD_METADATA_HASH_SECRET ??
    process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET ??
    ""
  ).trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(value).digest("hex");
}

function requestIp(req: Request): string | null {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-vercel-forwarded-for") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function dayKey(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

function pageOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

function isModelKey(value: string): value is ModelKey {
  try {
    getModelByKey(value as ModelKey);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!customBuildsEnabled()) {
    return customBuildError("custom_builds_disabled", "Custom builds are not enabled.", 503);
  }

  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return customBuildError("invalid_request", parsed.error.message, 400);
  }

  const body = parsed.data;
  const requestedExports = Array.from(new Set(body.exports ?? []));

  let model: {
    modelKind: string;
    modelKey?: string;
    modelProvider: string;
    modelId: string;
    modelDisplayName: string;
    openRouterModelId?: string;
    customBaseUrl?: string;
    forceOpenRouter?: boolean;
  };
  if (body.model.kind === "catalog") {
    if (!isModelKey(body.model.modelKey)) {
      return customBuildError("invalid_request", "Unknown model.", 400);
    }
    const entry = getModelByKey(body.model.modelKey);
    model = {
      modelKind: "catalog",
      modelKey: entry.key,
      modelProvider: entry.provider,
      modelId: entry.modelId,
      modelDisplayName: entry.displayName,
      openRouterModelId: entry.openRouterModelId,
      forceOpenRouter: entry.forceOpenRouter,
    };
  } else {
    try {
      await assertSafeCustomApiUrl(body.model.baseUrl);
    } catch (error) {
      return customBuildError(
        "invalid_custom_api_url",
        error instanceof Error ? error.message : "Invalid custom API server URL.",
        400,
      );
    }
    model = {
      modelKind: "custom",
      modelProvider: "custom",
      modelId: body.model.modelId,
      modelDisplayName: body.model.displayName,
      customBaseUrl: body.model.baseUrl,
    };
  }

  let credential;
  try {
    credential = chooseCustomBuildProviderCredential({
      modelProvider: model.modelProvider,
      openRouterModelId: model.openRouterModelId,
      preferOpenRouter: body.preferOpenRouter,
      forceOpenRouter: model.forceOpenRouter,
      providerKeys: body.providerKeys as ProviderApiKeys | undefined,
    });
  } catch {
    return customBuildError("missing_provider_key", "A provider key is required to start this build.", 401);
  }

  let encrypted;
  try {
    encrypted = encryptProviderKey(credential.providerKey, { provider: credential.provider });
  } catch {
    return customBuildError("worker_failed", "Custom build credential encryption is not configured.", 500);
  }

  const useOpenRouter = credential.provider === "openrouter";
  const publicId = generateCustomBuildPublicId();
  const origin = pageOrigin(req);
  const expiresAt = new Date(Date.now() + getSecretTtlMs());
  const maxAttempts = getCustomBuildJobMaxAttempts();

  await prisma.$transaction(async (tx) => {
    await tx.customBuild.create({
      data: {
        publicId,
        status: "queued",
        currentStage: "queued",
        promptText: body.prompt,
        promptSha256: sha256Hex(body.prompt),
        gridSize: body.gridSize,
        palette: body.palette,
        modelKind: model.modelKind,
        modelKey: model.modelKey,
        modelProvider: model.modelProvider,
        modelId: model.modelId,
        modelDisplayName: model.modelDisplayName,
        openRouterModelId: model.openRouterModelId,
        customBaseUrl: model.customBaseUrl,
        preferOpenRouter: useOpenRouter,
        reasoning: body.reasoning,
        requestedIpHash: hashNullable(requestIp(req)),
        requestedUserAgentHash: hashNullable(req.headers.get("user-agent")),
        secret: {
          create: {
            provider: encrypted.provider,
            keyCiphertext: encrypted.keyCiphertext,
            keyIv: encrypted.keyIv,
            keyAuthTag: encrypted.keyAuthTag,
            keyVersion: encrypted.keyVersion,
            expiresAt,
          },
        },
        jobs: {
          create: {
            type: "generate",
            status: "queued",
            maxAttempts,
            payload: { requestedExports },
          },
        },
        events: {
          create: {
            seq: 1,
            type: "queued",
            data: { stage: "queued" },
          },
        },
      },
    });
    await tx.customBuildStatsDaily.upsert({
      where: { day: dayKey() },
      create: {
        day: dayKey(),
        created: 1,
        exportsRequested: requestedExports.length,
      },
      update: {
        created: { increment: 1 },
        exportsRequested: { increment: requestedExports.length },
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  return Response.json(
    {
      id: publicId,
      status: "queued",
      pageUrl: `${origin}/custom/${publicId}`,
      statusUrl: `${origin}/api/custom-builds/${publicId}`,
      eventsUrl: `${origin}/api/custom-builds/${publicId}/events`,
      exportsUrl: `${origin}/api/custom-builds/${publicId}/exports`,
      artifactsUrl: `${origin}/api/custom-builds/${publicId}/artifacts`,
      requestedExports,
    },
    {
      status: 202,
      headers: customBuildNoStoreHeaders(),
    },
  );
}
