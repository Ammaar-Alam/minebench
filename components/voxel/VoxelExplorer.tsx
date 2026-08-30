"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { Lensflare, LensflareElement } from "three/examples/jsm/objects/Lensflare.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { BloomPass } from "three/examples/jsm/postprocessing/BloomPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import {
  readBuildVariantPayload,
  readBuildVariantStream,
  type BuildVariantStreamResponse,
} from "@/lib/arena/clientBuildResponse";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";
import { getPalette } from "@/lib/blocks/palettes";
import { VOXEL_VIEWER_WEBGL_ERROR } from "@/lib/voxel/errors";
import {
  EXPLORER_EYE_HEIGHT,
  createExplorerCollisionWorld,
  moveExplorerPlayerAxis,
  setExplorerMoveDirection,
  type ExplorerCollisionWorld,
} from "@/lib/voxel/explorerCollision";
import {
  clusterExplorerEmissiveFaces,
  selectNearestExplorerLightClusters,
  type ExplorerLightCluster,
} from "@/lib/voxel/explorerLighting";
import { createVoxelGroupAsync, type VoxelGroup } from "@/lib/voxel/mesh";
import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { createPublicMeshCacheKey } from "@/lib/voxel/meshPayloadCache";
import {
  setExplorerViewBob,
  type ExplorerViewBobTransform,
} from "@/lib/voxel/explorerViewBob";

const WALK_SPEED = 4.3;
const RUN_SPEED = 7.5;
const FLY_SPEED = 10.9;
const FLY_RUN_SPEED = 21.8;
const GRAVITY = 32;
const JUMP_VELOCITY = Math.sqrt(GRAVITY * 2 * 1.25);
const WATER_SPEED_MULTIPLIER = 0.8;
const WATER_ASCENT_SPEED = 3.5;
const WATER_SINK_SPEED = 1;
const VIEW_BOB_DISTANCE_SCALE = 0.8;
const VIEW_BOB_WALK_AMOUNT = 0.075;
const VIEW_BOB_RUN_AMOUNT = 0.1;
const SSAO_RENDER_SCALE = 0.5;
const BLOOM_RENDER_SCALE = 0.25;
const EMISSIVE_LAYER = 1;
const EMISSIVE_LIGHT_COUNT = 6;
const EMISSIVE_LIGHT_DISTANCE = 18;
const EMISSIVE_LIGHT_SELECTION_RADIUS = 32;
const EMISSIVE_LIGHT_INTENSITY = 42;
const EMISSIVE_LIGHT_UPDATE_MS = 180;
const MAX_FRAME_SECONDS = 0.05;
const MAX_PHYSICS_STEP_SECONDS = 1 / 60;
const DAYLIGHT_COLOR = 0xaed4ef;
const GALLERY_BUILD_PREFIX = "gallery:";
const SUN_DIRECTION = new THREE.Vector3(-0.46, 0.72, -0.52).normalize();

let explorerAtlasPromise: Promise<THREE.Texture> | null = null;
let explorerBuildCatalog: ExplorerBuildOption[] | null = null;

type LoadedBuild = {
  checksum: string | null;
  palette: "simple" | "advanced";
  voxelBuild: RenderableVoxelBuild;
};

type ExplorerBuildOption = {
  id: string;
  model: string;
  prompt: string;
  blockCount: number;
  source: "benchmark" | "gallery";
};

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
  const galleryExampleId = buildId.startsWith(GALLERY_BUILD_PREFIX)
    ? buildId.slice(GALLERY_BUILD_PREFIX.length)
    : null;
  if (galleryExampleId) {
    const response = await fetch(
      `/api/gallery/examples/${encodeURIComponent(galleryExampleId)}/viewer`,
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
    `/api/arena/builds/${encodeURIComponent(buildId)}`,
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
    payload = await fetchStreamBuild(buildId, signal);
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
    gradient.addColorStop(0, "rgba(255, 253, 235, 1)");
    gradient.addColorStop(0.055, "rgba(255, 245, 201, 0.98)");
    gradient.addColorStop(0.14, "rgba(255, 224, 151, 0.68)");
    gradient.addColorStop(0.34, "rgba(255, 193, 102, 0.24)");
    gradient.addColorStop(0.68, "rgba(255, 174, 76, 0.07)");
    gradient.addColorStop(1, "rgba(255, 165, 64, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function ExplorerBuildMenu({
  currentBuildId,
  onClose,
  onSelect,
}: {
  currentBuildId: string;
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

  const filteredBuilds = useMemo(() => {
    if (!builds) return [];
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return builds;
    return builds.filter((build) => {
      const searchable = `${build.source} ${build.model} ${build.prompt}`.toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
  }, [builds, query]);

  return (
    <aside className="absolute inset-y-3 right-3 flex w-[min(28rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-md border border-white/10 bg-slate-950/90 text-white shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Builds</h2>
          {builds ? (
            <p className="mt-0.5 text-[11px] text-white/50">
              {filteredBuilds.length === builds.length
                ? `${builds.length.toLocaleString()} available`
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
        {builds && filteredBuilds.length === 0 ? (
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
                  {build.source === "gallery" ? "Gallery · " : ""}
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

function configureDaylight(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): { sky: Sky; sun: THREE.DirectionalLight; sunFlare: Lensflare } {
  scene.background = new THREE.Color(DAYLIGHT_COLOR);
  scene.fog = new THREE.Fog(DAYLIGHT_COLOR, 72, 320);

  const sky = new Sky();
  sky.scale.setScalar(1_000);
  sky.material.uniforms.turbidity.value = 4.5;
  sky.material.uniforms.rayleigh.value = 1.8;
  sky.material.uniforms.mieCoefficient.value = 0.0035;
  sky.material.uniforms.mieDirectionalG.value = 0.86;
  sky.material.uniforms.sunPosition.value.copy(SUN_DIRECTION);
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x39452f, 0.78));
  scene.add(new THREE.AmbientLight(0xffffff, 0.08));

  const sun = new THREE.DirectionalLight(0xffe2b3, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  const sunFlare = new Lensflare();
  sunFlare.addElement(
    new LensflareElement(createSunHaloTexture(), 360, 0, new THREE.Color(0xffd18a)),
  );
  scene.add(sunFlare);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { sky, sun, sunFlare };
}

function frameDaylight(
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  sky: Sky,
  sun: THREE.DirectionalLight,
  bounds: VoxelGroup["bounds"],
) {
  const size = bounds.box.getSize(new THREE.Vector3());
  const radius = Math.max(8, bounds.radius);
  const fog = scene.fog as THREE.Fog;
  fog.near = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.35, 48, 96);
  fog.far = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 1.5, 160, 512);
  camera.far = Math.max(1_000, fog.far * 3);
  camera.updateProjectionMatrix();
  sky.scale.setScalar(camera.far * 0.8);

  const lightDistance = Math.max(80, radius * 2.2);
  sun.target.position.copy(bounds.center);
  sun.position.copy(bounds.center).addScaledVector(SUN_DIRECTION, lightDistance);
  const shadowCamera = sun.shadow.camera;
  const shadowRadius = radius * 1.1;
  shadowCamera.left = -shadowRadius;
  shadowCamera.right = shadowRadius;
  shadowCamera.top = shadowRadius;
  shadowCamera.bottom = -shadowRadius;
  shadowCamera.near = 0.1;
  shadowCamera.far = lightDistance + radius * 2;
  shadowCamera.updateProjectionMatrix();
  sun.target.updateMatrixWorld();
  sun.shadow.needsUpdate = true;
}

function hasKey(keys: Set<string>, left: string, right?: string): boolean {
  return keys.has(left) || Boolean(right && keys.has(right));
}

function ExplorerScene({ build, buildId }: { build: LoadedBuild; buildId: string }) {
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const browseButtonRef = useRef<HTMLButtonElement | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [entered, setEntered] = useState(false);
  const [noclip, setNoclip] = useState(true);
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
    router.push(`/sandbox/explore/${encodeURIComponent(nextBuildId)}`);
  }, [router]);

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
    const keys = new Set<string>();

    setReady(false);
    setLocked(false);
    setEntered(false);
    setNoclip(true);
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
    const { sky, sun, sunFlare } = configureDaylight(scene, renderer);
    const ssaoPass = new SSAOPass(scene, camera, 1, 1, 16);
    ssaoPass.renderToScreen = true;
    ssaoPass.kernelRadius = 12;
    ssaoPass.minDistance = 0.001;
    ssaoPass.maxDistance = 0.1;
    const bloomTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    bloomTarget.texture.name = "Explorer.emissiveBloom";
    bloomTarget.texture.generateMipmaps = false;
    const bloomPass = new BloomPass(1, 13, 2);
    const bloomOverlayUniforms = THREE.UniformsUtils.clone(CopyShader.uniforms);
    bloomOverlayUniforms.tDiffuse.value = bloomTarget.texture;
    bloomOverlayUniforms.opacity.value = 0.78;
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
    const emissiveLights = Array.from({ length: EMISSIVE_LIGHT_COUNT }, () => {
      const light = new THREE.PointLight(
        0xffb45c,
        0,
        EMISSIVE_LIGHT_DISTANCE,
        2,
      );
      light.visible = false;
      scene.add(light);
      return light;
    });
    let emissiveClusters: ExplorerLightCluster[] = [];
    let hasEmissiveMeshes = false;
    let nextEmissiveLightUpdateAt = 0;

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
        event.code === "KeyF"
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
      ssaoPass.setSize(
        Math.max(1, Math.round(width * pixelRatio * SSAO_RENDER_SCALE)),
        Math.max(1, Math.round(height * pixelRatio * SSAO_RENDER_SCALE)),
      );
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
    const updateEmissiveLights = () => {
      const selected = selectNearestExplorerLightClusters(
        emissiveClusters,
        camera.position,
        EMISSIVE_LIGHT_COUNT,
        EMISSIVE_LIGHT_SELECTION_RADIUS,
      );
      const active = selected.length > 0;
      for (let i = 0; i < emissiveLights.length; i += 1) {
        const light = emissiveLights[i];
        const cluster = selected[i];
        light.visible = active;
        if (!cluster) {
          light.intensity = 0;
          continue;
        }
        light.position.set(cluster.x, cluster.y, cluster.z);
        light.intensity =
          EMISSIVE_LIGHT_INTENSITY * Math.min(1.45, 0.65 + Math.sqrt(cluster.faces) * 0.16);
      }
    };
    const renderEmissiveBloom = (seconds: number) => {
      const background = scene.background;
      const fog = scene.fog;
      const layerMask = camera.layers.mask;
      renderer.getClearColor(bloomClearColor);
      const clearAlpha = renderer.getClearAlpha();
      try {
        camera.layers.set(EMISSIVE_LAYER);
        scene.background = null;
        scene.fog = null;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(bloomTarget);
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        camera.layers.mask = layerMask;
        scene.background = background;
        scene.fog = fog;
        renderer.setClearColor(bloomClearColor, clearAlpha);
        renderer.setRenderTarget(null);
      }
      bloomPass.render(renderer, bloomTarget, bloomTarget, seconds, false);
      renderer.setRenderTarget(null);
      bloomOverlay.render(renderer);
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
          verticalVelocity -= GRAVITY * stepSeconds;
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
      if (hasEmissiveMeshes && now >= nextEmissiveLightUpdateAt) {
        updateEmissiveLights();
        nextEmissiveLightUpdateAt = now + EMISSIVE_LIGHT_UPDATE_MS;
      }

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
      sunFlare.position.copy(camera.position).addScaledVector(SUN_DIRECTION, camera.far * 0.8);
      try {
        renderer.render(scene, camera);
        sunFlare.visible = false;
        ssaoPass.render(renderer, null!, null!, seconds, false);
        if (hasEmissiveMeshes) renderEmissiveBloom(seconds);
      } finally {
        sunFlare.visible = true;
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
        const atlas = await atlasPromise;
        const groupPromise = createVoxelGroupAsync(build.voxelBuild, getPalette(build.palette), atlas, {
          signal: abortController.signal,
          cacheKey: meshCacheKey,
          onProgress(progress) {
            if (!disposed) setLoading(progress.stageLabel ?? "Building");
          },
        });
        const [nextCollisionWorld, nextVoxelGroup] = await Promise.all([
          collisionPromise,
          groupPromise,
        ]);
        if (disposed || abortController.signal.aborted) {
          nextVoxelGroup.dispose();
          return;
        }

        collisionWorld = nextCollisionWorld;
        voxelGroup = nextVoxelGroup;
        voxelGroup.group.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          child.castShadow = materials.every((material) => !material.transparent);
          child.receiveShadow = true;
          if (!materials.some((material) => material instanceof THREE.MeshBasicMaterial)) return;
          hasEmissiveMeshes = true;
          child.layers.enable(EMISSIVE_LAYER);
          const positions = child.geometry.getAttribute("position");
          if (positions?.itemSize !== 3) return;
          for (const cluster of clusterExplorerEmissiveFaces(positions.array)) {
            emissiveClusters.push(cluster);
          }
        });
        scene.add(voxelGroup.group);
        frameDaylight(camera, scene, sky, sun, voxelGroup.bounds);
        resize();

        camera.position.set(0, collisionWorld.height + 8, 0);
        camera.lookAt(0, Math.max(0, collisionWorld.height - 4), -12);
        updateEmissiveLights();
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
      scene.remove(sunFlare);
      sunFlare.dispose();
      for (const light of emissiveLights) scene.remove(light);
      bloomOverlayMaterial.dispose();
      bloomOverlay.dispose();
      bloomPass.dispose();
      bloomTarget.dispose();
      ssaoPass.noiseTexture.dispose();
      ssaoPass.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
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
            WASD Move · Shift Run · Space {noclip ? "Rise · Control Descend" : "Jump / Swim"} · F Noclip · Esc Menu
          </div>
        </div>
      ) : null}

      {!locked ? (
        <div className="absolute inset-0 bg-slate-950/20">
          {buildMenuOpen ? (
            <ExplorerBuildMenu
              currentBuildId={buildId}
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
                <Link href="/sandbox" className="text-xs font-medium text-white/65 hover:text-white">
                  Exit
                </Link>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function VoxelExplorer({ buildId }: { buildId: string }) {
  const [build, setBuild] = useState<LoadedBuild | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [buildId]);

  return (
    <main className="fixed inset-0 z-[100] bg-[oklch(0.86_0.055_235)]">
      {build ? (
        <ExplorerScene build={build} buildId={buildId} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-semibold text-slate-800">
          {error ?? "Loading"}
        </div>
      )}
    </main>
  );
}
