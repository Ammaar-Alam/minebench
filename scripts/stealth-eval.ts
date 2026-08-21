#!/usr/bin/env -S tsx

import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import type {
  OrganizationRole,
  StealthExperimentStatus,
  StealthVariantStatus,
} from "@prisma/client";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import {
  BENCHMARK_PROMPT_COHORT_ID,
  BENCHMARK_PROMPT_MAP,
} from "../lib/benchmark/prompts";
import { prisma } from "../lib/prisma";
import {
  decryptStealthEndpointConfig,
  encryptStealthEndpointConfig,
  generateStealthConfigEncryptionKey,
  type StealthEndpointConfig,
} from "../lib/stealth/credentials";
import {
  ensureStealthBuildArtifacts,
  persistStealthBuild,
} from "../lib/stealth/generation";
import {
  normalizeStealthSlug,
  opaqueStealthModelKey,
} from "../lib/stealth/policy";

type CliArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

const EXPERIMENT_ACTIVATABLE: readonly StealthExperimentStatus[] = ["READY", "PAUSED"];
const EXPERIMENT_CONFIGURABLE: readonly StealthExperimentStatus[] = ["DRAFT", "READY", "DEGRADED"];
const VARIANT_CONFIGURABLE: readonly StealthVariantStatus[] = ["DRAFT", "READY", "DEGRADED"];

function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return { command, values, flags };
}

function value(args: CliArgs, name: string, required = true): string | undefined {
  const result = args.values.get(name)?.trim();
  if (!result && required) throw new Error(`Missing ${name}`);
  return result || undefined;
}

function positiveInt(args: CliArgs, name: string, fallback: number, max: number): number {
  const raw = value(args, name, false);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

function slugValue(args: CliArgs, name: string): string {
  const raw = value(args, name) as string;
  const slug = normalizeStealthSlug(raw);
  if (!slug) throw new Error(`${name} must contain letters or numbers`);
  return slug;
}

function endpointApiKey(): string {
  const apiKey = process.env.STEALTH_ENDPOINT_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing STEALTH_ENDPOINT_API_KEY");
  return apiKey;
}

async function findExperiment(orgSlug: string, experimentSlug: string) {
  const experiment = await prisma.stealthExperiment.findFirst({
    where: {
      slug: experimentSlug,
      organization: { slug: orgSlug },
    },
    include: { organization: true },
  });
  if (!experiment) throw new Error(`Experiment not found: ${orgSlug}/${experimentSlug}`);
  return experiment;
}

async function findVariant(orgSlug: string, experimentSlug: string, codename: string) {
  const variant = await prisma.stealthVariant.findFirst({
    where: {
      codename,
      experiment: {
        slug: experimentSlug,
        organization: { slug: orgSlug },
      },
    },
    include: {
      credential: true,
      experiment: { include: { organization: true } },
      model: true,
    },
  });
  if (!variant) throw new Error(`Variant not found: ${orgSlug}/${experimentSlug}/${codename}`);
  return variant;
}

function checkpointFingerprint(endpointUrl: string, modelId: string): string {
  return createHash("sha256")
    .update(`${endpointUrl.trim().replace(/\/+$/, "")}\n${modelId.trim()}`)
    .digest("hex");
}

async function createExperiment(args: CliArgs): Promise<void> {
  const orgSlug = slugValue(args, "--org");
  const orgName = value(args, "--org-name") as string;
  const experimentSlug = slugValue(args, "--experiment");
  const experimentName = value(args, "--experiment-name") as string;
  const targetDecisiveVotes = positiveInt(args, "--target-votes", 1000, 1_000_000);
  const exportPolicyRaw =
    value(args, "--export-policy", false)?.toUpperCase().replaceAll("-", "_") ??
    "AGGREGATES_ONLY";
  if (exportPolicyRaw !== "AGGREGATES_ONLY" && exportPolicyRaw !== "DEIDENTIFIED_VOTES") {
    throw new Error("--export-policy must be aggregates-only or deidentified-votes");
  }
  const exportPolicy = exportPolicyRaw as
    | "AGGREGATES_ONLY"
    | "DEIDENTIFIED_VOTES";
  const agreementReference = value(args, "--agreement", false);

  const organization = await prisma.organization.upsert({
    where: { slug: orgSlug },
    create: { slug: orgSlug, name: orgName },
    update: { name: orgName },
  });
  const experiment = await prisma.stealthExperiment.upsert({
    where: { organizationId_slug: { organizationId: organization.id, slug: experimentSlug } },
    create: {
      organizationId: organization.id,
      slug: experimentSlug,
      name: experimentName,
      targetDecisiveVotes,
      exportPolicy,
      agreementReference,
    },
    update: {
      name: experimentName,
      targetDecisiveVotes,
      exportPolicy,
      agreementReference,
    },
  });
  console.log(`Experiment ready for configuration: ${organization.slug}/${experiment.slug}`);
}

function endpointConfig(args: CliArgs): StealthEndpointConfig {
  return {
    protocol: "openai-chat-completions",
    endpointUrl: value(args, "--endpoint") as string,
    apiKey: endpointApiKey(),
    modelId: value(args, "--model-id") as string,
    requireStructuredOutput: !args.flags.has("--allow-unstructured"),
    enableTools: !args.flags.has("--no-tools"),
    reasoning: value(args, "--reasoning", false),
  };
}

async function configureVariant(args: CliArgs): Promise<void> {
  const orgSlug = slugValue(args, "--org");
  const experimentSlug = slugValue(args, "--experiment");
  const codename = value(args, "--codename") as string;
  const experiment = await findExperiment(orgSlug, experimentSlug);
  if (!EXPERIMENT_CONFIGURABLE.includes(experiment.status)) {
    throw new Error(`Experiment ${experiment.status.toLowerCase()} cannot accept endpoint changes`);
  }
  const config = endpointConfig(args);
  const encrypted = encryptStealthEndpointConfig(config);
  const fingerprint = checkpointFingerprint(config.endpointUrl, config.modelId);
  const existing = await prisma.stealthVariant.findUnique({
    where: { experimentId_codename: { experimentId: experiment.id, codename } },
    include: { _count: { select: { matchups: true } } },
  });

  if (existing) {
    if (!VARIANT_CONFIGURABLE.includes(existing.status)) {
      throw new Error(`Variant ${existing.status.toLowerCase()} cannot be reconfigured`);
    }
    if (existing._count.matchups > 0) throw new Error("A sampled variant cannot be reconfigured");
    if (
      existing.generatedBuildCount > 0 &&
      existing.checkpointFingerprint &&
      existing.checkpointFingerprint !== fingerprint
    ) {
      throw new Error("Checkpoint identity cannot change after cohort generation has started");
    }
    await prisma.$transaction([
      prisma.stealthVariant.update({
        where: { id: existing.id },
        data: {
          checkpointFingerprint: fingerprint,
          endpointEnabled: true,
          lastGenerationError: null,
        },
      }),
      prisma.stealthEndpointCredential.upsert({
        where: { variantId: existing.id },
        create: { variantId: existing.id, ...encrypted },
        update: encrypted,
      }),
    ]);
    console.log(`Endpoint configuration updated: ${orgSlug}/${experimentSlug}/${codename}`);
    return;
  }

  const variantId = randomUUID();
  const modelId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.model.create({
      data: {
        id: modelId,
        key: opaqueStealthModelKey(experiment.id, variantId),
        provider: "Stealth",
        modelId: variantId,
        displayName: codename,
        enabled: false,
      },
    });
    await tx.stealthVariant.create({
      data: {
        id: variantId,
        experimentId: experiment.id,
        codename,
        modelId,
        checkpointFingerprint: fingerprint,
        endpointEnabled: true,
        expectedBuildCount: Object.keys(BENCHMARK_PROMPT_MAP).length,
        credential: { create: encrypted },
      },
    });
  });
  console.log(`Variant configured: ${orgSlug}/${experimentSlug}/${codename}`);
}

async function findAuthUserByEmail(email: string) {
  const { createSupabaseAdminClient } = await import("../lib/supabase/admin");
  const supabase = createSupabaseAdminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (found) return { supabase, user: found, invited: false };
    if (data.users.length < 1000) break;
  }
  const siteUrl = (process.env.MINEBENCH_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (!siteUrl) throw new Error("Missing MINEBENCH_SITE_URL for the invitation redirect");
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${siteUrl}/lab/auth/confirm?next=/lab`,
  });
  if (error) throw error;
  if (!data.user) throw new Error("Supabase did not return the invited user");
  return { supabase, user: data.user, invited: true };
}

async function inviteMember(args: CliArgs): Promise<void> {
  const orgSlug = slugValue(args, "--org");
  const email = (value(args, "--email") as string).toLowerCase();
  const role = (value(args, "--role") as string).toUpperCase() as OrganizationRole;
  if (!(["OWNER", "ADMIN", "ANALYST", "VIEWER"] as const).includes(role)) {
    throw new Error("--role must be owner, admin, analyst, or viewer");
  }
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } });
  if (!organization) throw new Error(`Organization not found: ${orgSlug}`);
  const { user, invited } = await findAuthUserByEmail(email);
  await prisma.$transaction([
    prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, email },
      update: { email },
    }),
    prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      create: { organizationId: organization.id, userId: user.id, role },
      update: { role },
    }),
    prisma.organizationInvitation.upsert({
      where: { organizationId_email: { organizationId: organization.id, email } },
      create: { organizationId: organization.id, email, role, authUserId: user.id },
      update: { role, authUserId: user.id, revokedAt: null },
    }),
  ]);
  console.log(`${invited ? "Invitation sent" : "Access granted"}: ${email} -> ${orgSlug} (${role.toLowerCase()})`);
}

async function revokeMember(args: CliArgs): Promise<void> {
  const orgSlug = slugValue(args, "--org");
  const email = (value(args, "--email") as string).toLowerCase();
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } });
  if (!organization) throw new Error(`Organization not found: ${orgSlug}`);
  const [membership, invitation] = await prisma.$transaction([
    prisma.organizationMembership.deleteMany({
      where: { organizationId: organization.id, user: { email } },
    }),
    prisma.organizationInvitation.updateMany({
      where: { organizationId: organization.id, email, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
  console.log(
    membership.count + invitation.count > 0
      ? `Access revoked: ${email} -> ${orgSlug}`
      : `Access already absent: ${email} -> ${orgSlug}`,
  );
}

async function prepareCohortPrompts() {
  const entries = Object.entries(BENCHMARK_PROMPT_MAP);
  const prompts = await Promise.all(
    entries.map(async ([slug, text]) => ({
      slug,
      text,
      prompt: await prisma.prompt.upsert({
        where: { text },
        create: { text, active: true },
        update: { active: true },
      }),
    })),
  );
  return prompts.sort((a, b) => {
    if (a.slug === "astronaut") return -1;
    if (b.slug === "astronaut") return 1;
    return a.slug.localeCompare(b.slug);
  });
}

async function generateVariant(args: CliArgs): Promise<void> {
  const orgSlug = slugValue(args, "--org");
  const experimentSlug = slugValue(args, "--experiment");
  const codename = value(args, "--codename") as string;
  const maxAttempts = positiveInt(args, "--attempts", 3, 10);
  const concurrency = positiveInt(args, "--concurrency", 1, 4);
  const variant = await findVariant(orgSlug, experimentSlug, codename);
  if (!variant.endpointEnabled || !variant.credential) {
    throw new Error("Variant endpoint is disabled; configure it before generation");
  }
  if (!VARIANT_CONFIGURABLE.includes(variant.status)) {
    throw new Error(`Variant ${variant.status.toLowerCase()} cannot generate a cohort`);
  }
  const config = decryptStealthEndpointConfig(variant.credential.encryptedConfig);
  const prompts = await prepareCohortPrompts();
  const expectedBuildCount = prompts.length;
  const run = await prisma.$transaction(async (tx) => {
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: { status: "VALIDATING", expectedBuildCount, lastGenerationError: null },
    });
    await tx.stealthExperiment.update({
      where: { id: variant.experimentId },
      data: { status: "VALIDATING" },
    });
    return tx.stealthGenerationRun.create({
      data: {
        variantId: variant.id,
        promptCohortId: BENCHMARK_PROMPT_COHORT_ID,
        expectedBuildCount,
        configuration: {
          protocol: config.protocol,
          credentialFingerprint: variant.credential?.fingerprint,
          gridSize: 256,
          palette: "simple",
          mode: "precise",
          enableTools: config.enableTools,
          requireStructuredOutput: config.requireStructuredOutput,
          reasoning: config.reasoning ?? null,
          maxAttempts,
          concurrency,
        },
      },
    });
  });

  let providerCallCount = 0;
  let retryCount = 0;
  let completedBuildCount = 0;
  let failedBuildCount = 0;
  let lastError: string | null = null;

  const generateOne = async (entry: Awaited<ReturnType<typeof prepareCohortPrompts>>[number]) => {
    const existing = await prisma.build.findUnique({
      where: {
        promptId_modelId_gridSize_palette_mode: {
          promptId: entry.prompt.id,
          modelId: variant.modelId,
          gridSize: 256,
          palette: "simple",
          mode: "precise",
        },
      },
      select: { id: true },
    });
    if (existing) {
      try {
        await ensureStealthBuildArtifacts(existing.id);
        completedBuildCount += 1;
        await prisma.stealthGenerationResult.upsert({
          where: { runId_promptId: { runId: run.id, promptId: entry.prompt.id } },
          create: {
            runId: run.id,
            promptId: entry.prompt.id,
            buildId: existing.id,
            status: "SUCCEEDED",
            attempts: 0,
            generationTimeMs: 0,
          },
          update: { buildId: existing.id, status: "SUCCEEDED", error: null },
        });
        console.log(`Reused ${entry.slug}`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedBuildCount += 1;
        lastError = message;
        await prisma.stealthGenerationResult.upsert({
          where: { runId_promptId: { runId: run.id, promptId: entry.prompt.id } },
          create: {
            runId: run.id,
            promptId: entry.prompt.id,
            buildId: existing.id,
            status: "FAILED",
            attempts: 0,
            generationTimeMs: 0,
            error: message.slice(0, 4000),
          },
          update: { status: "FAILED", error: message.slice(0, 4000) },
        });
        console.error(`Failed ${entry.slug}: ${message}`);
        return false;
      }
    }

    let attempts = 1;
    const result = await generateVoxelBuild({
      model: {
        key: variant.model.key,
        provider: "custom",
        modelId: config.modelId,
        displayName: codename,
        baseUrl: config.endpointUrl,
        requireStructuredOutput: config.requireStructuredOutput,
      },
      prompt: entry.text,
      gridSize: 256,
      palette: "simple",
      maxAttempts,
      enableTools: config.enableTools,
      reasoning: config.reasoning,
      providerKeys: { custom: config.apiKey },
      allowServerKeys: false,
      onProviderRequest: () => {
        providerCallCount += 1;
      },
      onRetry: (attempt) => {
        attempts = Math.max(attempts, attempt);
        retryCount += 1;
      },
    });
    if (!result.ok) {
      failedBuildCount += 1;
      lastError = result.error;
      await prisma.stealthGenerationResult.create({
        data: {
          runId: run.id,
          promptId: entry.prompt.id,
          status: "FAILED",
          attempts,
          generationTimeMs: result.generationTimeMs,
          requestConfiguration: result.requestConfiguration,
          error: result.error.slice(0, 4000),
        },
      });
      console.error(`Failed ${entry.slug}: ${result.error}`);
      return false;
    }

    try {
      const build = await persistStealthBuild({
        variantId: variant.id,
        modelId: variant.modelId,
        promptSlug: entry.slug,
        promptText: entry.text,
        build: result.build,
        generationTimeMs: result.generationTimeMs,
      });
      completedBuildCount += 1;
      await prisma.stealthGenerationResult.create({
        data: {
          runId: run.id,
          promptId: entry.prompt.id,
          buildId: build.id,
          status: "SUCCEEDED",
          attempts,
          generationTimeMs: result.generationTimeMs,
          requestConfiguration: result.requestConfiguration,
        },
      });
      console.log(`Generated ${entry.slug} (${build.blockCount} blocks)`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedBuildCount += 1;
      lastError = message;
      await prisma.stealthGenerationResult.create({
        data: {
          runId: run.id,
          promptId: entry.prompt.id,
          status: "FAILED",
          attempts,
          generationTimeMs: result.generationTimeMs,
          requestConfiguration: result.requestConfiguration,
          error: message.slice(0, 4000),
        },
      });
      console.error(`Failed ${entry.slug}: ${message}`);
      return false;
    }
  };

  const pending = [] as typeof prompts;
  for (const prompt of prompts) {
    const exists = await prisma.build.findUnique({
      where: {
        promptId_modelId_gridSize_palette_mode: {
          promptId: prompt.prompt.id,
          modelId: variant.modelId,
          gridSize: 256,
          palette: "simple",
          mode: "precise",
        },
      },
      select: { id: true },
    });
    if (exists) pending.push(prompt);
    else pending.unshift(prompt);
  }
  const validationPrompt = pending.shift();
  const validated = validationPrompt ? await generateOne(validationPrompt) : true;
  if (validated) {
    await prisma.$transaction([
      prisma.stealthVariant.update({
        where: { id: variant.id },
        data: { status: "GENERATING", lastValidatedAt: new Date() },
      }),
      prisma.stealthExperiment.update({
        where: { id: variant.experimentId },
        data: { status: "GENERATING" },
      }),
    ]);
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < pending.length) {
          const entry = pending[next];
          next += 1;
          if (entry) await generateOne(entry);
        }
      }),
    );
  }

  const generatedBuildCount = await prisma.build.count({
    where: {
      modelId: variant.modelId,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      prompt: { text: { in: prompts.map((entry) => entry.text) } },
    },
  });
  const complete = generatedBuildCount === expectedBuildCount && failedBuildCount === 0;
  const runStatus = complete ? "SUCCEEDED" : completedBuildCount > 0 ? "PARTIAL" : "FAILED";
  await prisma.$transaction(async (tx) => {
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        status: runStatus,
        completedBuildCount,
        failedBuildCount,
        providerCallCount,
        retryCount,
        completedAt: new Date(),
        error: lastError?.slice(0, 4000) ?? null,
      },
    });
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: {
        status: complete ? "READY" : "DEGRADED",
        endpointEnabled: !complete,
        expectedBuildCount,
        generatedBuildCount,
        generationFailureCount: failedBuildCount,
        lastGenerationError: lastError?.slice(0, 4000) ?? null,
        cohortGeneratedAt: complete ? new Date() : null,
      },
    });
    if (complete) {
      await tx.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } });
    }
    const incompleteVariants = await tx.stealthVariant.count({
      where: { experimentId: variant.experimentId, status: { not: "READY" } },
    });
    await tx.stealthExperiment.update({
      where: { id: variant.experimentId },
      data: { status: incompleteVariants === 0 ? "READY" : "DEGRADED" },
    });
  });
  if (!complete) throw new Error(lastError ?? "Cohort generation did not complete");
  console.log(`Cohort ready: ${generatedBuildCount}/${expectedBuildCount} builds; endpoint credential deleted`);
}

async function activateExperiment(args: CliArgs): Promise<void> {
  const experiment = await findExperiment(slugValue(args, "--org"), slugValue(args, "--experiment"));
  if (!EXPERIMENT_ACTIVATABLE.includes(experiment.status)) {
    throw new Error(`Experiment must be ready or paused, not ${experiment.status.toLowerCase()}`);
  }
  const variants = await prisma.stealthVariant.findMany({ where: { experimentId: experiment.id } });
  const runnableVariants = variants.filter(
    (variant) => variant.status !== "WITHDRAWN" && variant.status !== "RELEASED",
  );
  if (runnableVariants.length === 0) throw new Error("Experiment has no runnable variants");
  for (const variant of runnableVariants) {
    if (variant.status !== "READY" && !(experiment.status === "PAUSED" && variant.status === "ACTIVE")) {
      throw new Error(`Variant ${variant.codename} is not ready`);
    }
    if (variant.generatedBuildCount !== variant.expectedBuildCount || variant.expectedBuildCount === 0) {
      throw new Error(`Variant ${variant.codename} does not have a complete cohort`);
    }
  }
  await prisma.$transaction([
    prisma.model.updateMany({
      where: { id: { in: runnableVariants.map((variant) => variant.modelId) } },
      data: { enabled: true },
    }),
    prisma.stealthVariant.updateMany({
      where: { id: { in: runnableVariants.map((variant) => variant.id) } },
      data: { status: "ACTIVE", endpointEnabled: false },
    }),
    prisma.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "ACTIVE", startsAt: experiment.startsAt ?? new Date(), endedAt: null },
    }),
  ]);
  console.log(`Experiment active: ${experiment.organization.slug}/${experiment.slug}`);
}

async function pauseExperiment(args: CliArgs): Promise<void> {
  const experiment = await findExperiment(slugValue(args, "--org"), slugValue(args, "--experiment"));
  if (experiment.status !== "ACTIVE" && experiment.status !== "STABLE") {
    throw new Error("Only an active or stable experiment can be paused");
  }
  const variants = await prisma.stealthVariant.findMany({
    where: { experimentId: experiment.id },
    select: { modelId: true },
  });
  await prisma.$transaction([
    prisma.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    }),
    prisma.stealthExperiment.update({ where: { id: experiment.id }, data: { status: "PAUSED" } }),
  ]);
  console.log(`Experiment paused: ${experiment.organization.slug}/${experiment.slug}`);
}

async function stabilizeExperiment(args: CliArgs): Promise<void> {
  const experiment = await findExperiment(slugValue(args, "--org"), slugValue(args, "--experiment"));
  if (experiment.status !== "ACTIVE") throw new Error("Only an active experiment can be stabilized");
  const variants = await prisma.stealthVariant.findMany({
    where: { experimentId: experiment.id, status: "ACTIVE" },
  });
  if (variants.length === 0) throw new Error("Experiment has no active variants");
  const short = variants.find(
    (variant) => variant.winCount + variant.lossCount < experiment.targetDecisiveVotes,
  );
  if (short) {
    throw new Error(
      `${short.codename} has ${short.winCount + short.lossCount}/${experiment.targetDecisiveVotes} decisive votes`,
    );
  }
  await prisma.stealthExperiment.update({ where: { id: experiment.id }, data: { status: "STABLE" } });
  console.log(`Experiment stable: ${experiment.organization.slug}/${experiment.slug}`);
}

async function closeExperiment(args: CliArgs): Promise<void> {
  const experiment = await findExperiment(slugValue(args, "--org"), slugValue(args, "--experiment"));
  if (experiment.status === "RELEASED") {
    throw new Error("A released evaluation cannot be closed again");
  }
  if (experiment.status === "CLOSED") {
    console.log(
      `Experiment already closed; retention deadline ${experiment.retentionDeleteAt?.toISOString() ?? "not set"}`,
    );
    return;
  }
  const retentionDays = positiveInt(args, "--retention-days", 30, 3650);
  const variants = await prisma.stealthVariant.findMany({
    where: { experimentId: experiment.id },
    select: { id: true, modelId: true },
  });
  const endedAt = new Date();
  const retentionDeleteAt = new Date(endedAt.getTime() + retentionDays * 86_400_000);
  await prisma.$transaction([
    prisma.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    }),
    prisma.stealthVariant.updateMany({
      where: { experimentId: experiment.id, status: { not: "RELEASED" } },
      data: { status: "WITHDRAWN", endpointEnabled: false },
    }),
    prisma.stealthEndpointCredential.deleteMany({
      where: { variantId: { in: variants.map((variant) => variant.id) } },
    }),
    prisma.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "CLOSED", endedAt, retentionDeleteAt },
    }),
  ]);
  console.log(`Experiment closed; retention deadline ${retentionDeleteAt.toISOString()}`);
}

async function withdrawVariant(args: CliArgs): Promise<void> {
  const variant = await findVariant(
    slugValue(args, "--org"),
    slugValue(args, "--experiment"),
    value(args, "--codename") as string,
  );
  if (variant.status === "RELEASED") {
    throw new Error("A released variant cannot be withdrawn");
  }
  if (variant.status === "WITHDRAWN") {
    console.log(`Variant already withdrawn: ${variant.codename}`);
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.model.update({ where: { id: variant.modelId }, data: { enabled: false } });
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: { status: "WITHDRAWN", endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } });
    const remaining = await tx.stealthVariant.count({
      where: { experimentId: variant.experimentId, status: { in: ["ACTIVE", "READY"] } },
    });
    if (remaining === 0) {
      const endedAt = new Date();
      await tx.stealthExperiment.update({
        where: { id: variant.experimentId },
        data: {
          status: "WITHDRAWN",
          endedAt,
          retentionDeleteAt:
            variant.experiment.retentionDeleteAt ?? new Date(endedAt.getTime() + 30 * 86_400_000),
        },
      });
    }
  });
  console.log(`Variant withdrawn: ${variant.codename}`);
}

async function releaseVariant(args: CliArgs): Promise<void> {
  if (!args.flags.has("--attest-exact-checkpoint")) {
    throw new Error("Release requires --attest-exact-checkpoint");
  }
  const variant = await findVariant(
    slugValue(args, "--org"),
    slugValue(args, "--experiment"),
    value(args, "--codename") as string,
  );
  if (!variant.checkpointFingerprint || !variant.cohortGeneratedAt) {
    throw new Error("Variant has no completed checkpoint cohort to attest");
  }
  if (variant.experiment.status !== "CLOSED" && variant.experiment.status !== "RELEASED") {
    throw new Error("Close the evaluation before recording a public release mapping");
  }
  const publicModelKey = value(args, "--public-model") as string;
  const publicModel = await prisma.model.findUnique({
    where: { key: publicModelKey },
    include: { stealthVariant: true },
  });
  if (!publicModel || publicModel.stealthVariant) {
    throw new Error(`Public model not found: ${publicModelKey}`);
  }
  if (variant.status === "RELEASED") {
    if (variant.releasedModelId === publicModel.id) {
      console.log(`Release mapping already recorded: ${variant.codename} -> ${publicModel.key}`);
      return;
    }
    throw new Error("A released variant cannot be mapped to a different public model");
  }
  await prisma.$transaction(async (tx) => {
    await tx.model.update({ where: { id: variant.modelId }, data: { enabled: false } });
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } });
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: {
        status: "RELEASED",
        endpointEnabled: false,
        releasedModelId: publicModel.id,
        releasedAt: new Date(),
      },
    });
    const unreleased = await tx.stealthVariant.count({
      where: { experimentId: variant.experimentId, status: { not: "RELEASED" } },
    });
    if (unreleased === 0) {
      await tx.stealthExperiment.update({
        where: { id: variant.experimentId },
        data: { status: "RELEASED", endedAt: variant.experiment.endedAt ?? new Date() },
      });
    }
  });
  console.log(`Release mapping recorded: ${variant.codename} -> ${publicModel.key}`);
  console.log("Private ratings were not transferred; the public model starts with its own votes");
}

async function disableEndpoint(args: CliArgs): Promise<void> {
  const variant = await findVariant(
    slugValue(args, "--org"),
    slugValue(args, "--experiment"),
    value(args, "--codename") as string,
  );
  await prisma.$transaction([
    prisma.stealthVariant.update({
      where: { id: variant.id },
      data: { endpointEnabled: false },
    }),
    prisma.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } }),
  ]);
  console.log(`Endpoint credential deleted: ${variant.codename}`);
}

async function printStatus(args: CliArgs): Promise<void> {
  const experiment = await prisma.stealthExperiment.findFirst({
    where: {
      slug: slugValue(args, "--experiment"),
      organization: { slug: slugValue(args, "--org") },
    },
    include: {
      organization: true,
      variants: {
        orderBy: { codename: "asc" },
        include: {
          releasedModel: { select: { key: true } },
          generationRuns: { orderBy: { startedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!experiment) throw new Error("Experiment not found");
  console.log(`${experiment.organization.name} / ${experiment.name}`);
  console.log(`status=${experiment.status.toLowerCase()} export=${experiment.exportPolicy.toLowerCase()}`);
  for (const variant of experiment.variants) {
    const decisive = variant.winCount + variant.lossCount;
    const latestRun = variant.generationRuns[0];
    console.log(
      [
        variant.codename,
        `status=${variant.status.toLowerCase()}`,
        `cohort=${variant.generatedBuildCount}/${variant.expectedBuildCount}`,
        `votes=${decisive}/${experiment.targetDecisiveVotes}`,
        `record=${variant.winCount}-${variant.lossCount}-${variant.drawCount}`,
        `rd=${variant.glickoRd.toFixed(1)}`,
        `endpoint=${variant.endpointEnabled ? "enabled" : "disabled"}`,
        latestRun ? `last_run=${latestRun.status.toLowerCase()}` : null,
        variant.releasedModel ? `released_as=${variant.releasedModel.key}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

function printHelp(): void {
  console.log(`MineBench private evaluation operator

Commands:
  keygen
  create --org NAME --org-name NAME --experiment NAME --experiment-name NAME [--target-votes N] [--export-policy aggregates-only|deidentified-votes] [--agreement REF]
  configure --org NAME --experiment NAME --codename NAME --endpoint URL --model-id ID [--reasoning MODE] [--no-tools] [--allow-unstructured]
  invite --org NAME --email EMAIL --role owner|admin|analyst|viewer
  revoke --org NAME --email EMAIL
  generate --org NAME --experiment NAME --codename NAME [--attempts N] [--concurrency N]
  activate --org NAME --experiment NAME
  pause --org NAME --experiment NAME
  stabilize --org NAME --experiment NAME
  close --org NAME --experiment NAME [--retention-days N]
  withdraw --org NAME --experiment NAME --codename NAME
  release --org NAME --experiment NAME --codename NAME --public-model KEY --attest-exact-checkpoint
  disable-endpoint --org NAME --experiment NAME --codename NAME
  status --org NAME --experiment NAME

Set STEALTH_ENDPOINT_API_KEY only for configure. Never pass checkpoint keys on the command line.`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  switch (args.command) {
    case "keygen":
      console.log(generateStealthConfigEncryptionKey());
      return;
    case "create":
      return createExperiment(args);
    case "configure":
      return configureVariant(args);
    case "invite":
      return inviteMember(args);
    case "revoke":
      return revokeMember(args);
    case "generate":
      return generateVariant(args);
    case "activate":
      return activateExperiment(args);
    case "pause":
      return pauseExperiment(args);
    case "stabilize":
      return stabilizeExperiment(args);
    case "close":
      return closeExperiment(args);
    case "withdraw":
      return withdrawVariant(args);
    case "release":
      return releaseVariant(args);
    case "disable-endpoint":
      return disableEndpoint(args);
    case "status":
      return printStatus(args);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
