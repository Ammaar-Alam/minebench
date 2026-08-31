#!/usr/bin/env -S tsx

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  setGalleryCandidateSelected,
  submitGalleryCandidate,
} from "../lib/gallery/service";
import { prisma } from "../lib/prisma";
import { galleryDatabaseTarget, loadMineBenchGalleryPublisher } from "./gallery-cli";
import { BENCHMARK_PROMPT_MAP } from "./uploadsCatalog";

export type GalleryOfficialSeedArgs = { help: false; confirmed: boolean } | { help: true };

export function parseGalleryOfficialSeedArgs(argv: string[]): GalleryOfficialSeedArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 1) throw new Error("Use --help by itself.");
    return { help: true };
  }
  let confirmed = false;
  for (const arg of argv) {
    if (arg !== "--yes") throw new Error(`Unknown argument: ${arg}`);
    if (confirmed) throw new Error("Pass --yes once.");
    confirmed = true;
  }
  return { help: false, confirmed };
}

export async function seedGalleryOfficialPrompts(
  publisherId: string,
  promptMap: Readonly<Record<string, string>>,
) {
  const results: Array<{
    slug: string;
    candidateId: string;
    status: "created" | "selected" | "already_official";
  }> = [];
  for (const [slug, promptText] of Object.entries(promptMap)) {
    const submission = await submitGalleryCandidate(publisherId, {
      prompt: promptText,
      postAnonymously: false,
    });
    if (submission.candidate.prompt !== promptText) {
      throw new Error(`${slug}: Existing Gallery candidate does not exactly match the official prompt.`);
    }
    const status = submission.candidate.selected
      ? "already_official" as const
      : submission.created
        ? "created" as const
        : "selected" as const;
    await setGalleryCandidateSelected(publisherId, submission.candidate.id, true);
    results.push({ slug, candidateId: submission.candidate.id, status });
  }
  return results;
}

function printHelp(): void {
  console.log(`
Seed every canonical benchmark prompt into the official Gallery.

Usage:
  pnpm gallery:seed-official
  pnpm gallery:seed-official --yes

Without --yes, the command validates and prints the seed plan without writing.
Re-running adds new registry prompts and leaves existing official prompts unchanged.
Prompts removed from the registry are not unselected.
`);
}

async function main(): Promise<void> {
  const parsed = parseGalleryOfficialSeedArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  const publisher = await loadMineBenchGalleryPublisher();
  const promptEntries = Object.entries(BENCHMARK_PROMPT_MAP);
  console.log(`Official Gallery seed: ${promptEntries.length} prompts`);
  console.log(`- publisher: ${publisher.publicNickname}`);
  console.log(`- database: ${galleryDatabaseTarget()}`);
  console.log(`- prompts: ${promptEntries.map(([slug]) => slug).join(", ")}`);

  if (!parsed.confirmed) {
    console.log("\nValidated only. Add --yes to seed official prompts.");
    return;
  }

  const results = await seedGalleryOfficialPrompts(publisher.id, BENCHMARK_PROMPT_MAP);
  for (const result of results) {
    console.log(`- ${result.slug}: ${result.status.replaceAll("_", " ")}`);
  }
  const count = (status: (typeof results)[number]["status"]) =>
    results.filter((result) => result.status === status).length;
  console.log(
    `\nSeeded ${results.length} official prompts: ${count("created")} created, ${count("selected")} selected, ${count("already_official")} already official.`,
  );
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main()
    .finally(() => prisma.$disconnect())
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
