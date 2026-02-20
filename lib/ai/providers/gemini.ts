import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type JsonSchema = Record<string, unknown>;

type GeminiGenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

type GeminiThinkingConfig = {
  thinkingLevel?: "low" | "high";
  thinkingBudget?: number;
};

function bestThinkingConfigForModel(modelId: string): GeminiThinkingConfig | undefined {
  if (modelId.startsWith("gemini-3")) {
    return { thinkingLevel: "high" };
  }

  if (modelId.startsWith("gemini-2.5-pro")) {
    // Use adaptive/dynamic reasoning budget for 2.5 Pro.
    return { thinkingBudget: -1 };
  }

  return undefined;
}

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

function describeThinkingConfigLine(thinkingConfig?: GeminiThinkingConfig): string {
  if (thinkingConfig?.thinkingLevel) {
    return `Gemini thinking level in use: '${thinkingConfig.thinkingLevel}'.`;
  }
  if (typeof thinkingConfig?.thinkingBudget === "number") {
    return `Gemini thinking budget in use: ${thinkingConfig.thinkingBudget}.`;
  }
  return "Gemini thinking config in use: default.";
}

export async function geminiGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: JsonSchema;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");
  if (!params.jsonSchema) throw new Error("Missing jsonSchema for Gemini JSON mode");

  const method = params.onDelta ? "streamGenerateContent" : "generateContent";
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      params.modelId
    )}:${method}`
  );
  url.searchParams.set("key", apiKey);
  if (params.onDelta) url.searchParams.set("alt", "sse");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800_000);
  let res: Response | null = null;
  try {
    const thinkingConfig = bestThinkingConfigForModel(params.modelId);
    const thinkingConfigLine = describeThinkingConfigLine(thinkingConfig);
    const basePayload = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      generationConfig: {
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxOutputTokens ?? 8192,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    };

    const uniqTokens = tokenBudgetCandidates(basePayload.generationConfig.maxOutputTokens);
    let successBudget = basePayload.generationConfig.maxOutputTokens;
    let lastBody = "";
    for (const tok of uniqTokens) {
      const payload = {
        ...basePayload,
        generationConfig: {
          ...(basePayload.generationConfig as object),
          maxOutputTokens: tok,
          responseMimeType: "application/json",
          responseJsonSchema: params.jsonSchema,
        },
      };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (params.onDelta) headers.Accept = "text/event-stream";
      res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        successBudget = tok;
        break;
      }
      lastBody = await res.text().catch(() => "");
      // Retry with smaller token budget if that looks like the issue
      if (res.status === 400 && lastBody.toLowerCase().includes("maxoutputtokens")) continue;
    }

    if (!res || !res.ok) {
      const fallbackPayload = { ...basePayload };
      const fallbackRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(fallbackPayload),
      });
      if (fallbackRes.ok) {
        res = fallbackRes;
      } else {
        lastBody = (await fallbackRes.text().catch(() => ""));
        res = fallbackRes;
      }
    }

    if (!res) throw new Error("Gemini request failed");
    if (!res.ok) {
      const body = lastBody || (await res.text().catch(() => ""));
      throw new Error(`Gemini error ${res.status}: ${body}`);
    }

    const budget = successBudget ?? basePayload.generationConfig.maxOutputTokens;
    params.onTrace?.(withMaxOutputTokens(thinkingConfigLine, budget));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Gemini request timed out");
    }
    console.error("Gemini network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res) throw new Error("Gemini request failed");

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: GeminiGenerateContentResponse | null = null;
      try {
        parsed = JSON.parse(evt.data) as GeminiGenerateContentResponse;
      } catch {
        return;
      }
      const chunk =
        parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!chunk) return;
      const delta = chunk.startsWith(text) ? chunk.slice(text.length) : chunk;
      if (!delta) return;
      text += delta;
      params.onDelta?.(delta);
    });
    return { text };
  }

  const data = (await res.json()) as GeminiGenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text };
}
