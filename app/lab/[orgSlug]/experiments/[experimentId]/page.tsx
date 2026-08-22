import { redirect } from "next/navigation";

export default async function EvaluationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  redirect(`/lab/${orgSlug}/experiments/${experimentId}/overview`);
}
