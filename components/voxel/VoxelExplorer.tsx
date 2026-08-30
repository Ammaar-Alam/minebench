"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { Lensflare, LensflareElement } from "three/examples/jsm/objects/Lensflare.js";
import { BloomPass } from "three/examples/jsm/postprocessing/BloomPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import {
  readBuildVariantPayload,
  readBuildVariantStream,
  type BuildVariantStreamResponse,
} from "@/lib/arena/clientBuildResponse";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";
import { getPalette } from "@/lib/blocks/palettes";
import { VOXEL_VIEWER_WEBGL_ERROR } from "@/lib/voxel/errors";
import { parseExplorerBuildId } from "@/lib/voxel/explorerBuildId";
import {
  EXPLORER_EYE_HEIGHT,
  createExplorerCollisionWorld,
  moveExplorerPlayerAxis,
  setExplorerMoveDirection,
  type ExplorerCollisionWorld,
} from "@/lib/voxel/explorerCollision";
import {
  applyExplorerBlockLighting,
  createExplorerBlockLightGrid,
  getExplorerMeteorOpacity,
  isExplorerSunRayVisible,
  renderExplorerBloomOverlay,
} from "@/lib/voxel/explorerLighting";
import { createVoxelGroupAsync, type VoxelGroup } from "@/lib/voxel/mesh";
import {
  voxelBuildBlockCount,
} from "@/lib/voxel/packedBlocks";
import { createPublicMeshCacheKey } from "@/lib/voxel/meshPayloadCache";
import {
  setExplorerViewBob,
  type ExplorerViewBobTransform,
} from "@/lib/voxel/explorerViewBob";
import type { VoxelExplorerBuild } from "@/components/voxel/VoxelExplorerLauncher";

const WALK_SPEED = 4.3;
const RUN_SPEED = 7.5;
const FLY_SPEED = 14;
const FLY_RUN_SPEED = 28;
const GRAVITY = 36;
const JUMP_VELOCITY = Math.sqrt(GRAVITY * 2 * 1.25);
const MAX_FALL_SPEED = 78.4;
const WATER_SPEED_MULTIPLIER = 0.8;
const WATER_ASCENT_SPEED = 3.5;
const WATER_SINK_SPEED = 1;
const VIEW_BOB_DISTANCE_SCALE = 0.6;
const VIEW_BOB_WALK_AMOUNT = 0.065;
const VIEW_BOB_RUN_AMOUNT = 0.088;
const BLOOM_RENDER_SCALE = 0.25;
const EMISSIVE_LAYER = 1;
const SUN_RAY_LAYER = 2;
const MAX_FRAME_SECONDS = 0.05;
const MAX_PHYSICS_STEP_SECONDS = 1 / 60;
const DAYLIGHT_COLOR = 0xaed4ef;
const SUN_DIRECTION = new THREE.Vector3(-0.46, 0.72, -0.52).normalize();
const MOON_DIRECTION = new THREE.Vector3(0.48, 0.6, -0.64).normalize();
const DAY_SUN_COLOR = new THREE.Color(0xffe2b3);
const NIGHT_MOONLIGHT_COLOR = new THREE.Color(0xa9c8ff);
const DAY_HEMISPHERE_COLOR = new THREE.Color(0xeaf6ff);
const NIGHT_HEMISPHERE_COLOR = new THREE.Color(0x547bb3);
const DAY_GROUND_COLOR = new THREE.Color(0x4d5548);
const NIGHT_GROUND_COLOR = new THREE.Color(0x111b31);
const DAY_AMBIENT_COLOR = new THREE.Color(0xf4f8ff);
const NIGHT_AMBIENT_COLOR = new THREE.Color(0x263c68);
const DAY_FOG_COLOR = new THREE.Color(DAYLIGHT_COLOR);
const NIGHT_FOG_COLOR = new THREE.Color(0x0b1830);
const SUN_FLARE_COLOR = new THREE.Color(0xffdf9f);
const STAR_LAYER_COUNT = 3;
const STARS_PER_LAYER = 560;

let explorerAtlasPromise: Promise<THREE.Texture> | null = null;
let explorerBuildCatalog: ExplorerBuildOption[] | null = null;

type LoadedBuild = Pick<VoxelExplorerBuild, "checksum" | "palette" | "voxelBuild">;
type ExplorerBuildOption = Pick<
  VoxelExplorerBuild,
  "id" | "model" | "prompt" | "blockCount" | "source"
>;

function loadAtlasTexture(): Promise<THREE.Texture> {
  if (explorerAtlasPromise) return explorerAtlasPromise;
  explorerAtlasPromise = new Promise((resolve, reject) => {
    new THREE.TextureLoader().load("/textures/atlas.png", resolve, undefined, reject);
  });
  return explorerAtlasPromise;
}

async function fetchStreamBuild(
  buildId: string,
  signal: AbortSignal,
): Promise<BuildVariantStreamResponse> {
  const url = new URL(
    `/api/arena/builds/${encodeURIComponent(buildId)}/stream`,
    window.location.origin,
  );
  url.searchParams.set("variant", "full");
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(await readClientErrorResponse(response, "Failed to load build"));
  }
  if ((response.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
    return readBuildVariantStream(response, { signal });
  }
  return (
    await readBuildVariantPayload(response, {
      fallbackIdentity: { buildId, variant: "full", checksum: null },
    })
  ).payload;
}

async function fetchExplorerBuild(buildId: string, signal: AbortSignal): Promise<LoadedBuild> {
  const target = parseExplorerBuildId(buildId);
  if (target.source === "gallery") {
    const response = await fetch(
      `/api/gallery/examples/${encodeURIComponent(target.id)}/viewer`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(await readClientErrorResponse(response, "Failed to load build"));
    }
    const payload = (
      await readBuildVariantPayload(response, {
        fallbackIdentity: { buildId, variant: "full", checksum: null },
      })
    ).payload;
    return { checksum: payload.checksum, palette: "advanced", voxelBuild: payload.voxelBuild };
  }

  const url = new URL(
    `/api/arena/builds/${encodeURIComponent(target.id)}`,
    window.location.origin,
  );
  url.searchParams.set("variant", "full");
  url.searchParams.set("format", "mbf1");
  const response = await fetch(url, { signal });
  let payload: BuildVariantStreamResponse;
  if (response.ok) {
    payload = (
      await readBuildVariantPayload(response, {
        fallbackIdentity: { buildId, variant: "full", checksum: null },
      })
    ).payload;
  } else if (response.status === 503) {
    payload = await fetchStreamBuild(target.id, signal);
  } else {
    throw new Error(await readClientErrorResponse(response, "Failed to load build"));
  }
  return { checksum: payload.checksum, palette: "simple", voxelBuild: payload.voxelBuild };
}

async function fetchExplorerBuildCatalog(signal: AbortSignal): Promise<ExplorerBuildOption[]> {
  if (explorerBuildCatalog) return explorerBuildCatalog;
  const response = await fetch("/api/sandbox/explorer-builds", { signal });
  const body = (await response.json()) as {
    builds?: ExplorerBuildOption[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(body.builds)) {
    throw new Error(body.error ?? "Builds unavailable");
  }
  explorerBuildCatalog = body.builds;
  return body.builds;
}

function createSunHaloTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, "rgba(255, 254, 240, 1)");
    gradient.addColorStop(0.16, "rgba(255, 251, 222, 1)");
    gradient.addColorStop(0.2, "rgba(255, 225, 155, 0.95)");
    gradient.addColorStop(0.34, "rgba(255, 196, 99, 0.3)");
    gradient.addColorStop(0.68, "rgba(255, 174, 76, 0.06)");
    gradient.addColorStop(1, "rgba(255, 165, 64, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSkyGradientTexture(
  stops: ReadonlyArray<readonly [number, string]>,
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function createMoonTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    const halo = context.createRadialGradient(256, 256, 118, 256, 256, 256);
    halo.addColorStop(0, "rgba(226,238,255,0.38)");
    halo.addColorStop(0.5, "rgba(154,188,236,0.1)");
    halo.addColorStop(1, "rgba(120,164,224,0)");
    context.fillStyle = halo;
    context.fillRect(0, 0, 512, 512);

    const disc = context.createRadialGradient(214, 204, 24, 256, 256, 132);
    disc.addColorStop(0, "#fffdf0");
    disc.addColorStop(0.68, "#e8eef0");
    disc.addColorStop(1, "#aebed0");
    context.fillStyle = disc;
    context.beginPath();
    context.arc(256, 256, 132, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.beginPath();
    context.arc(256, 256, 130, 0, Math.PI * 2);
    context.clip();
    context.fillStyle = "rgba(83,104,128,0.17)";
    for (const [x, y, radius] of [
      [205, 204, 25], [306, 225, 18], [276, 302, 29], [191, 284, 14], [330, 278, 11],
    ] as const) {
      context.beginPath();
      context.ellipse(x, y, radius, radius * 0.76, -0.25, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function createMeteorTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (context) {
    const streak = context.createLinearGradient(0, 0, 256, 0);
    streak.addColorStop(0, "rgba(119,171,255,0)");
    streak.addColorStop(0.72, "rgba(169,207,255,0.38)");
    streak.addColorStop(0.94, "rgba(240,247,255,0.96)");
    streak.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = streak;
    context.fillRect(0, 10, 256, 12);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function deterministicUnit(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function ExplorerBuildMenu({
  currentBuildId,
  pinnedBuild,
  onClose,
  onSelect,
}: {
  currentBuildId: string;
  pinnedBuild?: ExplorerBuildOption;
  onClose: () => void;
  onSelect: (buildId: string) => void;
}) {
  const [builds, setBuilds] = useState<ExplorerBuildOption[] | null>(explorerBuildCatalog);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (builds) return;
    const controller = new AbortController();
    setError(null);
    void fetchExplorerBuildCatalog(controller.signal).then(
      setBuilds,
      (loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Builds unavailable");
      },
    );
    return () => controller.abort();
  }, [attempt, builds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const availableBuilds = useMemo(() => {
    if (!pinnedBuild || builds?.some((build) => build.id === pinnedBuild.id)) return builds;
    return [pinnedBuild, ...(builds ?? [])];
  }, [builds, pinnedBuild]);

  const filteredBuilds = useMemo(() => {
    if (!availableBuilds) return [];
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return availableBuilds;
    return availableBuilds.filter((build) => {
      const searchable = `${build.source} ${build.model} ${build.prompt}`.toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
  }, [availableBuilds, query]);

  return (
    <aside className="absolute inset-y-3 right-3 flex w-[min(28rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-md border border-white/10 bg-slate-950/90 text-white shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Builds</h2>
          {availableBuilds ? (
            <p className="mt-0.5 text-[11px] text-white/50">
              {filteredBuilds.length === availableBuilds.length
                ? `${availableBuilds.length.toLocaleString()} available`
                : `${filteredBuilds.length.toLocaleString()} matches`}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-10 rounded px-3 text-xs font-medium text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/65 motion-reduce:transition-none"
        >
          Close
        </button>
      </div>

      <div className="border-b border-white/10 p-3">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search builds…"
          aria-label="Search builds"
          className="h-10 w-full rounded border border-white/15 bg-white/[0.08] px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/40 focus:ring-2 focus:ring-white/15"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {!builds && !error ? (
          <p className="px-3 py-8 text-center text-xs text-white/50">Loading</p>
        ) : null}
        {error ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">
            <p className="text-xs text-white/60">{error}</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="min-h-10 rounded bg-white/10 px-4 text-xs font-semibold text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/65"
            >
              Retry
            </button>
          </div>
        ) : null}
        {availableBuilds && filteredBuilds.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-white/50">No matches</p>
        ) : null}
        {filteredBuilds.map((build) => {
          const current = build.id === currentBuildId;
          return (
            <button
              key={build.id}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => current ? onClose() : onSelect(build.id)}
              className={`mb-1 block w-full rounded px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/65 motion-reduce:transition-none ${
                current ? "bg-white/15" : "hover:bg-white/[0.08]"
              }`}
            >
              <span className="flex items-center justify-between gap-3 text-[11px] font-semibold text-white/80">
                <span className="truncate">{build.model}</span>
                <span className="shrink-0 tabular-nums text-white/40">
                  {build.source === "gallery"
                    ? "Gallery · "
                    : build.source === "current"
                      ? "Current · "
                      : ""}
                  {build.blockCount.toLocaleString()} blocks
                </span>
              </span>
              <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-white/55">
                {build.prompt}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

type ExplorerMeteor = {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  start: THREE.Vector3;
  end: THREE.Vector3;
  delay: number;
  duration: number;
};

function configureAtmosphere(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
) {
  scene.background = new THREE.Color(DAYLIGHT_COLOR);
  scene.fog = new THREE.Fog(DAYLIGHT_COLOR, 72, 320);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial({
      map: createSkyGradientTexture([
        [0, "#4f97cb"],
        [0.55, "#78add3"],
        [1, "#bfdbea"],
      ]),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  sky.scale.setScalar(800);
  sky.frustumCulled = false;
  sky.renderOrder = -100;

  const nightSky = new THREE.Mesh(
    sky.geometry,
    new THREE.MeshBasicMaterial({
      map: createSkyGradientTexture([
        [0, "#020513"],
        [0.52, "#07132d"],
        [1, "#172c53"],
      ]),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      transparent: true,
      opacity: 0,
    }),
  );
  nightSky.scale.copy(sky.scale);
  nightSky.frustumCulled = false;
  nightSky.renderOrder = -99;
  nightSky.visible = false;

  const starMaterials: THREE.PointsMaterial[] = [];
  const stars = new THREE.Group();
  const starColors = [
    new THREE.Color(0xffffff),
    new THREE.Color(0xbfd7ff),
    new THREE.Color(0xffe2bf),
  ];
  for (let layer = 0; layer < STAR_LAYER_COUNT; layer += 1) {
    const positions = new Float32Array(STARS_PER_LAYER * 3);
    const colors = new Float32Array(STARS_PER_LAYER * 3);
    for (let star = 0; star < STARS_PER_LAYER; star += 1) {
      const index = layer * STARS_PER_LAYER + star;
      const y = THREE.MathUtils.lerp(-0.18, 1, deterministicUnit(index, 1));
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = deterministicUnit(index, 2) * Math.PI * 2;
      const offset = star * 3;
      positions[offset] = Math.cos(theta) * radius;
      positions[offset + 1] = y;
      positions[offset + 2] = Math.sin(theta) * radius;
      starColors[Math.floor(deterministicUnit(index, 3) * starColors.length)]
        .toArray(colors, offset);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.85 + layer * 0.42,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -80;
    stars.add(points);
    starMaterials.push(material);
  }

  const moonTexture = createMoonTexture();
  const moonMaterial = new THREE.SpriteMaterial({
    map: moonTexture,
    color: 0xe4efff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const moon = new THREE.Sprite(moonMaterial);
  moon.renderOrder = -60;

  const meteorTexture = createMeteorTexture();
  const meteorGroup = new THREE.Group();
  const meteorConfigs = [
    [[-0.72, 0.65, -0.24], [-0.2, 0.32, -0.68], 0, -0.55],
    [[0.02, 0.9, -0.36], [0.48, 0.54, -0.7], 0.42, -0.48],
    [[0.56, 0.72, -0.18], [0.82, 0.38, -0.42], 0.86, -0.62],
  ] as const;
  const meteors: ExplorerMeteor[] = meteorConfigs.map(([start, end, delay, rotation]) => {
    const material = new THREE.SpriteMaterial({
      map: meteorTexture,
      color: 0xcfe4ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      rotation,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.18, 0.012, 1);
    sprite.visible = false;
    sprite.renderOrder = -50;
    meteorGroup.add(sprite);
    return {
      sprite,
      material,
      start: new THREE.Vector3(...start).normalize(),
      end: new THREE.Vector3(...end).normalize(),
      delay,
      duration: 1.15,
    };
  });

  const atmosphereRoot = new THREE.Group();
  atmosphereRoot.add(sky, nightSky, stars, moon, meteorGroup);
  scene.add(atmosphereRoot);

  const hemisphere = new THREE.HemisphereLight(
    DAY_HEMISPHERE_COLOR,
    DAY_GROUND_COLOR,
    0.98,
  );
  const ambient = new THREE.AmbientLight(DAY_AMBIENT_COLOR, 0.14);
  scene.add(hemisphere, ambient);

  const sun = new THREE.DirectionalLight(DAY_SUN_COLOR, 3.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.025;
  sun.shadow.autoUpdate = false;
  scene.add(sun, sun.target);

  const sunFlare = new Lensflare();
  const sunFlareElement = new LensflareElement(
    createSunHaloTexture(),
    440,
    0,
    SUN_FLARE_COLOR,
  );
  sunFlare.addElement(sunFlareElement);
  atmosphereRoot.add(sunFlare);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return {
    root: atmosphereRoot,
    sky,
    nightSky,
    stars,
    starMaterials,
    moon,
    moonMaterial,
    moonTexture,
    meteorGroup,
    meteors,
    meteorTexture,
    hemisphere,
    ambient,
    sun,
    sunFlare,
    sunFlareElement,
  };
}

function frameAtmosphere(
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  atmosphere: ReturnType<typeof configureAtmosphere>,
  bounds: VoxelGroup["bounds"],
  lightDirection: THREE.Vector3,
) {
  const size = bounds.box.getSize(new THREE.Vector3());
  const radius = Math.max(8, bounds.radius);
  const fog = scene.fog as THREE.Fog;
  fog.near = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.35, 48, 96);
  fog.far = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 1.5, 160, 512);
  camera.far = Math.max(1_000, fog.far * 3);
  camera.updateProjectionMatrix();
  atmosphere.sky.scale.setScalar(camera.far * 0.96);
  atmosphere.nightSky.scale.copy(atmosphere.sky.scale);
  atmosphere.stars.scale.setScalar(camera.far * 0.88);
  atmosphere.meteorGroup.scale.setScalar(camera.far * 0.84);

  const lightDistance = Math.max(80, radius * 2.2);
  atmosphere.sun.target.position.copy(bounds.center);
  atmosphere.sun.position.copy(bounds.center).addScaledVector(lightDirection, lightDistance);
  const shadowCamera = atmosphere.sun.shadow.camera;
  const shadowRadius = radius * 1.1;
  shadowCamera.left = -shadowRadius;
  shadowCamera.right = shadowRadius;
  shadowCamera.top = shadowRadius;
  shadowCamera.bottom = -shadowRadius;
  shadowCamera.near = 0.1;
  shadowCamera.far = lightDistance + radius * 2;
  shadowCamera.updateProjectionMatrix();
  atmosphere.sun.target.updateMatrixWorld();
  atmosphere.sun.shadow.needsUpdate = true;
}

function hasKey(keys: Set<string>, left: string, right?: string): boolean {
  return keys.has(left) || Boolean(right && keys.has(right));
}

function ExplorerScene({
  build,
  buildId,
  pinnedBuild,
  onSelectBuild,
  onExit,
}: {
  build: LoadedBuild;
  buildId: string;
  pinnedBuild?: ExplorerBuildOption;
  onSelectBuild: (buildId: string) => void;
  onExit: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const browseButtonRef = useRef<HTMLButtonElement | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [entered, setEntered] = useState(false);
  const [noclip, setNoclip] = useState(true);
  const [night, setNight] = useState(false);
  const [fps, setFps] = useState(0);
  const [loading, setLoading] = useState("Building");
  const [error, setError] = useState<string | null>(null);
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);
  const meshCacheKey = useMemo(
    () =>
      createPublicMeshCacheKey({
        checksum: build.checksum,
        variant: "full",
        palette: build.palette,
        blockCount: voxelBuildBlockCount(build.voxelBuild),
      }),
    [build],
  );

  const enter = useCallback(() => startRef.current?.(), []);
  const closeBuildMenu = useCallback(() => {
    setBuildMenuOpen(false);
    window.requestAnimationFrame(() => browseButtonRef.current?.focus());
  }, []);
  const selectBuild = useCallback((nextBuildId: string) => {
    setBuildMenuOpen(false);
    onSelectBuild(nextBuildId);
  }, [onSelectBuild]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const abortController = new AbortController();
    let disposed = false;
    let voxelGroup: VoxelGroup | null = null;
    let collisionWorld: ExplorerCollisionWorld | null = null;
    let worldReady = false;
    let isNoclip = true;
    let verticalVelocity = 0;
    let grounded = false;
    let bobWalking = false;
    let bobRunning = false;
    let bobDistance = 0;
    let bobBlend = 0;
    let nightTarget = false;
    let nightBlend = 0;
    let moonLightActive = false;
    let atmosphereTime = 0;
    let nightElapsed = 0;
    let nextShowerAt = 10;
    let showerStartedAt = -1;
    let showerCount = 0;
    let sunVisibility = 1;
    const keys = new Set<string>();

    setReady(false);
    setLocked(false);
    setEntered(false);
    setNoclip(true);
    setNight(false);
    setFps(0);
    setLoading("Building");
    setError(null);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1_000);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      setError(VOXEL_VIEWER_WEBGL_ERROR);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight), true);
    mount.appendChild(renderer.domElement);
    const atmosphere = configureAtmosphere(scene, renderer);
    const { sun, sunFlare } = atmosphere;
    const bloomTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    bloomTarget.texture.name = "Explorer.postEffects";
    bloomTarget.texture.generateMipmaps = false;
    const bloomPass = new BloomPass(1, 13, 2);
    const bloomOverlayUniforms = THREE.UniformsUtils.clone(CopyShader.uniforms);
    bloomOverlayUniforms.tDiffuse.value = bloomTarget.texture;
    bloomOverlayUniforms.opacity.value = 0.62;
    const bloomOverlayMaterial = new THREE.ShaderMaterial({
      uniforms: bloomOverlayUniforms,
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const bloomOverlay = new FullScreenQuad(bloomOverlayMaterial);
    const bloomDepthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
    const sunRayTexture = createSunHaloTexture();
    const sunRaySpriteMaterial = new THREE.SpriteMaterial({
      map: sunRayTexture,
      color: 0xffffff,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const sunRaySprite = new THREE.Sprite(sunRaySpriteMaterial);
    sunRaySprite.layers.set(SUN_RAY_LAYER);
    scene.add(sunRaySprite);
    const sunRayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: bloomTarget.texture },
        lightPosition: { value: new THREE.Vector2(0.5, 0.5) },
        rayColor: { value: new THREE.Color(0xffd2a3) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 lightPosition;
        uniform vec3 rayColor;
        varying vec2 vUv;

        void main() {
          vec2 sampleUv = vUv;
          vec2 stepUv = (vUv - lightPosition) * 0.88 / 24.0;
          float illumination = 1.0;
          float rays = 0.0;
          for (int i = 0; i < 24; i++) {
            sampleUv -= stepUv;
            vec3 sampleColor = texture2D(tDiffuse, sampleUv).rgb;
            rays += max(max(sampleColor.r, sampleColor.g), sampleColor.b) * illumination * 0.1;
            illumination *= 0.94;
          }
          gl_FragColor = vec4(rayColor * rays * 0.28, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sunRayOverlay = new FullScreenQuad(sunRayMaterial);
    let hasEmissiveMeshes = false;

    const controls = new PointerLockControls(camera, renderer.domElement);
    controls.pointerSpeed = 0.9;
    const clearKeys = () => keys.clear();
    const onLock = () => {
      clearKeys();
      setLocked(true);
      setEntered(true);
    };
    const onUnlock = () => {
      clearKeys();
      setLocked(false);
    };
    controls.addEventListener("lock", onLock);
    controls.addEventListener("unlock", onUnlock);
    startRef.current = () => {
      if (worldReady && !controls.isLocked) controls.lock();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!controls.isLocked) return;
      if (
        event.code === "KeyW" || event.code === "KeyA" || event.code === "KeyS" ||
        event.code === "KeyD" || event.code === "Space" ||
        event.code === "ShiftLeft" || event.code === "ShiftRight" ||
        event.code === "ControlLeft" || event.code === "ControlRight" ||
        event.code === "KeyF" || event.code === "KeyT"
      ) {
        event.preventDefault();
      }
      keys.add(event.code);
      if (event.code === "KeyF" && !event.repeat) {
        isNoclip = !isNoclip;
        verticalVelocity = 0;
        grounded = false;
        setNoclip(isNoclip);
      }
      if (event.code === "KeyT" && !event.repeat) {
        nightTarget = !nightTarget;
        setNight(nightTarget);
        if (nightTarget) {
          nightElapsed = 0;
          nextShowerAt = 10;
          showerStartedAt = -1;
          showerCount = 0;
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = reducedMotionQuery.matches;
    const onReducedMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
    };
    reducedMotionQuery.addEventListener("change", onReducedMotionChange);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (width <= 0 || height <= 0) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, true);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const bloomWidth = Math.max(1, Math.round(width * pixelRatio * BLOOM_RENDER_SCALE));
      const bloomHeight = Math.max(1, Math.round(height * pixelRatio * BLOOM_RENDER_SCALE));
      bloomTarget.setSize(bloomWidth, bloomHeight);
      bloomPass.setSize(bloomWidth, bloomHeight);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
    const bobUp = new THREE.Vector3();
    const baseQuaternion = new THREE.Quaternion();
    const viewBob: ExplorerViewBobTransform = { x: 0, y: 0, roll: 0, pitch: 0 };
    const bloomClearColor = new THREE.Color();
    const sunRayScreenPosition = new THREE.Vector3();
    const renderPostEffects = (seconds: number) => {
      sunRayScreenPosition.copy(sunRaySprite.position).project(camera);
      const hasSunRays = sunVisibility > 0.01 && isExplorerSunRayVisible(
        sunRayScreenPosition.x,
        sunRayScreenPosition.y,
        sunRayScreenPosition.z,
      );
      if (!hasSunRays && !hasEmissiveMeshes) return;

      const background = scene.background;
      const fog = scene.fog;
      const overrideMaterial = scene.overrideMaterial;
      const atmosphereVisible = atmosphere.root.visible;
      const layerMask = camera.layers.mask;
      renderer.getClearColor(bloomClearColor);
      const clearAlpha = renderer.getClearAlpha();
      try {
        scene.background = null;
        scene.fog = null;
        atmosphere.root.visible = false;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(bloomTarget);
        camera.layers.set(0);
        scene.overrideMaterial = bloomDepthMaterial;
        renderer.render(scene, camera);
        scene.overrideMaterial = null;

        if (hasSunRays) {
          camera.layers.set(SUN_RAY_LAYER);
          renderExplorerBloomOverlay(renderer, () => renderer.render(scene, camera));
          renderer.setRenderTarget(null);
          sunRayMaterial.uniforms.lightPosition.value.set(
            sunRayScreenPosition.x * 0.5 + 0.5,
            sunRayScreenPosition.y * 0.5 + 0.5,
          );
          renderExplorerBloomOverlay(renderer, () => sunRayOverlay.render(renderer));
        }

        if (hasEmissiveMeshes) {
          renderer.setRenderTarget(bloomTarget);
          renderer.clear(true, false, false);
          camera.layers.set(EMISSIVE_LAYER);
          renderExplorerBloomOverlay(renderer, () => renderer.render(scene, camera));
        }
      } finally {
        camera.layers.mask = layerMask;
        scene.background = background;
        scene.fog = fog;
        scene.overrideMaterial = overrideMaterial;
        atmosphere.root.visible = atmosphereVisible;
        renderer.setClearColor(bloomClearColor, clearAlpha);
        renderer.setRenderTarget(null);
      }
      if (!hasEmissiveMeshes) return;
      bloomPass.render(renderer, bloomTarget, bloomTarget, seconds, false);
      renderer.setRenderTarget(null);
      renderExplorerBloomOverlay(renderer, () => bloomOverlay.render(renderer));
    };
    const updateAtmosphere = (seconds: number) => {
      nightBlend = reducedMotion
        ? Number(nightTarget)
        : THREE.MathUtils.damp(nightBlend, Number(nightTarget), 2.4, seconds);
      if (Math.abs(nightBlend - Number(nightTarget)) < 0.001) {
        nightBlend = Number(nightTarget);
      }

      const dayLight = 1 - THREE.MathUtils.smoothstep(nightBlend, 0, 0.54);
      const moonLight = THREE.MathUtils.smoothstep(nightBlend, 0.46, 1);
      sunVisibility = 1 - THREE.MathUtils.smoothstep(nightBlend, 0, 0.72);
      atmosphere.sky.visible = nightBlend < 0.999;
      atmosphere.nightSky.visible = nightBlend > 0.001;
      atmosphere.nightSky.material.opacity = nightBlend;
      atmosphere.hemisphere.color.lerpColors(
        DAY_HEMISPHERE_COLOR,
        NIGHT_HEMISPHERE_COLOR,
        nightBlend,
      );
      atmosphere.hemisphere.groundColor.lerpColors(
        DAY_GROUND_COLOR,
        NIGHT_GROUND_COLOR,
        nightBlend,
      );
      atmosphere.hemisphere.intensity = THREE.MathUtils.lerp(0.98, 0.42, nightBlend);
      atmosphere.ambient.color.lerpColors(DAY_AMBIENT_COLOR, NIGHT_AMBIENT_COLOR, nightBlend);
      atmosphere.ambient.intensity = THREE.MathUtils.lerp(0.14, 0.11, nightBlend);
      sun.color.lerpColors(DAY_SUN_COLOR, NIGHT_MOONLIGHT_COLOR, moonLight);
      sun.intensity = 3.5 * dayLight + 0.42 * moonLight;
      (scene.background as THREE.Color).lerpColors(DAY_FOG_COLOR, NIGHT_FOG_COLOR, nightBlend);
      (scene.fog as THREE.Fog).color.lerpColors(DAY_FOG_COLOR, NIGHT_FOG_COLOR, nightBlend);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(1.1, 1.04, nightBlend);

      atmosphere.moonMaterial.opacity =
        THREE.MathUtils.smoothstep(nightBlend, 0.22, 0.86) * 0.96;
      atmosphere.sunFlareElement.color
        .copy(SUN_FLARE_COLOR)
        .multiplyScalar(sunVisibility);
      sunFlare.visible = sunVisibility > 0.01;
      sunRaySpriteMaterial.opacity = sunVisibility;

      if (!reducedMotion) {
        atmosphereTime += seconds;
        atmosphere.stars.rotation.y += seconds * 0.00045;
      }
      for (let layer = 0; layer < atmosphere.starMaterials.length; layer += 1) {
        const twinkle = 0.65 + Math.sin(atmosphereTime * (0.72 + layer * 0.17) + layer * 2.1) * 0.13;
        atmosphere.starMaterials[layer].opacity = nightBlend * twinkle;
      }

      const shouldUseMoonLight = nightBlend >= 0.5;
      if (shouldUseMoonLight !== moonLightActive && voxelGroup) {
        moonLightActive = shouldUseMoonLight;
        frameAtmosphere(
          camera,
          scene,
          atmosphere,
          voxelGroup.bounds,
          moonLightActive ? MOON_DIRECTION : SUN_DIRECTION,
        );
      }

      if (reducedMotion || !nightTarget || nightBlend < 0.9) {
        atmosphere.meteorGroup.visible = false;
        for (const meteor of atmosphere.meteors) meteor.sprite.visible = false;
        return;
      }
      nightElapsed += seconds;
      if (showerStartedAt < 0 && nightElapsed >= nextShowerAt) {
        showerStartedAt = nightElapsed;
      }
      let meteorVisible = false;
      if (showerStartedAt >= 0) {
        const showerAge = nightElapsed - showerStartedAt;
        for (const meteor of atmosphere.meteors) {
          const opacity = getExplorerMeteorOpacity(
            showerAge,
            meteor.delay,
            meteor.duration,
          );
          const progress = THREE.MathUtils.clamp(
            (showerAge - meteor.delay) / meteor.duration,
            0,
            1,
          );
          meteor.sprite.position.lerpVectors(meteor.start, meteor.end, progress).normalize();
          meteor.material.opacity = opacity * 0.88 * nightBlend;
          meteor.sprite.visible = opacity > 0;
          meteorVisible ||= meteor.sprite.visible;
        }
        const lastMeteor = atmosphere.meteors[atmosphere.meteors.length - 1];
        if (showerAge > lastMeteor.delay + lastMeteor.duration) {
          showerStartedAt = -1;
          showerCount += 1;
          nextShowerAt = nightElapsed + 38 + (showerCount % 3) * 9;
        }
      }
      atmosphere.meteorGroup.visible = meteorVisible;
    };
    const updatePlayer = (seconds: number) => {
      if (!controls.isLocked || !collisionWorld) {
        bobWalking = false;
        return;
      }

      controls.getDirection(forward);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
      if (!isNoclip) {
        forward.y = 0;
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
        else forward.normalize();
      }
      setExplorerMoveDirection(
        movement,
        forward,
        right,
        Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
        Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
        isNoclip
          ? Number(keys.has("Space")) - Number(hasKey(keys, "ControlLeft", "ControlRight"))
          : 0,
      );

      const running = hasKey(keys, "ShiftLeft", "ShiftRight");
      if (isNoclip) {
        camera.position.addScaledVector(movement, (running ? FLY_RUN_SPEED : FLY_SPEED) * seconds);
        bobWalking = false;
        return;
      }

      const startX = camera.position.x;
      const startZ = camera.position.z;
      const stepCount = Math.max(1, Math.ceil(seconds / MAX_PHYSICS_STEP_SECONDS));
      const stepSeconds = seconds / stepCount;
      for (let step = 0; step < stepCount; step += 1) {
        let inWater = collisionWorld.isInWater(camera.position);
        const waterMultiplier = inWater
          ? WATER_SPEED_MULTIPLIER
          : 1;
        const speed = (running ? RUN_SPEED : WALK_SPEED) * waterMultiplier;
        moveExplorerPlayerAxis(collisionWorld, camera.position, "x", movement.x * speed * stepSeconds);
        moveExplorerPlayerAxis(collisionWorld, camera.position, "z", movement.z * speed * stepSeconds);

        inWater = collisionWorld.isInWater(camera.position);
        if (inWater) {
          verticalVelocity = keys.has("Space") ? WATER_ASCENT_SPEED : -WATER_SINK_SPEED;
          grounded = false;
        } else {
          if (keys.has("Space") && grounded) {
            verticalVelocity = JUMP_VELOCITY;
            grounded = false;
          }
          verticalVelocity = Math.max(
            verticalVelocity - GRAVITY * stepSeconds,
            -MAX_FALL_SPEED,
          );
        }
        const verticalCollision = moveExplorerPlayerAxis(
          collisionWorld,
          camera.position,
          "y",
          verticalVelocity * stepSeconds,
        );
        grounded = verticalCollision && verticalVelocity < 0;
        if (verticalCollision) verticalVelocity = 0;
      }
      const traveled = Math.hypot(camera.position.x - startX, camera.position.z - startZ);
      bobWalking = grounded && traveled > 1e-6 && !collisionWorld.isInWater(camera.position);
      bobRunning = running;
      if (bobWalking) bobDistance += traveled * VIEW_BOB_DISTANCE_SCALE;
    };

    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let fpsWindowAt = lastFrameAt;
    let fpsFrames = 0;
    const render = (now: number) => {
      const seconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - lastFrameAt) / 1_000));
      lastFrameAt = now;
      updatePlayer(seconds);
      updateAtmosphere(seconds);

      if (reducedMotion) {
        bobBlend = 0;
      } else {
        bobBlend = THREE.MathUtils.damp(
          bobBlend,
          bobWalking ? (bobRunning ? VIEW_BOB_RUN_AMOUNT : VIEW_BOB_WALK_AMOUNT) : 0,
          14,
          seconds,
        );
      }
      setExplorerViewBob(viewBob, bobDistance, bobBlend);
      baseQuaternion.copy(camera.quaternion);
      bobUp.set(0, 1, 0).applyQuaternion(baseQuaternion);
      camera.position.addScaledVector(right, viewBob.x);
      camera.position.addScaledVector(bobUp, viewBob.y);
      camera.rotateZ(viewBob.roll);
      camera.rotateX(viewBob.pitch);
      const sunDistance = camera.far * 0.9;
      atmosphere.root.position.copy(camera.position);
      sunFlare.position.copy(SUN_DIRECTION).multiplyScalar(sunDistance);
      atmosphere.moon.position.copy(MOON_DIRECTION).multiplyScalar(sunDistance);
      sunRaySprite.position.copy(camera.position).addScaledVector(SUN_DIRECTION, sunDistance);
      const sunRaySize =
        2 * sunDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 0.18;
      sunRaySprite.scale.set(sunRaySize, sunRaySize, 1);
      const moonSize =
        2 * sunDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 0.075;
      atmosphere.moon.scale.set(moonSize, moonSize, 1);
      try {
        renderer.render(scene, camera);
        renderPostEffects(seconds);
      } finally {
        camera.quaternion.copy(baseQuaternion);
        camera.position.addScaledVector(bobUp, -viewBob.y);
        camera.position.addScaledVector(right, -viewBob.x);
      }
      fpsFrames += 1;
      if (now - fpsWindowAt >= 750) {
        setFps(Math.round((fpsFrames * 1_000) / (now - fpsWindowAt)));
        fpsFrames = 0;
        fpsWindowAt = now;
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);

    void (async () => {
      try {
        const atlasPromise = loadAtlasTexture();
        const collisionPromise = createExplorerCollisionWorld(build.voxelBuild, {
          signal: abortController.signal,
          onProgress() {
            if (!disposed) setLoading("Preparing collision");
          },
        });
        const blockLightPromise = createExplorerBlockLightGrid(build.voxelBuild, {
          signal: abortController.signal,
          onProgress(stage) {
            if (!disposed) setLoading(stage);
          },
        });
        const atlas = await atlasPromise;
        const groupPromise = createVoxelGroupAsync(build.voxelBuild, getPalette(build.palette), atlas, {
          signal: abortController.signal,
          cacheKey: meshCacheKey,
          onProgress(progress) {
            if (!disposed) setLoading(progress.stageLabel ?? "Building");
          },
        });
        const [nextCollisionWorld, nextVoxelGroup, blockLightGrid] = await Promise.all([
          collisionPromise,
          groupPromise,
          blockLightPromise,
        ]);
        if (disposed || abortController.signal.aborted) {
          nextVoxelGroup.dispose();
          return;
        }

        collisionWorld = nextCollisionWorld;
        voxelGroup = nextVoxelGroup;
        if (blockLightGrid) {
          await applyExplorerBlockLighting(
            voxelGroup.group,
            voxelGroup.bounds.box,
            blockLightGrid,
            {
              signal: abortController.signal,
              onProgress(stage) {
                if (!disposed) setLoading(stage);
              },
            },
          );
        }
        voxelGroup.group.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          child.castShadow = materials.every((material) => !material.transparent);
          child.receiveShadow = true;
          if (!materials.some((material) => material instanceof THREE.MeshBasicMaterial)) return;
          hasEmissiveMeshes = true;
          child.layers.enable(EMISSIVE_LAYER);
        });
        scene.add(voxelGroup.group);
        frameAtmosphere(camera, scene, atmosphere, voxelGroup.bounds, SUN_DIRECTION);
        resize();

        camera.position.set(0, collisionWorld.height + 8, 0);
        camera.lookAt(0, Math.max(0, collisionWorld.height - 4), -12);
        renderer.shadowMap.needsUpdate = true;
        worldReady = true;
        setLoading("");
        setReady(true);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        console.warn("Voxel explorer setup failed", loadError);
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : "Explorer failed to start");
        }
      }
    })();

    return () => {
      disposed = true;
      abortController.abort();
      startRef.current = null;
      resizeObserver.disconnect();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
      reducedMotionQuery.removeEventListener("change", onReducedMotionChange);
      controls.removeEventListener("lock", onLock);
      controls.removeEventListener("unlock", onUnlock);
      if (controls.isLocked) controls.unlock();
      controls.dispose();
      window.cancelAnimationFrame(animationFrame);
      if (voxelGroup) {
        scene.remove(voxelGroup.group);
        voxelGroup.dispose();
      }
      scene.remove(atmosphere.root);
      sunFlare.dispose();
      scene.remove(sunRaySprite);
      sunRayTexture.dispose();
      sunRaySpriteMaterial.dispose();
      sunRayMaterial.dispose();
      sunRayOverlay.dispose();
      bloomDepthMaterial.dispose();
      bloomOverlayMaterial.dispose();
      bloomOverlay.dispose();
      bloomPass.dispose();
      bloomTarget.dispose();
      atmosphere.sky.material.map?.dispose();
      atmosphere.nightSky.material.map?.dispose();
      atmosphere.sky.geometry.dispose();
      atmosphere.sky.material.dispose();
      atmosphere.nightSky.material.dispose();
      atmosphere.stars.traverse((child) => {
        if (child instanceof THREE.Points) child.geometry.dispose();
      });
      for (const material of atmosphere.starMaterials) material.dispose();
      atmosphere.moonTexture.dispose();
      atmosphere.moonMaterial.dispose();
      atmosphere.meteorTexture.dispose();
      for (const meteor of atmosphere.meteors) meteor.material.dispose();
      try {
        renderer.forceContextLoss();
      } catch {}
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [build, meshCacheKey]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[oklch(0.86_0.055_235)] text-slate-950">
      <div ref={mountRef} className="absolute inset-0" />

      {ready && locked ? (
        <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2">
          <span className="absolute left-1/2 top-0 h-4 w-px -translate-x-1/2 bg-white/85 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
          <span className="absolute left-0 top-1/2 h-px w-4 -translate-y-1/2 bg-white/85 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
        </div>
      ) : null}

      {ready ? (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded bg-slate-950/55 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm">
          <span>{noclip ? "Noclip" : "Walking"}</span>
          <span className="text-white/45">·</span>
          <span className="tabular-nums text-white/75">{fps} FPS</span>
        </div>
      ) : null}

      {ready && locked ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
          <div className="rounded bg-slate-950/55 px-3 py-1.5 text-[10px] font-medium text-white/75 backdrop-blur-sm">
            WASD Move · Shift Run · Space {noclip ? "Rise · Control Descend" : "Jump / Swim"} · F Noclip · T {night ? "Day" : "Night"} · Esc Menu
          </div>
        </div>
      ) : null}

      {!locked ? (
        <div className="absolute inset-0 bg-slate-950/20">
          {buildMenuOpen ? (
            <ExplorerBuildMenu
              currentBuildId={buildId}
              pinnedBuild={pinnedBuild}
              onClose={closeBuildMenu}
              onSelect={selectBuild}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 rounded-md bg-slate-950/70 px-6 py-5 text-white backdrop-blur-sm">
                {error ? (
                  <p className="max-w-sm text-center text-sm text-white/85">{error}</p>
                ) : (
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={enter}
                    className="rounded bg-white/90 px-5 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-white disabled:cursor-wait disabled:bg-white/20 disabled:text-white/65"
                  >
                    {ready ? (entered ? "Resume" : "Enter") : loading}
                  </button>
                )}
                <button
                  ref={browseButtonRef}
                  type="button"
                  onClick={() => setBuildMenuOpen(true)}
                  className="text-xs font-medium text-white/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/65"
                >
                  Builds
                </button>
                <button
                  type="button"
                  onClick={onExit}
                  className="text-xs font-medium text-white/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/65"
                >
                  Exit
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function useExplorerBuild(buildId: string, initialBuild?: VoxelExplorerBuild) {
  const [build, setBuild] = useState<LoadedBuild | null>(
    buildId === initialBuild?.id ? initialBuild : null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (buildId === initialBuild?.id) {
      setBuild(initialBuild);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setBuild(null);
    setError(null);
    void fetchExplorerBuild(buildId, controller.signal).then(
      setBuild,
      (loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load build");
      },
    );
    return () => controller.abort();
  }, [buildId, initialBuild]);
  return { build, error };
}

export function VoxelExplorer({ buildId }: { buildId: string }) {
  const router = useRouter();
  const { build, error } = useExplorerBuild(buildId);
  const selectBuild = useCallback(
    (nextBuildId: string) => router.push(`/sandbox/explore/${encodeURIComponent(nextBuildId)}`),
    [router],
  );
  const exit = useCallback(() => router.push("/sandbox"), [router]);

  return (
    <div className="fixed inset-0 z-[100] bg-[oklch(0.86_0.055_235)]">
      {build ? (
        <ExplorerScene
          build={build}
          buildId={buildId}
          onSelectBuild={selectBuild}
          onExit={exit}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-semibold text-slate-800">
          {error ?? "Loading"}
        </div>
      )}
    </div>
  );
}

export function VoxelExplorerOverlay({
  initialBuild,
  onExit,
}: {
  initialBuild: VoxelExplorerBuild;
  onExit: () => void;
}) {
  const [buildId, setBuildId] = useState(initialBuild.id);
  const { build, error } = useExplorerBuild(buildId, initialBuild);

  return (
    <div className="fixed inset-0 z-[100] bg-[oklch(0.86_0.055_235)]">
      {build ? (
        <ExplorerScene
          build={build}
          buildId={buildId}
          pinnedBuild={initialBuild}
          onSelectBuild={setBuildId}
          onExit={onExit}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-4 text-sm font-semibold text-slate-800">
          <p>{error ?? "Loading"}</p>
          {error ? (
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded bg-slate-900 px-4 py-2 text-xs text-white"
                onClick={() => setBuildId(initialBuild.id)}
              >
                Current build
              </button>
              <button
                type="button"
                className="rounded border border-slate-400 px-4 py-2 text-xs"
                onClick={onExit}
              >
                Exit
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
