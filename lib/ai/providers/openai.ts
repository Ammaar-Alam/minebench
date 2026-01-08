type OpenAIChatResponse = {
  choices?: { message?: { content?: string | null } }[];
};

export async function openaiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
}): Promise<{ text: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.modelId,
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
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text };
}
