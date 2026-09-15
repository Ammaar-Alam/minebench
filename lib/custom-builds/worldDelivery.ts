import {
  decodeAndVerifyCustomBuildArtifactText,
  jsonBytes,
  sha256Hex,
} from "@/lib/custom-builds/artifacts";
import {
  downloadCustomBuildArtifactBytes,
  downloadCustomBuildArtifactStream,
} from "@/lib/custom-builds/storage";
import {
  isVoxelWorldRegionPageKey,
} from "@/lib/custom-builds/worldArtifacts";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  toOpaqueVoxelWorldManifest,
  toOpaqueVoxelWorldRegionPage,
  type VoxelWorldManifest,
  type VoxelWorldRegionPageRef,
} from "@/lib/voxel/world";

type WorldArtifact = {
  bucket: string;
  path: string;
  contentType: string;
  encoding: string;
  sha256: string;
  sourceBuildSha256?: string | null;
};

type FindWorldPart = (sourceBuildSha256: string, partKey: string) => Promise<WorldArtifact | null>;

function assertPartKey(value: string | null): string | null {
  if (value == null) return null;
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return "";
  return key;
}

function partBaseUrl(request: Request): string {
  const url = new URL(request.url);
  url.searchParams.delete("part");
  return `${url.pathname}${url.search}`;
}

async function readJsonArtifact(artifact: WorldArtifact): Promise<unknown> {
  const bytes = await downloadCustomBuildArtifactBytes(artifact);
  const text = decodeAndVerifyCustomBuildArtifactText({
    bytes,
    encoding: artifact.encoding,
    storedSha256: artifact.sha256,
  });
  return JSON.parse(text) as unknown;
}

function streamedBytes(part: WorldArtifact, requestSignal: AbortSignal): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const iterator = downloadCustomBuildArtifactStream({ ...part, signal: controller.signal })[Symbol.asyncIterator]();
  const cleanup = () => {
    requestSignal.removeEventListener("abort", abortFromRequest);
  };
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const next = await iterator.next();
        if (next.done) {
          cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(next.value);
      } catch (error) {
        cleanup();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      if (!controller.signal.aborted) controller.abort(reason);
      await iterator.return?.(undefined);
    },
  }, { highWaterMark: 0 });
}

export async function customBuildWorldViewerResponse(args: {
  request: Request;
  artifact: WorldArtifact;
  buildId: string;
  findPart: FindWorldPart;
  cacheControl: string;
}): Promise<Response> {
  const parsedPartKey = assertPartKey(new URL(args.request.url).searchParams.get("part"));
  if (parsedPartKey === "") return new Response("Artifact not found", { status: 404 });

  const readManifest = async () => {
    const manifestResult = parseVoxelWorldManifest(
      await readJsonArtifact(args.artifact),
      { allowStoredRefs: true },
    );
    if (!manifestResult.ok) throw new Error(manifestResult.error);
    return manifestResult.value;
  };

  const readPageBytes = async (manifest: VoxelWorldManifest, pageRef: VoxelWorldRegionPageRef, part?: WorldArtifact) => {
    const artifact = part ?? await args.findPart(manifest.source.sha256, pageRef.data.key);
    if (!artifact) throw new Error("Voxel world region page is missing");
    const storedBytes = await downloadCustomBuildArtifactBytes(artifact);
    if (storedBytes.byteLength !== pageRef.data.byteSize || artifact.sha256.toLowerCase() !== pageRef.data.sha256?.toLowerCase()) {
      throw new Error("Voxel world region page metadata does not match");
    }
    const page = parseVoxelWorldRegionPage(JSON.parse(decodeAndVerifyCustomBuildArtifactText({
      bytes: storedBytes, encoding: artifact.encoding, storedSha256: artifact.sha256,
    })), { allowStoredRefs: true, gridSize: manifest.gridSize, worldBounds: manifest.bounds, pageRef });
    if (!page.ok) throw new Error(page.error);
    const bytes = jsonBytes(toOpaqueVoxelWorldRegionPage(page.value));
    if (pageRef.delivery && (bytes.byteLength !== pageRef.delivery.byteSize || sha256Hex(bytes) !== pageRef.delivery.sha256.toLowerCase())) {
      throw new Error("Voxel world region page delivery does not match");
    }
    return bytes;
  };

  if (parsedPartKey) {
    const manifest = isVoxelWorldRegionPageKey(parsedPartKey) || !args.artifact.sourceBuildSha256
      ? await readManifest()
      : null;
    const sourceSha = args.artifact.sourceBuildSha256 ?? manifest?.source.sha256;
    if (!sourceSha) throw new Error("Voxel world source checksum is missing");
    const part = await args.findPart(sourceSha, parsedPartKey);
    if (!part) return new Response("Artifact not found", { status: 404 });
    if (isVoxelWorldRegionPageKey(parsedPartKey)) {
      if (!manifest) throw new Error("Voxel world manifest is missing");
      const pageRef = manifest.regionPages?.find((page) => page.data.key === parsedPartKey);
      if (!pageRef) return new Response("Artifact not found", { status: 404 });
      const bytes = await readPageBytes(manifest, pageRef, part);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        headers: { "Cache-Control": args.cacheControl, "Content-Type": "application/json" },
      });
    }
    return new Response(streamedBytes(part, args.request.signal), {
      headers: {
        "Cache-Control": args.cacheControl,
        "Content-Type": part.contentType,
      },
    });
  }

  const manifest = await readManifest();
  // older manifests lack the precomputed identity of the public page representation
  for (const page of manifest.regionPages ?? []) {
    if (page.delivery) continue;
    const bytes = await readPageBytes(manifest, page);
    page.delivery = { byteSize: bytes.byteLength, sha256: sha256Hex(bytes) };
  }
  return Response.json({
    buildId: args.buildId,
    variant: "full",
    checksum: manifest.source.sha256,
    serverValidated: true,
    voxelBuild: {
      version: "1.0",
      blocks: [],
      world: {
        manifest: toOpaqueVoxelWorldManifest(manifest),
        partBaseUrl: partBaseUrl(args.request),
      },
    },
  }, {
    headers: {
      "Cache-Control": args.cacheControl,
    },
  });
}
