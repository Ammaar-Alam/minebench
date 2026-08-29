import { createCustomBuildArtifactSignedUrl, downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { apiServiceError } from "@/lib/gallery/api";
import { rasterizeGalleryPreview } from "@/lib/gallery/preview";
import { GalleryServiceError, getPublicGalleryExampleArtifact } from "@/lib/gallery/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await context.params;
  const kinds = kind === "preview"
    ? (["preview_svg"] as const)
    : kind === "thumbnail"
      ? (["preview_mbv4"] as const)
    : kind === "viewer"
      ? (["viewer_mbf1", "viewer_mbv4"] as const)
      : null;
  if (!kinds) return apiServiceError(new GalleryServiceError("not_found", "Artifact not found."));
  try {
    const artifact = await getPublicGalleryExampleArtifact(id, [...kinds]);
    if (!artifact) throw new GalleryServiceError("not_found", "Artifact not found.");
    if (kind === "preview" && new URL(request.url).searchParams.get("format") === "png") {
      const bytes = await rasterizeGalleryPreview(await downloadCustomBuildArtifactBytes(artifact));
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=3600",
            "Content-Type": "image/png",
          },
        },
      );
    }
    const signedUrl = await createCustomBuildArtifactSignedUrl(artifact);
    if (signedUrl.startsWith("file:")) {
      const bytes = await downloadCustomBuildArtifactBytes(artifact);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        headers: {
          "Cache-Control": "public, max-age=300",
          "Content-Type": artifact.contentType,
          ...(artifact.encoding === "gzip" ? { "Content-Encoding": "gzip" } : {}),
        },
      });
    }
    return Response.redirect(signedUrl, 307);
  } catch (error) {
    return apiServiceError(error);
  }
}
