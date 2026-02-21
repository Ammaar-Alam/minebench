"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { createVoxelGroupAsync, VoxelGroup } from "@/lib/voxel/mesh";
import type { VoxelBuild } from "@/lib/voxel/types";

type ViewerProps = {
  voxelBuild: VoxelBuild | null;
  palette: "simple" | "advanced";
  autoRotate?: boolean;
  animateIn?: boolean;
  showControls?: boolean;
  onBuildReadyChange?: (ready: boolean) => void;
};

export type VoxelViewerHandle = {
  hasBuild: () => boolean;
  captureFrame: (opts?: { rotationY?: number; width?: number; height?: number }) => HTMLCanvasElement | null;
};

let atlasPromise: Promise<THREE.Texture> | null = null;

type ViewerTheme = "light" | "dark";

function getViewerTheme(): ViewerTheme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

function applyGridTheme(grid: THREE.GridHelper, theme: ViewerTheme) {
  const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
  const centerMat = mats[0];
  const gridMat = mats.length > 1 ? mats[1] : mats[0];

  const isDark = theme === "dark";
  const centerColor = isDark ? 0x2a2f3a : 0xcbd5e1;
  const minorColor = isDark ? 0x161a22 : 0xe2e8f0;

  const set = (mat: THREE.Material | undefined, opts: { color: number; opacity: number }) => {
    if (!mat) return;
    if ("color" in mat && (mat as { color?: unknown }).color instanceof THREE.Color) {
      (mat as unknown as { color: THREE.Color }).color.setHex(opts.color);
    }
    if ("opacity" in mat) {
      (mat as unknown as { transparent: boolean; opacity: number; depthWrite: boolean }).transparent = true;
      (mat as unknown as { transparent: boolean; opacity: number; depthWrite: boolean }).opacity = opts.opacity;
      (mat as unknown as { transparent: boolean; opacity: number; depthWrite: boolean }).depthWrite = false;
    }
    mat.needsUpdate = true;
  };

  // Subtle in light mode; slightly stronger in dark mode to remain visible.
  set(centerMat, { color: centerColor, opacity: isDark ? 0.55 : 0.45 });
  set(gridMat, { color: minorColor, opacity: isDark ? 0.35 : 0.28 });
}

function loadAtlasTexture(): Promise<THREE.Texture> {
  if (atlasPromise) return atlasPromise;
  atlasPromise = new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load("/textures/atlas.png", resolve, undefined, reject);
  });
  return atlasPromise;
}

type BuildBounds = { box: THREE.Box3; center: THREE.Vector3; radius: number };

function computeGroupBounds(group: THREE.Object3D): BuildBounds {
  group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) {
    const origin = new THREE.Vector3(0, 0, 0);
    return {
      box: new THREE.Box3(origin.clone(), origin.clone()),
      center: origin,
      radius: 0.001,
    };
  }
  const center = box.getCenter(new THREE.Vector3());
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.001;
  return { box, center, radius };
}

type BuildIdentity = {
  palette: "simple" | "advanced";
  blocksRef: VoxelBuild["blocks"] | null;
};

function sameIdentity(a: BuildIdentity | null, b: BuildIdentity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.palette === b.palette && a.blocksRef === b.blocksRef;
}

function computeRebuildThreshold(lastBuilt: number): { minDelta: number; maxWaitMs: number } {
  if (lastBuilt < 80_000) return { minDelta: 10_000, maxWaitMs: 750 };
  if (lastBuilt < 250_000) return { minDelta: 25_000, maxWaitMs: 1200 };
  if (lastBuilt < 900_000) return { minDelta: 80_000, maxWaitMs: 1850 };
  return { minDelta: 150_000, maxWaitMs: 2600 };
}

function frameBounds(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: BuildBounds) {
  const center = bounds.center;
  const radius = Math.max(0.001, bounds.radius);

  controls.target.copy(center);

  const size = bounds.box.getSize(new THREE.Vector3());
  const horiz = Math.max(0.001, Math.max(size.x, size.z));
  const tallness = size.y / horiz;
  // slightly more top-down by default (about +10%)
  const yBias = THREE.MathUtils.clamp((0.38 + tallness * 0.22) * 1.1, 0.38, 0.95);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitHeight = radius / Math.sin(vFov / 2);
  const fitWidth = radius / Math.sin(hFov / 2);
  const distance = Math.max(fitHeight, fitWidth);

  const dir = new THREE.Vector3(1, yBias, 1).normalize();
  // slightly closer default framing
  camera.position.copy(center).addScaledVector(dir, distance * 1.1);
  camera.near = Math.max(0.05, distance / 250);
  camera.far = Math.max(200, distance * 60);
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  controls.minDistance = Math.max(0.5, distance * 0.12);
  controls.maxDistance = Math.max(40, distance * 14);

  controls.update();
  controls.saveState();
}

export const VoxelViewer = forwardRef<VoxelViewerHandle, ViewerProps>(function VoxelViewer(
  { voxelBuild, palette, autoRotate, animateIn, showControls = true, onBuildReadyChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const voxelGroupRef = useRef<VoxelGroup | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const revealRafRef = useRef<number | null>(null);
  const boundsRef = useRef<BuildBounds | null>(null);
  const autoRotateRef = useRef(false);
  const userInteractingRef = useRef(false);
  const onBuildReadyChangeRef = useRef<((ready: boolean) => void) | undefined>(undefined);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
  } | null>(null);

  type DragMode = "orbit" | "pan";
  const [dragMode, setDragMode] = useState<DragMode>("orbit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragModeBeforeCtrlRef = useRef<DragMode>("orbit");
  const ctrlHeldRef = useRef(false);

  const paletteDefs: BlockDefinition[] = useMemo(() => getPalette(palette), [palette]);
  const latestRef = useRef<{
    voxelBuild: VoxelBuild | null;
    palette: "simple" | "advanced";
    paletteDefs: BlockDefinition[];
    animateIn: boolean;
  }>({ voxelBuild: null, palette, paletteDefs, animateIn: Boolean(animateIn) });
  latestRef.current = {
    voxelBuild,
    palette,
    paletteDefs,
    animateIn: Boolean(animateIn),
  };

  const identityRef = useRef<BuildIdentity | null>(null);
  const activeJobRef = useRef<{ controller: AbortController | null; identity: BuildIdentity | null }>({
    controller: null,
    identity: null,
  });
  const buildInProgressRef = useRef(false);
  const buildPendingRef = useRef({ dirty: false, force: false });
  const settleTimerRef = useRef<number | null>(null);
  const kickScheduledRef = useRef(false);
  const kickBuildRef = useRef<(() => void) | null>(null);
  const lastBuiltRef = useRef<{ blockLimit: number; at: number }>({ blockLimit: 0, at: 0 });

  useEffect(() => {
    onBuildReadyChangeRef.current = onBuildReadyChange;
  }, [onBuildReadyChange]);

  const fitView = useCallback(() => {
    const three = threeRef.current;
    const vg = voxelGroupRef.current;
    const bounds = boundsRef.current;
    if (!three || !vg || !bounds) return;
    frameBounds(three.camera, three.controls, bounds);
    if (gridRef.current) {
      gridRef.current.position.y = bounds.box.min.y - 0.5;
    }
  }, []);

  const clearVoxelGroup = useCallback((three: NonNullable<typeof threeRef.current>) => {
    if (revealRafRef.current) {
      window.cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }

    if (voxelGroupRef.current) {
      three.scene.remove(voxelGroupRef.current.group);
      voxelGroupRef.current.dispose();
      voxelGroupRef.current = null;
    }
    boundsRef.current = null;
    lastBuiltRef.current = { blockLimit: 0, at: 0 };
    onBuildReadyChangeRef.current?.(false);
  }, []);

  const scheduleKick = useCallback(() => {
    if (kickScheduledRef.current) return;
    kickScheduledRef.current = true;
    queueMicrotask(() => {
      kickScheduledRef.current = false;
      kickBuildRef.current?.();
    });
  }, []);

  const kickBuild = useCallback(async () => {
    if (buildInProgressRef.current) return;
    if (!buildPendingRef.current.dirty) return;
    const three = threeRef.current;
    if (!three) return;

    const latest = latestRef.current;
    const incomingIdentity: BuildIdentity | null = latest.voxelBuild
      ? { palette: latest.palette, blocksRef: latest.voxelBuild.blocks }
      : null;

    if (!incomingIdentity) {
      buildPendingRef.current.dirty = false;
      buildPendingRef.current.force = false;
      identityRef.current = null;
      activeJobRef.current.controller?.abort();
      activeJobRef.current.controller = null;
      activeJobRef.current.identity = null;
      clearVoxelGroup(three);
      return;
    }

    const identityChanged = !sameIdentity(identityRef.current, incomingIdentity);
    if (identityChanged) {
      identityRef.current = incomingIdentity;
      clearVoxelGroup(three);
    }

    const desiredBlocks = Math.max(0, latest.voxelBuild?.blocks.length ?? 0);
    const lastBuiltBlocks = Math.max(0, lastBuiltRef.current.blockLimit);
    const delta = desiredBlocks - lastBuiltBlocks;
    const now = performance.now();
    const elapsedSinceBuild = Math.max(0, now - lastBuiltRef.current.at);

    const force = buildPendingRef.current.force;
    const { minDelta, maxWaitMs } = computeRebuildThreshold(lastBuiltBlocks);
    const shouldBuild =
      !voxelGroupRef.current ||
      (desiredBlocks > lastBuiltBlocks && (force || delta >= minDelta || elapsedSinceBuild >= maxWaitMs));

    if (!shouldBuild) {
      if (force && voxelGroupRef.current && boundsRef.current) {
        fitView();
      }
      buildPendingRef.current.dirty = desiredBlocks > lastBuiltBlocks;
      buildPendingRef.current.force = false;
      return;
    }

    buildPendingRef.current.dirty = false;
    buildPendingRef.current.force = false;

    buildInProgressRef.current = true;
    const controller = new AbortController();
    activeJobRef.current.controller = controller;
    activeJobRef.current.identity = incomingIdentity;

    const blockLimit = desiredBlocks;
    // When the stream settles (no new blocks for a bit), we do a final refit so the camera matches
    // the default framing for the full build (instead of staying framed on an early partial chunk).
    const shouldFit = identityChanged || !voxelGroupRef.current || force;
    const previousRotationY = voxelGroupRef.current?.group.rotation.y ?? 0;
    const startHadGroup = Boolean(voxelGroupRef.current);
    const animate = Boolean(latest.animateIn && shouldFit);
    const paletteSnapshot = latest.paletteDefs;
    const buildSnapshot = latest.voxelBuild;

    try {
      const tex = await loadAtlasTexture();
      if (controller.signal.aborted) return;
      if (!sameIdentity(identityRef.current, incomingIdentity)) return;
      if (!buildSnapshot) return;

      const vg = await createVoxelGroupAsync(buildSnapshot, paletteSnapshot, tex, {
        signal: controller.signal,
        blockLimit,
      });

      if (controller.signal.aborted) {
        vg.dispose();
        return;
      }
      if (!sameIdentity(identityRef.current, incomingIdentity)) {
        vg.dispose();
        return;
      }

      if (revealRafRef.current) {
        window.cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }

      const old = voxelGroupRef.current;
      if (old) {
        three.scene.remove(old.group);
        old.dispose();
      }

      vg.group.rotation.y = previousRotationY;
      voxelGroupRef.current = vg;
      three.scene.add(vg.group);

      boundsRef.current = computeGroupBounds(vg.group);
      if (gridRef.current) {
        gridRef.current.position.y = boundsRef.current.box.min.y - 0.5;
      }
      if (shouldFit) {
        fitView();
      }
      onBuildReadyChangeRef.current?.(true);
      lastBuiltRef.current = { blockLimit, at: performance.now() };

      if (!animate) return;
      if (startHadGroup) return;

      const geometries: { geo: THREE.BufferGeometry; total: number }[] = [];
      vg.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const geo = child.geometry;
        if (!(geo instanceof THREE.BufferGeometry)) return;
        const total = geo.getIndex()?.count ?? geo.getAttribute("position")?.count ?? 0;
        if (total <= 0) return;
        geo.setDrawRange(0, 0);
        geometries.push({ geo, total });
      });

      if (geometries.length === 0) return;

      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const durationMs = reduceMotion ? 70 : 150;
      const start = performance.now();

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        for (const g of geometries) {
          const count = Math.floor((g.total * eased) / 3) * 3;
          g.geo.setDrawRange(0, count);
        }
        if (t < 1) {
          revealRafRef.current = window.requestAnimationFrame(tick);
        } else {
          revealRafRef.current = null;
        }
      };

      revealRafRef.current = window.requestAnimationFrame(tick);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.warn("VoxelViewer build failed", err);
    } finally {
      buildInProgressRef.current = false;
      if (activeJobRef.current.controller === controller) {
        activeJobRef.current.controller = null;
        activeJobRef.current.identity = null;
      }
      if (buildPendingRef.current.dirty) scheduleKick();
    }
  }, [clearVoxelGroup, fitView, scheduleKick]);

  kickBuildRef.current = () => {
    void kickBuild();
  };

  const requestBuild = useCallback((opts?: { force?: boolean }) => {
    buildPendingRef.current.dirty = true;
    if (opts?.force) buildPendingRef.current.force = true;

    if (settleTimerRef.current != null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }

    // After the stream goes quiet, force one final build so we land on the full payload.
    settleTimerRef.current = window.setTimeout(() => {
      buildPendingRef.current.dirty = true;
      buildPendingRef.current.force = true;
      scheduleKick();
    }, 650);

    scheduleKick();
  }, [scheduleKick]);

  useImperativeHandle(
    ref,
    () => ({
      hasBuild() {
        return Boolean(voxelGroupRef.current && threeRef.current);
      },
      captureFrame(opts) {
        const three = threeRef.current;
        const vg = voxelGroupRef.current;
        if (!three || !vg) return null;

        const { scene, camera, renderer, controls } = three;
        const previousY = vg.group.rotation.y;
        if (typeof opts?.rotationY === "number" && Number.isFinite(opts.rotationY)) {
          vg.group.rotation.y = opts.rotationY;
        }

        controls.update();
        renderer.render(scene, camera);

        const source = renderer.domElement;
        const width = Math.max(1, Math.floor(opts?.width ?? source.width));
        const height = Math.max(1, Math.floor(opts?.height ?? source.height));
        const frame = document.createElement("canvas");
        frame.width = width;
        frame.height = height;
        const ctx = frame.getContext("2d");
        if (!ctx) {
          if (typeof opts?.rotationY === "number" && Number.isFinite(opts.rotationY)) {
            vg.group.rotation.y = previousY;
            controls.update();
            renderer.render(scene, camera);
          }
          return null;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        // Preserve aspect ratio (avoid stretching) by cropping the source canvas to the target ratio.
        const srcW = source.width;
        const srcH = source.height;
        const dstW = width;
        const dstH = height;
        let sx = 0;
        let sy = 0;
        let sw = srcW;
        let sh = srcH;
        const srcAspect = srcW > 0 && srcH > 0 ? srcW / srcH : 1;
        const dstAspect = dstW > 0 && dstH > 0 ? dstW / dstH : 1;
        if (srcAspect > dstAspect) {
          // Too wide: crop left/right.
          sw = Math.max(1, Math.round(srcH * dstAspect));
          sx = Math.round((srcW - sw) / 2);
        } else if (srcAspect < dstAspect) {
          // Too tall: crop top/bottom.
          sh = Math.max(1, Math.round(srcW / dstAspect));
          sy = Math.round((srcH - sh) / 2);
        }
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dstW, dstH);

        if (typeof opts?.rotationY === "number" && Number.isFinite(opts.rotationY)) {
          vg.group.rotation.y = previousY;
          controls.update();
          renderer.render(scene, camera);
        }

        return frame;
      },
    }),
    []
  );

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {}
  }

  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;
    three.controls.mouseButtons.LEFT = dragMode === "pan" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    three.controls.touches.ONE = dragMode === "pan" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }, [dragMode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    // Keep the viewer bright/legible (avoid heavy fog/dark shading).

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(10, 8, 10);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // important: keep canvas css size in sync with the mount, otherwise we end up showing only a corner
    renderer.setSize(mount.clientWidth, mount.clientHeight, true);
    camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    camera.updateProjectionMatrix();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.7;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.enableRotate = true;
    controls.minDistance = 2;
    controls.maxDistance = 80;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.7;
    // Allow users to tilt up/down enough to see undersides, without letting the camera fully flip.
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    const onStart = () => {
      userInteractingRef.current = true;
    };
    const onEnd = () => {
      userInteractingRef.current = false;
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);

    const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x1a2330, 0.75);
    scene.add(hemi);

    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
    keyLight.position.set(6, 10, 8);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xcfe3ff, 0.5);
    fillLight.position.set(-8, 6, -6);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.22);
    rimLight.position.set(-10, 7, 10);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(160, 160, 0x2a2f3a, 0x161a22);
    grid.position.y = -0.5;
    scene.add(grid);
    gridRef.current = grid;
    applyGridTheme(grid, getViewerTheme());

    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      if (!gridRef.current) return;
      applyGridTheme(gridRef.current, getViewerTheme());
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    threeRef.current = { scene, camera, renderer, controls };

    let raf = 0;
    let last = performance.now();
    const render = (now: number) => {
      raf = window.requestAnimationFrame(render);
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      controls.update();

      const vg = voxelGroupRef.current;
      if (vg && autoRotateRef.current && !userInteractingRef.current) {
        vg.group.rotation.y += dt * 0.25;
      }
      renderer.render(scene, camera);
    };
    raf = window.requestAnimationFrame(render);

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fitView();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const onDblClick = () => fitView();
    const onContextMenu = (e: Event) => e.preventDefault();
    renderer.domElement.addEventListener("dblclick", onDblClick);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    const onFullscreenChange = () => {
      const el = containerRef.current;
      setIsFullscreen(Boolean(el && document.fullscreenElement === el));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      threeRef.current = null;
      mo.disconnect();
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
      controls.dispose();

      if (voxelGroupRef.current) {
        scene.remove(voxelGroupRef.current.group);
        voxelGroupRef.current.dispose();
        voxelGroupRef.current = null;
      }
      boundsRef.current = null;

      scene.remove(grid);
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) grid.material.forEach((m) => m.dispose());
      else grid.material.dispose();

      // Aggressively release the WebGL context when cycling through many viewers (mobile browsers are strict).
      try {
        renderer.forceContextLoss();
      } catch {}
      renderer.dispose();
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.remove();
      gridRef.current = null;
    };
  }, [fitView]);

  useEffect(() => {
    const job = activeJobRef.current;
    return () => {
      if (settleTimerRef.current != null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      job.controller?.abort();
      job.controller = null;
      job.identity = null;
    };
  }, []);

  useEffect(() => {
    const incomingIdentity: BuildIdentity | null = voxelBuild ? { palette, blocksRef: voxelBuild.blocks } : null;
    const activeIdentity = activeJobRef.current.identity;
    if (activeJobRef.current.controller && activeIdentity && !sameIdentity(activeIdentity, incomingIdentity)) {
      activeJobRef.current.controller.abort();
    }
    requestBuild();
  }, [voxelBuild, paletteDefs, animateIn, palette, requestBuild]);

  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;
    autoRotateRef.current = Boolean(autoRotate);
    three.controls.autoRotate = false;
  }, [autoRotate]);

  return (
    <div
      ref={containerRef}
      data-mb-voxel-viewer="true"
      className={`relative h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${dragMode === "pan" ? "cursor-move" : "cursor-grab active:cursor-grabbing"}`}
      tabIndex={0}
      onPointerDown={(e) => {
        containerRef.current?.focus();
      }}
      onBlur={() => {
        if (ctrlHeldRef.current) {
          ctrlHeldRef.current = false;
          setDragMode(dragModeBeforeCtrlRef.current);
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight") && !e.repeat) {
          ctrlHeldRef.current = true;
          dragModeBeforeCtrlRef.current = dragMode;
          setDragMode("pan");
        }
        if ((e.key === "r" || e.key === "R") && !e.repeat) {
          e.preventDefault();
          fitView();
        }
        if ((e.key === "f" || e.key === "F") && !e.repeat) {
          e.preventDefault();
          void toggleFullscreen();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight") {
          if (!ctrlHeldRef.current) return;
          ctrlHeldRef.current = false;
          setDragMode(dragModeBeforeCtrlRef.current);
        }
      }}
    >
      <div ref={mountRef} className="h-full w-full" />

      {showControls ? (
        <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5 sm:right-3 sm:top-3 sm:gap-2">
          <button
            aria-pressed={dragMode === "pan"}
            className={`mb-btn h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs ${dragMode === "pan" ? "mb-btn-primary" : "mb-btn-ghost"}`}
            onClick={() => setDragMode((m) => (m === "pan" ? "orbit" : "pan"))}
          >
            Pan <span className="hidden sm:inline"><span className="mb-kbd">Ctrl</span></span>
          </button>
          <button className="mb-btn mb-btn-ghost h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs" onClick={fitView}>
            Fit <span className="hidden sm:inline"><span className="mb-kbd">R</span></span>
          </button>
          <button className="mb-btn mb-btn-ghost h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs" onClick={() => void toggleFullscreen()}>
            {isFullscreen ? "Exit" : "Full"}{" "}
            <span className="hidden sm:inline"><span className="mb-kbd">F</span></span>
          </button>
        </div>
      ) : null}
    </div>
  );
});

VoxelViewer.displayName = "VoxelViewer";
