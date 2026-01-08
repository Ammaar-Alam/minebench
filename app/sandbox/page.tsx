import { Sandbox } from "@/components/sandbox/Sandbox";

export default async function SandboxPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = (await searchParams) ?? {};
  const promptParam = sp.prompt;
  const prompt = typeof promptParam === "string" ? promptParam : undefined;
  return <Sandbox initialPrompt={prompt} />;
}
