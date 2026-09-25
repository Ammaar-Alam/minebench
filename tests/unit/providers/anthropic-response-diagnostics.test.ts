import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { anthropicGenerateText } from "../../../lib/ai/providers/anthropic";
import { runProviderConfigTest } from "../../helpers/providerConfigHarness";

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const start = frame({
  type: "message_start",
  message: { id: "msg_test", usage: { output_tokens: 1 } },
});
const thinking = frame({ type: "content_block_start", content_block: { type: "thinking" } });
const textDelta = frame({ type: "content_block_delta", delta: { type: "text_delta", text: '{"ok":true}' } });
const stop = frame({ type: "message_stop" });
const refusalDetails = {
  category: "reasoning_extraction",
  explanation: 'Request declined:\n"reasoning" content',
};
const finish = (reason: string, output = 51_850, reasoning = 51_840) => frame({
  type: "message_delta",
  delta: { stop_reason: reason },
  usage: { output_tokens: output, output_tokens_details: { thinking_tokens: reasoning } },
});

runProviderConfigTest("anthropic response diagnostics", { ANTHROPIC_STREAM_RESPONSES: "1" }, async (capture) => {
  let body = "";
  capture.respondWith(() => {
    const bytes = new TextEncoder().encode(body);
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) {
          controller.enqueue(bytes.slice(offset, offset + 7));
        }
        controller.close();
      },
    }), { headers: { "request-id": "req_test", "Content-Type": "text/event-stream" } });
  });
  const traces: string[] = [];
  const generate = (onDelta?: (text: string) => void) => anthropicGenerateText({
    modelId: "claude-opus-5-5",
    apiKey: "test-anthropic-key",
    system: "Return JSON",
    user: "Build a tower",
    maxTokens: 128_000,
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    onTrace: (trace) => traces.push(trace),
    onDelta,
  });

  body = start + thinking + frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  await assert.rejects(generate(), /overloaded_error.*Overloaded.*request_id=req_test.*message_id=msg_test/);

  body = start + thinking + frame({
    type: "message_delta", delta: { stop_reason: "refusal", stop_details: refusalDetails },
  }) + stop;
  assert.equal((await generate()).text, "");
  assert.ok(traces.at(-1)!.includes('refusal_category="reasoning_extraction"'));
  assert.ok(traces.at(-1)!.includes(`refusal_explanation=${JSON.stringify(refusalDetails.explanation)}`));
  assert.equal(traces.at(-1)!.includes("\n"), false);

  body = start + thinking + frame({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private reasoning" } })
    + frame({ type: "content_block_start", content_block: { type: "text", text: '{"label":"' } })
    + frame({ type: "ping" }) + frame({ type: "future_event" })
    + frame({ type: "content_block_delta", delta: { type: "text_delta", text: 'café"}' } })
    + finish("end_turn") + stop;
  const deltas: string[] = [];
  assert.equal((await generate((text) => deltas.push(text))).text, '{"label":"café"}');
  assert.equal(deltas.join(""), '{"label":"café"}');
  assert.ok(traces.some((trace) => /stop_reason=end_turn.*output_tokens=51850.*thinking_tokens=51840.*content_types=thinking\|text/.test(trace)));
  assert.ok(traces.every((trace) => !trace.includes("private reasoning")));

  for (const reason of ["max_tokens", "refusal", "model_context_window_exceeded", "pause_turn"]) {
    body = start + thinking + textDelta + finish(reason, 128_000, 127_990) + stop;
    assert.equal((await generate()).text, '{"ok":true}');
    assert.match(traces.at(-1)!, new RegExp(`stop_reason=${reason}.*output_tokens=128000.*thinking_tokens=127990`));
  }
  body = start + thinking + finish("end_turn", 4181, 4181) + stop;
  assert.equal((await generate()).text, "");
  assert.match(traces.at(-1)!, /no output text.*stop_reason=end_turn.*output_tokens=4181.*thinking_tokens=4181.*text_chars=0/);
  const rawResponses: string[] = [];
  const run = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5_5", providerKeys: { anthropic: "test-anthropic-key" }, maxAttempts: 1,
    prompt: "Build a tower", gridSize: 64, palette: "simple", enableTools: false, allowServerKeys: false,
    onRawResponse: (_attempt, text) => rawResponses.push(text),
    onProviderTrace: (trace) => traces.push(trace),
  });
  assert.equal(run.ok, false);
  assert.deepEqual(rawResponses, [""], "completed empty responses must retain raw-artifact and attempt accounting");
  assert.ok(traces.some((trace) => /no output text.*stop_reason=end_turn.*output_tokens=4181/.test(trace)));

  body = start + textDelta + finish("end_turn");
  await assert.rejects(generate(), /before message_stop.*text_chars=11/);
  body = start + "data: {broken JSON}\n\n" + stop;
  await assert.rejects(generate(), /malformed stream event/);

  body = start + frame({ type: "content_block_start", content_block: { type: "tool_use", input: {} } })
    + frame({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"ok":true}' } })
    + finish("tool_use") + stop;
  assert.equal((await generate()).text, '{"ok":true}');

  capture.respondWith(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(start + thinking)); },
    pull(controller) { controller.error(new Error("stream connection lost")); },
  }), { headers: { "request-id": "req_broken" } }));
  await assert.rejects(generate(), /stream connection lost.*request_id=req_broken.*message_id=msg_test.*message_stop=false/);

  process.env.ANTHROPIC_STREAM_RESPONSES = "0";
  for (const reason of ["end_turn", "max_tokens", "refusal"]) {
    capture.respondWith(() => new Response(JSON.stringify({
      id: "msg_json",
      stop_reason: reason,
      stop_details: reason === "refusal" ? refusalDetails : null,
      usage: { output_tokens: 9243, output_tokens_details: { thinking_tokens: 9243 } },
      content: [{ type: "thinking", thinking: "private reasoning" }],
    }), { headers: { "request-id": "req_json" } }));
    assert.equal((await generate()).text, "");
    assert.match(traces.at(-1)!, new RegExp(`request_id=req_json.*message_id=msg_json.*stop_reason=${reason}.*thinking_tokens=9243`));
    if (reason === "refusal") {
      assert.ok(traces.at(-1)!.includes(`refusal_explanation=${JSON.stringify(refusalDetails.explanation)}`));
    }
  }
  capture.respondWith(() => new Response(JSON.stringify({
    stop_reason: "refusal", stop_details: { category: null, explanation: null }, content: [],
  })));
  assert.equal((await generate()).text, "");
  assert.match(traces.at(-1)!, /refusal_category=null, refusal_explanation=null/);
  capture.respondWith(() => new Response(JSON.stringify({
    stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }],
  })));
  assert.equal((await generate()).text, '{"ok":true}');
  assert.ok(traces.some((trace) => trace.includes("thinking_tokens=unknown")));
  capture.respondWith(() => new Response("null", { headers: { "request-id": "req_invalid" } }));
  await assert.rejects(generate(), /Anthropic invalid response body.*request_id=req_invalid/);
});
