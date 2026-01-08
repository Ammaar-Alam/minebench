type AnthropicMessageResponse = {
  content?: { type?: string; text?: string }[];
};

export async function anthropicGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<{ text: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.modelId,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
    }),
  });

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
