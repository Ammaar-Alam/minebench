import { z } from "zod";
import type { GenerateModelRequest, ProviderApiKeys } from "@/lib/ai/types";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { createSavedGenerations, listSavedGenerations } from "@/lib/generations/service";

export const runtime = "nodejs";

const providerKeys = z.object({
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
});

const customHeaders = z
  .record(z.string().trim().min(1).max(128), z.string().max(16_384))
  .refine((value) => Object.keys(value).length <= 32, "Too many custom headers.")
  .optional();
const customBody = z
  .record(z.string().trim().min(1).max(128), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 65_536, "Custom body is too large.")
  .optional();

const model = z.union([
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
    headers: customHeaders,
    body: customBody,
  }),
  z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("custom"),
    provider: z.literal("openrouter"),
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(240),
  }),
]);

const createRequest = z.object({
  prompt: z.string().trim().min(1).max(800),
  gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  models: z.array(model).min(1).max(8),
  providerKeys,
  reasoning: z.string().trim().min(1).max(64).optional(),
});

export async function POST(request: Request) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to save generations." } }, 401);
  const parsed = createRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the generation settings." } }, 400);
  try {
    const generations = await createSavedGenerations({
      ownerId,
      ...parsed.data,
      models: parsed.data.models as GenerateModelRequest[],
      providerKeys: parsed.data.providerKeys as ProviderApiKeys,
    });
    return apiJson({ generations }, 202);
  } catch (error) {
    return apiServiceError(error);
  }
}

export async function GET(request: Request) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view saved generations." } }, 401);
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  try {
    return apiJson(await listSavedGenerations(ownerId, {
      cursor: url.searchParams.get("cursor"),
      limit: Number.isFinite(limit) ? limit : 20,
    }));
  } catch (error) {
    return apiServiceError(error);
  }
}
