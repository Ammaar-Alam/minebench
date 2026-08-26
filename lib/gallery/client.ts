type GallerySubmissionBody = {
  created?: boolean;
  candidate?: { id: string };
  error?: { message?: string };
};

export async function publishGenerationToGallery(
  generationId: string,
  postAnonymously: boolean,
): Promise<string> {
  const response = await fetch("/api/gallery/candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generationId, postAnonymously }),
  });
  const body = await response.json().catch(() => null) as GallerySubmissionBody | null;
  if (!response.ok || !body?.candidate) {
    throw new Error(body?.error?.message ?? "Generation could not be submitted.");
  }
  if (body.created === false) {
    const exampleResponse = await fetch(
      `/api/gallery/candidates/${encodeURIComponent(body.candidate.id)}/examples`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId, postAnonymously }),
      },
    );
    const exampleBody = await exampleResponse.json().catch(() => null) as {
      error?: { message?: string };
    } | null;
    if (!exampleResponse.ok) {
      throw new Error(exampleBody?.error?.message ?? "Example could not be added.");
    }
  }
  return body.candidate.id;
}
