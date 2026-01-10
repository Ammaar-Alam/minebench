import { consumeSseStream } from "@/lib/ai/providers/sse";

type JsonSchema = Record<string, unknown>;

type GeminiGenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

export async function geminiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: JsonSchema;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
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
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let res: Response | null = null;
  try {
    const basePayload = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      generationConfig: {
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxOutputTokens ?? 8192,
      },
    };

    const tokenCandidates = [basePayload.generationConfig.maxOutputTokens, 65536, 32768, 16384, 8192]
      .filter((n) => Number.isFinite(n) && (n as number) > 0)
      .map((n) => Math.floor(n as number));
    const uniqTokens: number[] = [];
    for (const t of tokenCandidates) if (!uniqTokens.includes(t)) uniqTokens.push(t);

    const payloads: object[] = [];
    for (const tok of uniqTokens) {
      payloads.push({
        ...basePayload,
        generationConfig: {
          ...(basePayload.generationConfig as object),
          maxOutputTokens: tok,
          responseMimeType: "application/json",
          responseJsonSchema: params.jsonSchema,
        },
      });
    }
    payloads.push(basePayload);

    let lastBody = "";
    for (const payload of payloads) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (params.onDelta) headers.Accept = "text/event-stream";
      res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      if (res.ok) break;
      lastBody = await res.text().catch(() => "");
      // Retry with smaller token budget if that looks like the issue
      if (res.status === 400 && lastBody.toLowerCase().includes("maxoutputtokens")) continue;
      // Retry once without responseMimeType if it was rejected.
      if (payload === basePayload) break;
    }

    if (!res) throw new Error("Gemini request failed");
    if (!res.ok) {
      const body = lastBody || (await res.text().catch(() => ""));
      throw new Error(`Gemini error ${res.status}: ${body}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Gemini request timed out");
    }
    throw err;
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
  if (params.onDelta) params.onDelta(text);
  return { text };
}
