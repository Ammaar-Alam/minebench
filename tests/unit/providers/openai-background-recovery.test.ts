import assert from "node:assert/strict";
import { generateVoxelBuild, type GenerateVoxelBuildParams } from "../../../lib/ai/generateVoxelBuild";

const previousPoll = process.env.OPENAI_BACKGROUND_POLL_MS;
const previousBackground = process.env.OPENAI_USE_BACKGROUND_MODE;
const originalFetch = globalThis.fetch;
const responseId = "resp_saved_background_generation";
const text = JSON.stringify({ tool: "voxel.exec", input: {
  code: "box(0, 0, 0, 15, 7, 15, 'stone');", gridSize: 64, palette: "simple",
} });
const requests: string[] = [];
const options: GenerateVoxelBuildParams & {
  openaiResponseId?: string;
  onOpenAIResponseCreated?: (id: string) => Promise<void>;
} = {
  modelKey: "openai_gpt_6_astra", prompt: "A stone cube", gridSize: 64, palette: "simple",
  providerKeys: { openai: "unit-background-recovery-key" }, allowServerKeys: false, maxAttempts: 3,
};

async function main() {
  process.env.OPENAI_BACKGROUND_POLL_MS = "0";
  process.env.OPENAI_USE_BACKGROUND_MODE = "1";
  let checkpointed = false;
  let checkpointedBeforePoll = false;
  let status = "completed";
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${input}`);
    if (method === "POST") return Response.json({ id: responseId, status: "queued" });
    checkpointedBeforePoll = checkpointed;
    return Response.json({ id: responseId, status, output_text: text });
  };
  options.onOpenAIResponseCreated = async (id) => {
    assert.equal(id, responseId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    checkpointed = true;
  };
  const fresh = await generateVoxelBuild(options);
  assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
  assert.equal(checkpointedBeforePoll, true, "persist the response ID before polling");
  assert.deepEqual(requests.map((request) => request.split(" ")[0]), ["POST", "GET"]);

  requests.length = 0;
  options.openaiResponseId = responseId;
  options.onOpenAIResponseCreated = async () => { throw new Error("resume must reuse the saved checkpoint"); };
  const resumed = await generateVoxelBuild(options);
  assert.ok(resumed.ok, resumed.ok ? "" : resumed.error);
  assert.deepEqual(resumed.ok && resumed.build, fresh.ok && fresh.build);
  assert.deepEqual(requests, [`GET https://api.openai.com/v1/responses/${responseId}`]);

  requests.length = 0;
  status = "failed";
  const failed = await generateVoxelBuild(options);
  assert.equal(failed.ok, false);
  assert.deepEqual(requests, [`GET https://api.openai.com/v1/responses/${responseId}`], "failed recovery must not buy a replacement");

  requests.length = 0;
  options.openaiResponseId = "../another-response";
  const invalid = await generateVoxelBuild(options);
  assert.equal(invalid.ok, false);
  assert.equal(requests.length, 0);

  requests.length = 0;
  delete options.openaiResponseId;
  const checkpointFailure = await generateVoxelBuild(options);
  assert.equal(checkpointFailure.ok, false);
  assert.deepEqual(requests, ["POST https://api.openai.com/v1/responses"], "checkpoint failure must stop paid retries");
  console.log("OpenAI background response recovery checks passed");
}

void main().finally(() => {
  globalThis.fetch = originalFetch;
  if (previousPoll === undefined) delete process.env.OPENAI_BACKGROUND_POLL_MS;
  else process.env.OPENAI_BACKGROUND_POLL_MS = previousPoll;
  if (previousBackground === undefined) delete process.env.OPENAI_USE_BACKGROUND_MODE;
  else process.env.OPENAI_USE_BACKGROUND_MODE = previousBackground;
}).catch((error) => { console.error(error); process.exitCode = 1; });
