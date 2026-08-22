import {
  finishStealthGenerationRun,
  generateStealthPromptForRun,
  prepareStealthCohortPrompts,
} from "@/lib/stealth/service";

async function listStealthPromptSlugs(): Promise<string[]> {
  "use step";
  return (await prepareStealthCohortPrompts()).map((prompt) => prompt.slug);
}

async function generateStealthPrompt(runId: string, promptSlug: string): Promise<void> {
  "use step";
  await generateStealthPromptForRun({ runId, promptSlug });
}
generateStealthPrompt.maxRetries = 0;

async function finishStealthGeneration(runId: string): Promise<void> {
  "use step";
  await finishStealthGenerationRun(runId);
}
finishStealthGeneration.maxRetries = 0;

export async function generateStealthCohortWorkflow(runId: string): Promise<{ runId: string }> {
  "use workflow";
  const promptSlugs = await listStealthPromptSlugs();
  for (const promptSlug of promptSlugs) {
    await generateStealthPrompt(runId, promptSlug);
  }
  await finishStealthGeneration(runId);
  return { runId };
}
