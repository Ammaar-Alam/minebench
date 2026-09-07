import {
  decodeAndVerifyCustomBuildArtifactText,
} from "@/lib/custom-builds/artifacts";
import { downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import {
  isVoxelWorldRegionPageKey,
} from "@/lib/custom-builds/worldArtifacts";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  toOpaqueVoxelWorldManifest,
  toOpaqueVoxelWorldRegionPage,
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

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

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

  if (parsedPartKey) {
    const manifest = isVoxelWorldRegionPageKey(parsedPartKey) || !args.artifact.sourceBuildSha256
      ? await readManifest()
      : null;
    const sourceSha = args.artifact.sourceBuildSha256 ?? manifest?.source.sha256;
    if (!sourceSha) throw new Error("Voxel world source checksum is missing");
    const part = await args.findPart(sourceSha, parsedPartKey);
    if (!part) return new Response("Artifact not found", { status: 404 });
    const bytes = await downloadCustomBuildArtifactBytes(part);
    if (isVoxelWorldRegionPageKey(parsedPartKey)) {
      if (!manifest) throw new Error("Voxel world manifest is missing");
      const pageRef = manifest.regionPages?.find((page) => page.data.key === parsedPartKey);
      const pageResult = parseVoxelWorldRegionPage(
        JSON.parse(decodeAndVerifyCustomBuildArtifactText({
          bytes,
          encoding: part.encoding,
          storedSha256: part.sha256,
        })),
        {
          allowStoredRefs: true,
          gridSize: manifest.gridSize,
          worldBounds: manifest.bounds,
          pageRef,
        },
      );
      if (!pageResult.ok) throw new Error(pageResult.error);
      return Response.json(toOpaqueVoxelWorldRegionPage(pageResult.value), {
        headers: {
          "Cache-Control": args.cacheControl,
        },
      });
    }
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "Cache-Control": args.cacheControl,
        "Content-Type": hasGzipMagic(bytes) ? part.contentType : "application/octet-stream",
        ...(part.encoding === "gzip" && hasGzipMagic(bytes) ? { "Content-Encoding": "gzip" } : {}),
      },
    });
  }

  const manifest = await readManifest();
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
