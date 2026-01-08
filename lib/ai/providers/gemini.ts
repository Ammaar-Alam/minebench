type GeminiGenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

export async function geminiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<{ text: string }> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      params.modelId
    )}:generateContent`
  );
  url.searchParams.set("key", apiKey);

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

    const payloads: object[] = [
      {
        ...basePayload,
        generationConfig: {
          ...(basePayload.generationConfig as object),
          responseMimeType: "application/json",
        },
      },
      basePayload,
    ];

    let lastBody = "";
    for (const payload of payloads) {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      if (res.ok) break;
      lastBody = await res.text().catch(() => "");
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

  const data = (await res.json()) as GeminiGenerateContentResponse;
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text };
}
