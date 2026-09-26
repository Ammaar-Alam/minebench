import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getBatchGenerationModel, parseArgs } from "../../../scripts/batch-generate";
import { createBenchmarkRunConfiguration } from "../../../scripts/benchmarkMetrics";
import { jsonResponse, runProviderConfigTest } from "../../helpers/providerConfigHarness";

assert.equal(parseArgs([]).taskBudget, undefined);
assert.equal(parseArgs(["--reasoning", "xhigh", "--task_budget", "96000"]).taskBudget, 96_000);
assert.equal(parseArgs(["--task_budget", "20000"]).taskBudget, 20_000);
for (const args of [[], ["--reasoning"], ["0"], ["19999"], ["96000.5"], ["NaN"], ["Infinity"]]) {
  assert.throws(() => parseArgs(["--task_budget", ...args]), /integer of at least 20000/);
}

runProviderConfigTest("batch task budget", {
  ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_STREAM_RESPONSES: "0",
}, async (capture) => {
  capture.respondWith(() => jsonResponse({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ tool: "voxel.exec", input: {
      code: 'box(0, 0, 0, 39, 24, 0, "stone");', gridSize: 64, palette: "simple", seed: 123,
    } }) }],
  }));
  const configurations: string[] = [];
  for (const taskBudget of [undefined, 128_000]) {
    const traces: string[] = [];
    const result = await generateVoxelBuild({
      model: getBatchGenerationModel("anthropic_claude_opus_5_5", false, taskBudget),
      prompt: "A fighter jet", gridSize: 64, palette: "simple", enableTools: true,
      reasoning: "xhigh", maxAttempts: 1,
      providerKeys: { anthropic: "test-anthropic-key" }, allowServerKeys: false,
      onProviderTrace: (trace) => traces.push(trace),
    });
    assert.ok(result.ok, result.ok ? undefined : result.error);
    const request = capture.requests.at(-1)!;
    assert.equal(request.headers["anthropic-beta"], "task-budgets-2026-03-13");
    assert.equal(request.body.model, "claude-opus-5-5");
    assert.equal(request.body.max_tokens, 128_000);
    const output = request.body.output_config as { effort: string; task_budget: unknown; format: { type: string } };
    assert.equal(output.effort, "xhigh");
    assert.deepEqual(output.task_budget, { type: "tokens", total: taskBudget ?? 96_000 });
    assert.equal(output.format.type, "json_schema");
    assert.equal(Object.hasOwn(request.body, "temperature"), false);
    assert.ok(traces.some((trace) => trace.includes(`Anthropic task budget in use: ${JSON.stringify(output.task_budget)}`)));
    const configuration = createBenchmarkRunConfiguration({
      promptText: "A fighter jet", providerRoute: "direct", reasoningOverride: "xhigh", toolsEnabled: true,
      requestConfiguration: result.requestConfiguration, acceptedConfiguration: result.acceptedRequestConfiguration,
    });
    assert.ok(configuration.acceptedConfiguration?.thinkingMode.includes(`task_budget=${JSON.stringify(output.task_budget)}`));
    configurations.push(configuration.requestConfiguration!);
  }
  assert.equal(capture.requests.length, 2);
  assert.notEqual(configurations[0], configurations[1], "different task budgets must have different benchmark fingerprints");

  for (const key of ["anthropic_claude_fable_5_1", "anthropic_claude_fable_5", "anthropic_claude_opus_5", "anthropic_claude_4_8_opus", "anthropic_claude_4_7_opus"] as const) {
    assert.ok(getBatchGenerationModel(key, false).customBody);
  }
  for (const key of ["anthropic_claude_sonnet_5", "anthropic_claude_4_6_opus", "anthropic_claude_4_6_sonnet", "anthropic_claude_4_5_opus"] as const) {
    assert.equal(getBatchGenerationModel(key, false).customBody, undefined);
    assert.throws(() => getBatchGenerationModel(key, false, 96_000), /--task_budget requires/);
  }
  assert.equal(getBatchGenerationModel("openai_gpt_6_sol", false, 96_000).customBody, undefined);
  assert.equal(getBatchGenerationModel("anthropic_claude_opus_5_5", true).customBody, undefined);
  assert.throws(() => getBatchGenerationModel("anthropic_claude_opus_5_5", true, 96_000), /direct Anthropic route/);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(getBatchGenerationModel("anthropic_claude_opus_5_5", false).customBody, undefined);
  assert.throws(() => getBatchGenerationModel("anthropic_claude_opus_5_5", false, 96_000), /ANTHROPIC_API_KEY/);
});
