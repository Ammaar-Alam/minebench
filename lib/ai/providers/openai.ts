type OpenAIChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenAIResponsesResponse = {
  output_text?: unknown;
  output?: unknown;
};

function extractTextFromChatCompletions(data: OpenAIChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "")).join("");
  }
  return "";
}

function extractTextFromResponses(data: OpenAIResponsesResponse): string {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";

  let text = "";
  for (const item of data.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const t = (part as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}

export async function openaiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<{ text: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const temperature = params.temperature ?? 0.2;
  const maxOutputTokens = params.maxOutputTokens ?? 8192;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    // Prefer the Responses API (works with modern OpenAI models).
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: params.modelId,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: params.system }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: params.user }],
          },
        ],
        temperature,
        max_output_tokens: maxOutputTokens,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as OpenAIResponsesResponse;
      const text = extractTextFromResponses(data);
      if (text) return { text };
    } else {
      const body = await res.text().catch(() => "");
      // Fall back for environments/models that still require chat/completions.
      if (res.status !== 404 && res.status !== 400) {
        throw new Error(`OpenAI error ${res.status}: ${body}`);
      }
    }
  } catch (err) {
    // If Responses fails (unsupported endpoint/model), try chat/completions below.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OpenAI request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.modelId,
      temperature,
      max_completion_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as OpenAIChatResponse;
  const text = extractTextFromChatCompletions(data);
  return { text };
}
