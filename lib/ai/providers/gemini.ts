type GeminiGenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

export async function geminiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  temperature: number;
}): Promise<{ text: string }> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      params.modelId
    )}:generateContent`
  );
  url.searchParams.set("key", apiKey);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      generationConfig: { temperature: params.temperature },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as GeminiGenerateContentResponse;
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text };
}

