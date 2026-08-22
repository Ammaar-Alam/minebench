#!/usr/bin/env -S tsx

import "dotenv/config";
import { readFile } from "node:fs/promises";
import type {
  OrganizationRole,
  StealthExportPolicy,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  generateStealthConfigEncryptionKey,
  type StealthEndpointConfig,
  type StealthEndpointProtocol,
} from "../lib/stealth/credentials";

type CliArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

type ServiceModule = typeof import("../lib/stealth/service");
type GenerationRunModule = typeof import("../lib/stealth/generationRun");
type WorkflowApiModule = typeof import("workflow/api");
const OPERATOR_ACTOR = { minebenchAdmin: true } as const;
const STEALTH_GENERATION_WORKFLOW = {
  workflowId: "workflow//./workflows/stealth-generation//generateStealthCohortWorkflow",
} as const;
let servicePromise: Promise<ServiceModule> | null = null;
let generationRunPromise: Promise<GenerationRunModule> | null = null;
let workflowPromise: Promise<WorkflowApiModule> | null = null;

async function service(): Promise<ServiceModule> {
  servicePromise ??= import("../lib/stealth/service");
  return servicePromise;
}

async function generationRun(): Promise<GenerationRunModule> {
  generationRunPromise ??= import("../lib/stealth/generationRun");
  return generationRunPromise;
}

async function workflow(): Promise<WorkflowApiModule> {
  workflowPromise ??= import("workflow/api");
  return workflowPromise;
}

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

function option(args: CliArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.values.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function requiredOption(args: CliArgs, ...names: string[]): string {
  const value = option(args, ...names);
  if (!value) throw new Error(`Missing ${names[0]}`);
  return value;
}

function normalizeSlug(raw: string, label: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error(`${label} must contain letters or numbers`);
  return slug;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Enter a valid email");
  }
  return email;
}

function positiveInt(
  args: CliArgs,
  names: string[],
  fallback: number | null,
  max: number,
): number | null {
  const raw = option(args, ...names);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${names[0]} must be from 1 to ${max}`);
  }
  return parsed;
}

function roleValue(args: CliArgs): OrganizationRole {
  const role = requiredOption(args, "--role").toUpperCase();
  if (role !== "ADMIN" && role !== "MEMBER") {
    throw new Error("--role must be admin or member");
  }
  return role;
}

function exportPolicyValue(args: CliArgs): StealthExportPolicy | undefined {
  const raw = option(args, "--export-policy");
  if (!raw) return undefined;
  const policy = raw.trim().toUpperCase().replaceAll("-", "_");
  if (policy !== "AGGREGATES_ONLY" && policy !== "DEIDENTIFIED_VOTES") {
    throw new Error("--export-policy must be aggregates-only or deidentified-votes");
  }
  return policy;
}

function protocolValue(args: CliArgs): StealthEndpointProtocol {
  const protocol = option(args, "--protocol") ?? "openai-compatible";
  if (
    protocol !== "openai-compatible" &&
    protocol !== "openrouter" &&
    protocol !== "anthropic" &&
    protocol !== "gemini"
  ) {
    throw new Error("--protocol must be openai-compatible, openrouter, anthropic, or gemini");
  }
  return protocol;
}

function endpointApiKey(): string {
  const apiKey = process.env.STEALTH_ENDPOINT_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing STEALTH_ENDPOINT_API_KEY");
  return apiKey;
}

async function findSupabaseAuthUserIdByEmail(email: string): Promise<string | null> {
  const { createSupabaseAdminClient } = await import("../lib/supabase/admin");
  const supabase = createSupabaseAdminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (found) return found.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function organizationBySlug(slug: string): Promise<{ id: string; slug: string; name: string }> {
  const organization = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true },
  });
  if (!organization) throw new Error(`Organization not found: ${slug}`);
  return organization;
}

async function evaluationId(args: CliArgs, organizationId: string): Promise<string> {
  const explicitId = option(args, "--evaluation-id", "--experiment-id");
  if (explicitId) {
    const evaluation = await prisma.stealthExperiment.findFirst({
      where: { id: explicitId, organizationId },
      select: { id: true },
    });
    if (!evaluation) throw new Error(`Evaluation not found: ${explicitId}`);
    return evaluation.id;
  }
  const slug = normalizeSlug(
    requiredOption(args, "--evaluation", "--experiment"),
    "--evaluation",
  );
  const evaluation = await prisma.stealthExperiment.findFirst({
    where: { slug, organizationId },
    select: { id: true },
  });
  if (!evaluation) throw new Error(`Evaluation not found: ${slug}`);
  return evaluation.id;
}

async function variantId(
  args: CliArgs,
  organizationId: string,
  experimentId: string,
): Promise<string> {
  const explicitId = option(args, "--variant-id", "--checkpoint-id");
  if (explicitId) {
    const variant = await prisma.stealthVariant.findFirst({
      where: { id: explicitId, experiment: { id: experimentId, organizationId } },
      select: { id: true },
    });
    if (!variant) throw new Error(`Checkpoint not found: ${explicitId}`);
    return variant.id;
  }
  const codename = requiredOption(args, "--codename", "--checkpoint");
  const variant = await prisma.stealthVariant.findFirst({
    where: { codename, experiment: { id: experimentId, organizationId } },
    select: { id: true },
  });
  if (!variant) throw new Error(`Checkpoint not found: ${codename}`);
  return variant.id;
}

async function orgAndEvaluation(args: CliArgs): Promise<{
  organization: { id: string; slug: string; name: string };
  evaluationId: string;
}> {
  const organization = await organizationBySlug(
    normalizeSlug(requiredOption(args, "--org"), "--org"),
  );
  return {
    organization,
    evaluationId: await evaluationId(args, organization.id),
  };
}

function endpointConfig(args: CliArgs): StealthEndpointConfig {
  const protocol = protocolValue(args);
  return {
    protocol,
    endpointUrl: option(args, "--endpoint", "--endpoint-url") ?? "",
    apiKey: endpointApiKey(),
    modelId: requiredOption(args, "--model-id"),
    maxOutputTokens: positiveInt(args, ["--max-output-tokens"], null, 1_000_000) ?? undefined,
    requireStructuredOutput: !args.flags.has("--allow-unstructured"),
    enableTools: !args.flags.has("--no-tools"),
    reasoning: option(args, "--reasoning"),
  };
}

function uploadBuildsFromJson(value: unknown): Array<{
  promptSlug: string;
  build: unknown;
  generationTimeMs?: number | null;
}> {
  const rows =
    Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { builds?: unknown }).builds)
        ? (value as { builds: unknown[] }).builds
        : null;
  if (!rows) throw new Error("Upload file must contain a cohort array or an object with builds");
  return rows.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Each upload row must be an object");
    const row = entry as Record<string, unknown>;
    return {
      promptSlug: typeof row.promptSlug === "string" ? row.promptSlug : "",
      build: row.build,
      generationTimeMs:
        typeof row.generationTimeMs === "number" ? row.generationTimeMs : undefined,
    };
  });
}

async function bootstrapAdmin(args: CliArgs): Promise<void> {
  const email = normalizeEmail(requiredOption(args, "--email"));
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  const userId = existing?.id ?? await findSupabaseAuthUserIdByEmail(email);
  if (!userId) {
    throw new Error(`No MineBench auth user found for ${email}`);
  }
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, email, isMineBenchAdmin: true },
    update: { email, isMineBenchAdmin: true },
  });
  console.log(`MineBench admin enabled: ${email}`);
}

async function provisionOrganization(args: CliArgs): Promise<void> {
  const result = await (await service()).provisionStealthOrganization(OPERATOR_ACTOR, {
    slug: normalizeSlug(requiredOption(args, "--org", "--slug"), "--org"),
    name: requiredOption(args, "--name", "--org-name"),
    initialAdminEmail: normalizeEmail(requiredOption(args, "--admin-email")),
  });
  console.log(`Organization provisioned: ${result.slug} (${result.id})`);
}

async function listOrganizations(): Promise<void> {
  const organizations = await (await service()).listStealthOrganizationsForAdmin(OPERATOR_ACTOR);
  if (organizations.length === 0) {
    console.log("No private evaluation organizations");
    return;
  }
  for (const organization of organizations) {
    console.log(
      [
        organization.slug,
        organization.name,
        `members=${organization.memberCount}`,
        `evaluations=${organization.evaluationCount}`,
        organization.adminEmails.length > 0
          ? `admins=${organization.adminEmails.join(",")}`
          : "admins=none",
      ].join(" "),
    );
  }
}

async function createEvaluation(args: CliArgs): Promise<void> {
  const organization = await organizationBySlug(
    normalizeSlug(requiredOption(args, "--org"), "--org"),
  );
  const result = await (await service()).createStealthEvaluation(
    OPERATOR_ACTOR,
    organization.id,
    {
      name: requiredOption(args, "--name", "--evaluation-name", "--experiment-name"),
      slug: option(args, "--slug", "--evaluation", "--experiment"),
      targetDecisiveVotes: positiveInt(args, ["--target-votes"], null, 1_000_000),
      pauseAtGoal: !args.flags.has("--no-pause-at-goal"),
      exportPolicy: exportPolicyValue(args),
      retentionDays: positiveInt(args, ["--retention-days"], null, 3650) ?? undefined,
      agreementReference: option(args, "--agreement"),
    },
  );
  console.log(`Evaluation created: ${organization.slug}/${result.slug} (${result.id})`);
}

async function configureEndpoint(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  const result = await (await service()).configureStealthEndpoint(
    OPERATOR_ACTOR,
    organization.id,
    experimentId,
    {
      variantId: option(args, "--variant-id", "--checkpoint-id"),
      codename: requiredOption(args, "--codename", "--checkpoint"),
      config: endpointConfig(args),
    },
  );
  console.log(`Checkpoint configured: ${result.variantId}`);
}

async function inviteMember(args: CliArgs): Promise<void> {
  const organization = await organizationBySlug(
    normalizeSlug(requiredOption(args, "--org"), "--org"),
  );
  const email = normalizeEmail(requiredOption(args, "--email"));
  await (await service()).inviteOrganizationMember(OPERATOR_ACTOR, organization.id, {
    email,
    role: roleValue(args),
  });
  console.log(`Member invited: ${email} -> ${organization.slug}`);
}

async function updateMemberRole(args: CliArgs): Promise<void> {
  const organization = await organizationBySlug(
    normalizeSlug(requiredOption(args, "--org"), "--org"),
  );
  const email = normalizeEmail(requiredOption(args, "--email"));
  await (await service()).updateOrganizationMember(OPERATOR_ACTOR, organization.id, {
    email,
    role: roleValue(args),
  });
  console.log(`Member role updated: ${email} -> ${organization.slug}`);
}

async function revokeMember(args: CliArgs): Promise<void> {
  const organization = await organizationBySlug(
    normalizeSlug(requiredOption(args, "--org"), "--org"),
  );
  const email = normalizeEmail(requiredOption(args, "--email"));
  await (await service()).removeOrganizationMember(OPERATOR_ACTOR, organization.id, { email });
  console.log(`Member revoked: ${email} -> ${organization.slug}`);
}

async function uploadCohort(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  const file = requiredOption(args, "--file");
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = await (await service()).completeUploadedStealthCohort(
    OPERATOR_ACTOR,
    organization.id,
    experimentId,
    {
      variantId: option(args, "--variant-id", "--checkpoint-id"),
      codename: requiredOption(args, "--codename", "--checkpoint"),
      builds: uploadBuildsFromJson(parsed),
    },
  );
  console.log(`Uploaded cohort accepted: variant=${result.variantId} run=${result.runId}`);
}

async function startGeneration(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  const checkpointId = await variantId(args, organization.id, experimentId);
  const { runId, workflowRunId } = await (await generationRun()).startStealthGeneration(
    OPERATOR_ACTOR,
    organization.id,
    checkpointId,
    {
      maxAttempts: positiveInt(args, ["--attempts"], 3, 10) ?? 3,
      concurrency: positiveInt(args, ["--concurrency"], 1, 4) ?? 1,
    },
    async (applicationRunId) => {
      const { start } = await workflow();
      return (await start(STEALTH_GENERATION_WORKFLOW, [applicationRunId])).runId;
    },
  );
  console.log(`Generation started: run=${runId} workflow=${workflowRunId}`);
}

async function activateEvaluation(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  await (await service()).activateStealthEvaluation(OPERATOR_ACTOR, organization.id, experimentId);
  console.log("Evaluation active");
}

async function pauseEvaluation(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  await (await service()).pauseStealthEvaluation(OPERATOR_ACTOR, organization.id, experimentId);
  console.log("Evaluation paused");
}

async function resumeEvaluation(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  await (await service()).resumeStealthEvaluation(OPERATOR_ACTOR, organization.id, experimentId);
  console.log("Evaluation active");
}

async function closeEvaluation(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  await (await service()).closeStealthEvaluation(
    OPERATOR_ACTOR,
    organization.id,
    experimentId,
    {
      retentionDays: positiveInt(args, ["--retention-days"], null, 3650) ?? undefined,
    },
  );
  console.log("Evaluation closed");
}

async function deleteDraftEvaluation(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  await (await service()).deleteUnusedDraftEvaluation(
    OPERATOR_ACTOR,
    organization.id,
    experimentId,
  );
  console.log("Unused draft deleted");
}

async function disableEndpoint(args: CliArgs): Promise<void> {
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  const checkpointId = await variantId(args, organization.id, experimentId);
  await (await service()).disableStealthEndpoint(OPERATOR_ACTOR, organization.id, checkpointId);
  console.log("Endpoint credential disabled");
}

async function printStatus(args: CliArgs): Promise<void> {
  const orgSlug = option(args, "--org");
  if (!orgSlug) {
    await listOrganizations();
    return;
  }
  const organization = await organizationBySlug(normalizeSlug(orgSlug, "--org"));
  const evaluationRef = option(args, "--evaluation", "--experiment", "--evaluation-id", "--experiment-id");
  if (!evaluationRef) {
    const workspaces = await (await service()).listStealthEvaluationWorkspaces(
      OPERATOR_ACTOR,
      organization.id,
    );
    if (workspaces.length === 0) {
      console.log(`No evaluations: ${organization.slug}`);
      return;
    }
    for (const workspace of workspaces) {
      console.log(
        [
          workspace.slug,
          workspace.name,
          `status=${workspace.status.toLowerCase()}`,
          `checkpoints=${workspace.checkpointCount}`,
          `builds=${workspace.buildProgress.completed}/${workspace.buildProgress.expected}`,
          `votes=${workspace.voteProgress.decisiveVotes}/${workspace.voteProgress.targetDecisiveVotes ?? "none"}`,
        ].join(" "),
      );
    }
    return;
  }
  const experimentId = await evaluationId(args, organization.id);
  const workspace = await (await service()).getStealthEvaluationWorkspace(
    OPERATOR_ACTOR,
    organization.id,
    experimentId,
  );
  if (!workspace) throw new Error("Evaluation not found");
  console.log(`${workspace.organization.slug}/${workspace.slug} ${workspace.name}`);
  console.log(
    [
      `status=${workspace.status.toLowerCase()}`,
      `export=${workspace.exportPolicy.toLowerCase()}`,
      `retention_days=${workspace.retentionDays}`,
      `delete_at=${workspace.retentionDeleteAt?.toISOString() ?? "n/a"}`,
    ].join(" "),
  );
  for (const checkpoint of workspace.checkpoints) {
    const run = checkpoint.latestGenerationRun;
    console.log(
      [
        checkpoint.codename,
        `source=${checkpoint.source.toLowerCase()}`,
        `status=${checkpoint.status.toLowerCase()}`,
        `endpoint=${checkpoint.endpointEnabled ? "enabled" : "disabled"}`,
        `credential=${checkpoint.credentialConfigured ? "present" : "absent"}`,
        `builds=${checkpoint.generatedBuildCount}/${checkpoint.expectedBuildCount}`,
        `votes=${checkpoint.decisiveVotes}`,
        run ? `run=${run.status.toLowerCase()}:${run.completedBuildCount}/${run.expectedBuildCount}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    );
  }
}

async function purgeDueEvaluations(args: CliArgs): Promise<void> {
  const result = await (await service()).purgeDueStealthEvaluations(OPERATOR_ACTOR, {
    limit: positiveInt(args, ["--limit"], 25, 100) ?? 25,
  });
  console.log(`Purged ${result.purged} evaluation(s)`);
  for (const id of result.evaluationIds) console.log(id);
}

async function recordReleaseMapping(args: CliArgs): Promise<void> {
  if (!args.flags.has("--attest-exact-checkpoint")) {
    throw new Error("Release mapping requires --attest-exact-checkpoint");
  }
  const { organization, evaluationId: experimentId } = await orgAndEvaluation(args);
  const checkpointId = await variantId(args, organization.id, experimentId);
  const codename = requiredOption(args, "--codename", "--checkpoint");
  const result = await (await service()).recordStealthReleaseMapping(
    OPERATOR_ACTOR,
    organization.id,
    {
      variantId: checkpointId,
      checkpointCodename: codename,
      publicModelKey: requiredOption(args, "--public-model", "--public-model-key"),
    },
  );
  console.log(
    `Release mapping recorded: variant=${result.variantId} public_model=${result.releasedModelId} released_at=${result.releasedAt.toISOString()}`,
  );
}

function printHelp(): void {
  console.log(`MineBench private evaluation operator

Commands:
  keygen
  bootstrap-admin --email EMAIL
  provision-org --org SLUG --name NAME --admin-email EMAIL
  list-orgs
  create --org SLUG --name NAME [--slug SLUG] [--target-votes N] [--no-pause-at-goal] [--export-policy aggregates-only|deidentified-votes] [--retention-days N] [--agreement REF]
  configure --org SLUG --evaluation SLUG --codename NAME --protocol openai-compatible|openrouter|anthropic|gemini --model-id ID [--endpoint URL] [--max-output-tokens N] [--reasoning MODE] [--no-tools] [--allow-unstructured]
  invite --org SLUG --email EMAIL --role admin|member
  member-role --org SLUG --email EMAIL --role admin|member
  revoke --org SLUG --email EMAIL
  upload --org SLUG --evaluation SLUG --codename NAME --file cohort.json
  generate --org SLUG --evaluation SLUG --codename NAME [--attempts N] [--concurrency N]
  activate --org SLUG --evaluation SLUG
  pause --org SLUG --evaluation SLUG
  resume --org SLUG --evaluation SLUG
  close --org SLUG --evaluation SLUG [--retention-days N]
  delete --org SLUG --evaluation SLUG
  disable --org SLUG --evaluation SLUG --codename NAME
  status [--org SLUG [--evaluation SLUG]]
  purge [--limit N]
  release-map --org SLUG --evaluation SLUG --codename NAME --public-model KEY --attest-exact-checkpoint

Aliases:
  --experiment may be used in place of --evaluation.
  --variant-id or --checkpoint-id may be used instead of --codename where applicable.
  release maps to release-map, and disable-endpoint maps to disable.

Configure reads checkpoint credentials from STEALTH_ENDPOINT_API_KEY.
CLI mutations run as the MineBench operator service actor and never impersonate organization members.`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "keygen":
      console.log(generateStealthConfigEncryptionKey());
      return;
    case "bootstrap-admin":
      await bootstrapAdmin(args);
      return;
    case "provision":
    case "provision-org":
      await provisionOrganization(args);
      return;
    case "list-orgs":
      await listOrganizations();
      return;
    case "create":
      await createEvaluation(args);
      return;
    case "configure":
      await configureEndpoint(args);
      return;
    case "invite":
      await inviteMember(args);
      return;
    case "member-role":
      await updateMemberRole(args);
      return;
    case "revoke":
      await revokeMember(args);
      return;
    case "upload":
      await uploadCohort(args);
      return;
    case "generate":
      await startGeneration(args);
      return;
    case "activate":
      await activateEvaluation(args);
      return;
    case "pause":
      await pauseEvaluation(args);
      return;
    case "resume":
      await resumeEvaluation(args);
      return;
    case "close":
      await closeEvaluation(args);
      return;
    case "delete":
      await deleteDraftEvaluation(args);
      return;
    case "disable":
    case "disable-endpoint":
      await disableEndpoint(args);
      return;
    case "status":
      await printStatus(args);
      return;
    case "purge":
      await purgeDueEvaluations(args);
      return;
    case "release":
    case "release-map":
      await recordReleaseMapping(args);
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
