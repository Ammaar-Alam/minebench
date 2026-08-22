import {
  failStealthGenerationRun,
  finishStealthGenerationRun,
  generateStealthPromptForRun,
  getStealthGenerationPlan,
} from "@/lib/stealth/service";

async function loadStealthGenerationPlan(runId: string) {
  "use step";
  return getStealthGenerationPlan(runId);
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

async function failStealthGeneration(runId: string, message: string): Promise<void> {
  "use step";
  await failStealthGenerationRun(runId, message);
}

export async function generateStealthCohortWorkflow(runId: string): Promise<{ runId: string }> {
  "use workflow";
  try {
    const plan = await loadStealthGenerationPlan(runId);
    if (!plan) return { runId };
    for (let index = 0; index < plan.promptSlugs.length; index += plan.concurrency) {
      const outcomes = await Promise.allSettled(
        plan.promptSlugs
          .slice(index, index + plan.concurrency)
          .map((promptSlug) => generateStealthPrompt(runId, promptSlug)),
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    await finishStealthGeneration(runId);
    return { runId };
  } catch (error) {
    await failStealthGeneration(
      runId,
      error instanceof Error && error.message ? error.message : "Generation workflow failed",
    );
    throw error;
  }
}
