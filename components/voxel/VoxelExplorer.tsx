"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
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
import { createVoxelGroupAsync, type VoxelGroup } from "@/lib/voxel/mesh";
import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { createPublicMeshCacheKey } from "@/lib/voxel/meshPayloadCache";

const WALK_SPEED = 4.3;
const RUN_SPEED = 7.5;
const FLY_SPEED = 10.9;
const FLY_RUN_SPEED = 21.8;
const GRAVITY = 32;
const JUMP_VELOCITY = Math.sqrt(GRAVITY * 2 * 1.25);
const WATER_SPEED_MULTIPLIER = 0.8;
const WATER_ASCENT_SPEED = 3.5;
const WATER_SINK_SPEED = 1;
const VIEW_BOB_VERTICAL = 0.045;
const VIEW_BOB_LATERAL = 0.018;
const MAX_FRAME_SECONDS = 0.05;
const MAX_PHYSICS_STEP_SECONDS = 1 / 60;
const DAYLIGHT_COLOR = 0xaed4ef;
const SIMPLE_PALETTE = getPalette("simple");

let explorerAtlasPromise: Promise<THREE.Texture> | null = null;

type LoadedBuild = {
  checksum: string | null;
  voxelBuild: RenderableVoxelBuild;
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
  return { checksum: payload.checksum, voxelBuild: payload.voxelBuild };
}

function configureDaylight(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): { sky: Sky; sun: THREE.DirectionalLight } {
  scene.background = new THREE.Color(DAYLIGHT_COLOR);
  scene.fog = new THREE.Fog(DAYLIGHT_COLOR, 72, 320);

  const sky = new Sky();
  sky.scale.setScalar(1_000);
  sky.material.uniforms.turbidity.value = 4.5;
  sky.material.uniforms.rayleigh.value = 1.8;
  sky.material.uniforms.mieCoefficient.value = 0.0035;
  sky.material.uniforms.mieDirectionalG.value = 0.86;
  const sunDirection = new THREE.Vector3(0.55, 0.78, 0.3).normalize();
  sky.material.uniforms.sunPosition.value.copy(sunDirection);
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x39452f, 0.72));
  scene.add(new THREE.AmbientLight(0xffffff, 0.08));

  const sun = new THREE.DirectionalLight(0xffedc2, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { sky, sun };
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

  const sunDirection = new THREE.Vector3(0.55, 0.78, 0.3).normalize();
  const lightDistance = Math.max(80, radius * 2.2);
  sun.target.position.copy(bounds.center);
  sun.position.copy(bounds.center).addScaledVector(sunDirection, lightDistance);
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

function ExplorerScene({ build }: { build: LoadedBuild }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [entered, setEntered] = useState(false);
  const [noclip, setNoclip] = useState(true);
  const [fps, setFps] = useState(0);
  const [loading, setLoading] = useState("Building");
  const [error, setError] = useState<string | null>(null);
  const meshCacheKey = useMemo(
    () =>
      createPublicMeshCacheKey({
        checksum: build.checksum,
        variant: "full",
        palette: "simple",
        blockCount: voxelBuildBlockCount(build.voxelBuild),
      }),
    [build],
  );

  const enter = useCallback(() => startRef.current?.(), []);

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
    let bobPhase = 0;
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
    const { sky, sun } = configureDaylight(scene, renderer);

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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, true);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
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
      bobWalking = grounded && movement.lengthSq() > 0 && !collisionWorld.isInWater(camera.position);
      bobRunning = running;
    };

    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let fpsWindowAt = lastFrameAt;
    let fpsFrames = 0;
    const render = (now: number) => {
      const seconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - lastFrameAt) / 1_000));
      lastFrameAt = now;
      updatePlayer(seconds);

      if (reducedMotion) {
        bobBlend = 0;
      } else {
        bobBlend = THREE.MathUtils.damp(bobBlend, bobWalking ? (bobRunning ? 1 : 0.55) : 0, 14, seconds);
        if (bobWalking) bobPhase += seconds * (bobRunning ? 13 : 9);
      }
      const bobY = Math.sin(bobPhase * 2) * VIEW_BOB_VERTICAL * bobBlend;
      const bobX = Math.cos(bobPhase) * VIEW_BOB_LATERAL * bobBlend;
      camera.position.y += bobY;
      camera.position.addScaledVector(right, bobX);
      renderer.render(scene, camera);
      camera.position.addScaledVector(right, -bobX);
      camera.position.y -= bobY;
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
        const groupPromise = createVoxelGroupAsync(build.voxelBuild, SIMPLE_PALETTE, atlas, {
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
        });
        scene.add(voxelGroup.group);
        frameDaylight(camera, scene, sky, sun, voxelGroup.bounds);

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
            WASD Move · Shift Run · Space {noclip ? "Rise · Control Descend" : "Jump / Swim"} · F Noclip · Esc Exit
          </div>
        </div>
      ) : null}

      {!locked ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/20">
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
            <Link href="/sandbox" className="text-xs font-medium text-white/65 hover:text-white">
              Exit
            </Link>
          </div>
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
        <ExplorerScene build={build} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-semibold text-slate-800">
          {error ?? "Loading"}
        </div>
      )}
    </main>
  );
}
