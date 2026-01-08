type AnthropicMessageResponse = {
  content?: { type?: string; text?: string }[];
};

export async function anthropicGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}): Promise<{ text: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: params.modelId,
        max_tokens: params.maxTokens,
        temperature: params.temperature ?? 0.2,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Anthropic request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  const text =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";
  return { text };
}
