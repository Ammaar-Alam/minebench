"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { createVoxelGroupAsync, VoxelGroup } from "@/lib/voxel/mesh";
import type { VoxelBuild } from "@/lib/voxel/types";

export type VoxelViewerBuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
  stageLabel?: string | null;
};

type ViewerProps = {
  voxelBuild: VoxelBuild | null;
  palette: "simple" | "advanced";
  expectedBlockCount?: number;
  meshCacheKey?: string | null;
  autoRotate?: boolean;
  animateIn?: boolean;
  showControls?: boolean;
  onBuildReadyChange?: (ready: boolean) => void;
  onBuildProgressChange?: (progress: VoxelViewerBuildProgress | null) => void;
  onBuildErrorChange?: (message: string | null) => void;
};

export type VoxelViewerHandle = {
  hasBuild: () => boolean;
  getRotationY: () => number | null;
  captureFrame: (opts?: {
    rotationY?: number;
    rotationOffsetY?: number;
    width?: number;
    height?: number;
    fit?: "cover" | "contain";
  }) => HTMLCanvasElement | null;
};

let atlasPromise: Promise<THREE.Texture> | null = null;
const EXPORT_RENDER_OVERSCAN = 1;
let viewerSpinPreference = true;
const viewerSpinPreferenceListeners = new Set<(enabled: boolean) => void>();
const MOBILE_DOUBLE_TAP_MS = 330;
const MOBILE_TAP_MAX_TRAVEL_PX = 14;
const MOBILE_DOUBLE_TAP_MAX_DISTANCE_PX = 34;

type ViewerTheme = "light" | "dark";
const REVEAL_ANIMATION_MIN_BLOCKS = Number.parseInt(
  process.env.NEXT_PUBLIC_VOXEL_REVEAL_ANIMATION_MIN_BLOCKS ?? "12000",
  10,
);

function getViewerTheme(): ViewerTheme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

function isMobileViewerEnv(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator?.userAgent?.toLowerCase() ?? "";
  if (/iphone|ipod|ipad|android|mobile/.test(ua)) return true;
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
}

function getViewerPixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio || 1;
  // 1.5x on mobile cuts fragment work ~30% vs 2x retina with no perceptible loss
  const cap = isMobileViewerEnv() ? 1.5 : 2;
  return Math.min(dpr, cap);
}

function hasPanModifier(event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
  return Boolean(event.ctrlKey || event.metaKey || event.shiftKey);
}

function isPanModifierKey(event: { key?: string; code?: string }): boolean {
  return (
    event.key === "Control" ||
    event.key === "Meta" ||
    event.key === "Shift" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight" ||
    event.code === "MetaLeft" ||
    event.code === "MetaRight" ||
    event.code === "ShiftLeft" ||
    event.code === "ShiftRight"
  );
}

function isTouchLikePointer(event: PointerEvent): boolean {
  return event.pointerType !== "mouse" || isMobileViewerEnv();
}

function setViewerSpinPreference(enabled: boolean) {
  if (viewerSpinPreference === enabled) return;
  viewerSpinPreference = enabled;
  viewerSpinPreferenceListeners.forEach((listener) => listener(enabled));
}

function toggleViewerSpinPreference() {
  setViewerSpinPreference(!viewerSpinPreference);
}

export function useVoxelViewerSpinPreference() {
  const [enabled, setEnabled] = useState(viewerSpinPreference);

  useEffect(() => {
    viewerSpinPreferenceListeners.add(setEnabled);
    return () => {
      viewerSpinPreferenceListeners.delete(setEnabled);
    };
  }, []);

  return enabled;
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
type RevealGeometry = { geo: THREE.BufferGeometry; total: number };

function computeBuildBounds(build: VoxelBuild, allowed: Set<string>, blockLimit: number): BuildBounds {
  const limit = Math.max(0, Math.min(build.blocks.length, Math.floor(blockLimit)));

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < limit; i += 1) {
    const b = build.blocks[i];
    if (!b || !allowed.has(b.type)) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxY = Math.max(maxY, b.y);
    maxZ = Math.max(maxZ, b.z);
  }

  if (!Number.isFinite(minX)) {
    const origin = new THREE.Vector3(0, 0, 0);
    return {
      box: new THREE.Box3(origin.clone(), origin.clone()),
      center: origin,
      radius: 0.001,
    };
  }

  const cx = (minX + maxX + 1) / 2;
  const cy = minY;
  const cz = (minZ + maxZ + 1) / 2;

  const box = new THREE.Box3(
    new THREE.Vector3(minX - cx, minY - cy, minZ - cz),
    new THREE.Vector3(maxX - cx + 1, maxY - cy + 1, maxZ - cz + 1),
  );

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

function normalizeExpectedBlockCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function computeRebuildThreshold(lastBuilt: number): { minDelta: number; maxWaitMs: number } {
  if (lastBuilt < 80_000) return { minDelta: 10_000, maxWaitMs: 750 };
  if (lastBuilt < 250_000) return { minDelta: 25_000, maxWaitMs: 1200 };
  if (lastBuilt < 900_000) return { minDelta: 80_000, maxWaitMs: 1850 };
  return { minDelta: 150_000, maxWaitMs: 2600 };
}

function computeBuildYieldAfterMs(blockCount: number): number {
  if (blockCount >= 4_000_000) return 16;
  if (blockCount >= 2_000_000) return 14;
  if (blockCount >= 900_000) return 12;
  if (blockCount >= 250_000) return 10;
  return 8;
}

function frameBounds(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  bounds: BuildBounds,
  opts?: { reserveMobileBottomChrome?: boolean },
) {
  const center = bounds.center;
  const radius = Math.max(0.001, bounds.radius);

  const size = bounds.box.getSize(new THREE.Vector3());
  const horiz = Math.max(0.001, Math.max(size.x, size.z));
  const tallness = size.y / horiz;
  // slightly more top-down by default (about +10%)
  const yBias = THREE.MathUtils.clamp((0.38 + tallness * 0.22) * 1.1, 0.38, 0.95);
  const reserveMobileBottomChrome = Boolean(opts?.reserveMobileBottomChrome && isMobileViewerEnv());
  const target = center.clone();
  if (reserveMobileBottomChrome) {
    target.y -= THREE.MathUtils.clamp(size.y * 0.08, radius * 0.04, radius * 0.16);
  }
  controls.target.copy(target);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitHeight = radius / Math.sin(vFov / 2);
  const fitWidth = radius / Math.sin(hFov / 2);
  const distance = Math.max(fitHeight, fitWidth);

  const dir = new THREE.Vector3(1, yBias, 1).normalize();
  // slightly closer default framing
  camera.position.copy(target).addScaledVector(dir, distance * (reserveMobileBottomChrome ? 1.22 : 1.1));
  camera.near = Math.max(0.05, distance / 250);
  camera.far = Math.max(200, distance * 60);
  camera.updateProjectionMatrix();
  camera.lookAt(target);

  controls.minDistance = Math.max(0.5, distance * 0.12);
  controls.maxDistance = Math.max(40, distance * 14);

  controls.update();
  controls.saveState();
}

function ViewerControlHint({ isPanMode, spinEnabled }: { isPanMode: boolean; spinEnabled: boolean }) {
  const itemClass = "inline-flex items-center gap-1.5 whitespace-nowrap";
  const desktopItemClass = "hidden items-center gap-1.5 whitespace-nowrap sm:inline-flex";
  const inputLabelClass = "text-fg/65";
  const dividerClass = "h-1 w-1 rounded-full bg-muted/[0.18]";
  const keyClass =
    "inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/40 bg-bg/40 px-1 font-mono text-[9px] font-semibold leading-none text-muted/70";
  const spinKeyClass = `${keyClass} ${
    spinEnabled ? "border-accent/20 bg-accent/[0.07] text-accent/75" : "text-muted/55"
  }`;

  return (
    <div className="pointer-events-none absolute bottom-[4.15rem] left-2.5 right-2.5 z-10 flex sm:bottom-3 sm:left-3 sm:right-auto">
      <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-border/40 bg-bg/[0.50] px-2.5 py-1 text-[10px] font-medium leading-none text-muted/70 backdrop-blur-sm sm:px-3">
        <span className={itemClass}>
          <span className={inputLabelClass}>Drag</span>
          <span>{isPanMode ? "Pan" : "Rotate"}</span>
        </span>
        <span className={dividerClass} aria-hidden="true" />
        <span className={desktopItemClass}>
          <span className={keyClass}>Ctrl</span>
          <span>Pan</span>
        </span>
        <span className={`${dividerClass} hidden sm:inline-flex`} aria-hidden="true" />
        <span className={itemClass}>
          <span className={`${inputLabelClass} sm:hidden`}>Pinch</span>
          <span className={`${inputLabelClass} hidden sm:inline`}>Scroll</span>
          <span>Zoom</span>
        </span>
        <span className={`${dividerClass} sm:hidden`} aria-hidden="true" />
        <span className={`${itemClass} sm:hidden`}>
          <span className={inputLabelClass}>Double tap</span>
          <span>Spin</span>
        </span>
        <span className="hidden h-1 w-1 rounded-full bg-muted/[0.18] sm:inline-flex" aria-hidden="true" />
        <span className={desktopItemClass}>
          <span className={spinKeyClass}>S</span>
          <span>{spinEnabled ? "Spin on" : "Spin off"}</span>
        </span>
      </div>
    </div>
  );
}

function collectRevealGeometries(group: THREE.Group): RevealGeometry[] {
  const geometries: RevealGeometry[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geo = child.geometry;
    if (!(geo instanceof THREE.BufferGeometry)) return;
    const total = geo.getIndex()?.count ?? geo.getAttribute("position")?.count ?? 0;
    if (total <= 0) return;
    geometries.push({ geo, total });
  });
  return geometries;
}

function applyRevealFraction(geometries: RevealGeometry[], fraction: number) {
  const clamped = THREE.MathUtils.clamp(fraction, 0, 1);
  for (const g of geometries) {
    const count = Math.floor((g.total * clamped) / 3) * 3;
    g.geo.setDrawRange(0, count);
  }
}

export const VoxelViewer = forwardRef<VoxelViewerHandle, ViewerProps>(function VoxelViewer(
  {
    voxelBuild,
    palette,
    expectedBlockCount,
    meshCacheKey,
    autoRotate,
    animateIn,
    showControls = true,
    onBuildReadyChange,
    onBuildProgressChange,
    onBuildErrorChange,
  },
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
  const onBuildProgressChangeRef = useRef<((progress: VoxelViewerBuildProgress | null) => void) | undefined>(
    undefined,
  );
  const onBuildErrorChangeRef = useRef<((message: string | null) => void) | undefined>(undefined);
  const requestRenderRef = useRef<(() => void) | null>(null);
  const exportRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tapStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
  } | null>(null);

  type DragMode = "orbit" | "pan";
  const [dragMode, setDragMode] = useState<DragMode>("orbit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supportsFullscreen, setSupportsFullscreen] = useState(false);
  const [panModifierHeld, setPanModifierHeld] = useState(false);
  const effectivePanMode = dragMode === "pan" || (dragMode === "orbit" && panModifierHeld);
  const spinPreferenceEnabled = useVoxelViewerSpinPreference();

  const paletteDefs: BlockDefinition[] = useMemo(() => getPalette(palette), [palette]);
  const latestRef = useRef<{
    voxelBuild: VoxelBuild | null;
    palette: "simple" | "advanced";
    paletteDefs: BlockDefinition[];
    animateIn: boolean;
    expectedBlockCount: number | null;
    meshCacheKey: string | null;
  }>({
    voxelBuild: null,
    palette,
    paletteDefs,
    animateIn: Boolean(animateIn),
    expectedBlockCount: normalizeExpectedBlockCount(expectedBlockCount),
    meshCacheKey: meshCacheKey?.trim() || null,
  });
  latestRef.current = {
    voxelBuild,
    palette,
    paletteDefs,
    animateIn: Boolean(animateIn),
    expectedBlockCount: normalizeExpectedBlockCount(expectedBlockCount),
    meshCacheKey: meshCacheKey?.trim() || null,
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
  const readyRef = useRef(false);

  const reportReady = useCallback((ready: boolean) => {
    if (readyRef.current === ready) return;
    readyRef.current = ready;
    onBuildReadyChangeRef.current?.(ready);
  }, []);

  const getCaptureCanvas = useCallback((width: number, height: number) => {
    const canvas = captureCanvasRef.current ?? document.createElement("canvas");
    captureCanvasRef.current = canvas;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return canvas;
  }, []);

  const getExportRenderer = useCallback(() => {
    const existing = exportRendererRef.current;
    if (existing) return existing;

    const canvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    exportCanvasRef.current = canvas;
    exportRendererRef.current = renderer;
    return renderer;
  }, []);

  useEffect(() => {
    onBuildReadyChangeRef.current = onBuildReadyChange;
  }, [onBuildReadyChange]);

  useEffect(() => {
    onBuildProgressChangeRef.current = onBuildProgressChange;
  }, [onBuildProgressChange]);

  useEffect(() => {
    onBuildErrorChangeRef.current = onBuildErrorChange;
  }, [onBuildErrorChange]);

  const fitView = useCallback(() => {
    const three = threeRef.current;
    const vg = voxelGroupRef.current;
    const bounds = boundsRef.current;
    if (!three || !vg || !bounds) return;
    frameBounds(three.camera, three.controls, bounds, { reserveMobileBottomChrome: showControls });
    if (gridRef.current) {
      gridRef.current.position.y = bounds.box.min.y - 0.5;
    }
    requestRenderRef.current?.();
  }, [showControls]);

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
    reportReady(false);
    onBuildProgressChangeRef.current?.(null);
    requestRenderRef.current?.();
  }, [reportReady]);

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
      onBuildErrorChangeRef.current?.(null);
      onBuildProgressChangeRef.current?.(null);
      clearVoxelGroup(three);
      return;
    }

    const identityChanged = !sameIdentity(identityRef.current, incomingIdentity);
    if (identityChanged) {
      identityRef.current = incomingIdentity;
    }

    const desiredBlocks = Math.max(0, latest.voxelBuild?.blocks.length ?? 0);
    const lastBuiltBlocks = identityChanged ? 0 : Math.max(0, lastBuiltRef.current.blockLimit);
    const delta = desiredBlocks - lastBuiltBlocks;
    const now = performance.now();
    const elapsedSinceBuild = Math.max(0, now - lastBuiltRef.current.at);

    const expectedBlocks = normalizeExpectedBlockCount(latest.expectedBlockCount);
    const requiredBlocks = expectedBlocks ?? desiredBlocks;
    const hasAllRequiredBlocks =
      expectedBlocks != null && desiredBlocks >= expectedBlocks;

    const force = buildPendingRef.current.force;
    const { minDelta, maxWaitMs } = computeRebuildThreshold(lastBuiltBlocks);
    const shouldBuild =
      identityChanged ||
      !voxelGroupRef.current ||
      (desiredBlocks > lastBuiltBlocks &&
        (force || delta >= minDelta || elapsedSinceBuild >= maxWaitMs || hasAllRequiredBlocks));

    if (!shouldBuild) {
      if (force && voxelGroupRef.current && boundsRef.current) {
        fitView();
      }
      // Even if we don't rebuild, ensure our "ready" signal stays false while we haven't reached
      // the expected block count (e.g. during stream hydration).
      reportReady(Boolean(voxelGroupRef.current && lastBuiltBlocks >= requiredBlocks));
      buildPendingRef.current.dirty = desiredBlocks > lastBuiltBlocks;
      buildPendingRef.current.force = false;
      return;
    }

    buildPendingRef.current.dirty = false;
    buildPendingRef.current.force = false;

    buildInProgressRef.current = true;
    reportReady(false);
    onBuildErrorChangeRef.current?.(null);
    onBuildProgressChangeRef.current?.({
      processedBlocks: 0,
      totalBlocks: Math.max(1, desiredBlocks),
      stageLabel: "Placing blocks",
    });
    const controller = new AbortController();
    activeJobRef.current.controller = controller;
    activeJobRef.current.identity = incomingIdentity;

    const blockLimit = desiredBlocks;
    // When the stream settles (no new blocks for a bit), we do a final refit so the camera matches
    // the default framing for the full build (instead of staying framed on an early partial chunk).
    const hadReachedRequired = requiredBlocks > 0 && lastBuiltBlocks >= requiredBlocks;
    const willReachRequired = requiredBlocks > 0 && blockLimit >= requiredBlocks;
    const shouldFit =
      identityChanged ||
      !voxelGroupRef.current ||
      force ||
      (willReachRequired && !hadReachedRequired);
    const previousRotationY = voxelGroupRef.current?.group.rotation.y ?? 0;
    const startHadGroup = Boolean(voxelGroupRef.current);
    const animate = Boolean(latest.animateIn && shouldFit);
    const paletteSnapshot = latest.paletteDefs;
    const buildSnapshot = latest.voxelBuild;
    const expectedSnapshot = latest.expectedBlockCount;
    const meshCacheKeySnapshot = latest.meshCacheKey;

    try {
      const tex = await loadAtlasTexture();
      if (controller.signal.aborted) return;
      if (!sameIdentity(identityRef.current, incomingIdentity)) return;
      if (!buildSnapshot) return;

      const vg = await createVoxelGroupAsync(buildSnapshot, paletteSnapshot, tex, {
        signal: controller.signal,
        blockLimit,
        cacheKey: meshCacheKeySnapshot,
        yieldAfterMs: computeBuildYieldAfterMs(blockLimit),
        onProgress(progress) {
          onBuildProgressChangeRef.current?.({
            processedBlocks: Math.max(0, Math.floor(progress.processedBlocks)),
            totalBlocks: Math.max(1, Math.floor(progress.totalBlocks)),
            stageLabel: progress.stageLabel ?? "Placing blocks",
          });
        },
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
      vg.group.rotation.y = previousRotationY;
      voxelGroupRef.current = vg;
      three.scene.add(vg.group);
      if (old) {
        three.scene.remove(old.group);
        old.dispose();
      }

      const allowed = new Set(paletteSnapshot.map((p) => p.id));
      boundsRef.current = vg.bounds ?? computeBuildBounds(buildSnapshot, allowed, blockLimit);
      if (gridRef.current) {
        gridRef.current.position.y = boundsRef.current.box.min.y - 0.5;
      }
      if (shouldFit) {
        fitView();
      }
      lastBuiltRef.current = { blockLimit, at: performance.now() };
      const expectedNow = normalizeExpectedBlockCount(expectedSnapshot);
      const desiredNow = Math.max(0, latestRef.current.voxelBuild?.blocks.length ?? 0);
      const requiredNow = expectedNow ?? desiredNow;
      requestRenderRef.current?.();

      const revealFromFraction =
        startHadGroup && blockLimit > lastBuiltBlocks
          ? THREE.MathUtils.clamp(lastBuiltBlocks / Math.max(1, blockLimit), 0.25, 0.94)
          : 0;
      const allowRevealAnimation =
        !Number.isFinite(REVEAL_ANIMATION_MIN_BLOCKS) ||
        REVEAL_ANIMATION_MIN_BLOCKS <= 0 ||
        blockLimit >= REVEAL_ANIMATION_MIN_BLOCKS;
      const reachedExplicitTarget =
        expectedNow != null && blockLimit >= expectedNow && desiredNow >= expectedNow;
      const shouldAnimateReveal =
        animate &&
        !reachedExplicitTarget &&
        allowRevealAnimation &&
        ((startHadGroup && blockLimit > lastBuiltBlocks) || (!startHadGroup && animate));

      if (shouldAnimateReveal) {
        const geometries = collectRevealGeometries(vg.group);
        if (geometries.length > 0) {
          applyRevealFraction(geometries, revealFromFraction);
          requestRenderRef.current?.();

          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const durationMs = reduceMotion
            ? 90
            : startHadGroup
              ? Math.min(420, Math.max(220, Math.round(180 + (1 - revealFromFraction) * 180)))
              : 150;
          const start = performance.now();

          await new Promise<void>((resolve) => {
            const tick = (now: number) => {
              if (controller.signal.aborted) {
                applyRevealFraction(geometries, 1);
                requestRenderRef.current?.();
                revealRafRef.current = null;
                resolve();
                return;
              }
              const t = Math.min(1, (now - start) / durationMs);
              const eased = 1 - Math.pow(1 - t, 3);
              const fraction = revealFromFraction + (1 - revealFromFraction) * eased;
              applyRevealFraction(geometries, fraction);
              onBuildProgressChangeRef.current?.({
                processedBlocks: Math.max(1, Math.round(blockLimit * fraction)),
                totalBlocks: Math.max(1, blockLimit),
                stageLabel: "Revealing build",
              });
              requestRenderRef.current?.();
              if (t < 1) {
                revealRafRef.current = window.requestAnimationFrame(tick);
              } else {
                revealRafRef.current = null;
                resolve();
              }
            };

            revealRafRef.current = window.requestAnimationFrame(tick);
          });
        }
      }

      onBuildProgressChangeRef.current?.(null);
      onBuildErrorChangeRef.current?.(null);
      reportReady(Boolean(requiredNow <= 0 || (blockLimit >= requiredNow && desiredNow >= requiredNow)));
      requestRenderRef.current?.();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.warn("VoxelViewer build failed", err);
      onBuildErrorChangeRef.current?.(
        err instanceof Error && err.message.trim() ? err.message.trim() : "Build placement failed.",
      );
      reportReady(false);
    } finally {
      buildInProgressRef.current = false;
      if (activeJobRef.current.controller === controller) {
        activeJobRef.current.controller = null;
        activeJobRef.current.identity = null;
      }
      onBuildProgressChangeRef.current?.(null);
      if (buildPendingRef.current.dirty) scheduleKick();
    }
  }, [clearVoxelGroup, fitView, reportReady, scheduleKick]);

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
      getRotationY() {
        return voxelGroupRef.current?.group.rotation.y ?? null;
      },
      captureFrame(opts) {
        const three = threeRef.current;
        const vg = voxelGroupRef.current;
        if (!three || !vg) return null;

        const { scene, camera, renderer, controls } = three;
        const previousY = vg.group.rotation.y;
        const absoluteRotationY =
          typeof opts?.rotationY === "number" && Number.isFinite(opts.rotationY) ? opts.rotationY : null;
        const rotationOffsetY =
          typeof opts?.rotationOffsetY === "number" && Number.isFinite(opts.rotationOffsetY)
            ? opts.rotationOffsetY
            : null;
        const hasExportRotation = absoluteRotationY !== null || rotationOffsetY !== null;
        if (absoluteRotationY !== null) {
          vg.group.rotation.y = absoluteRotationY;
        } else if (rotationOffsetY !== null) {
          vg.group.rotation.y = previousY + rotationOffsetY;
        }

        controls.update();
        const source = renderer.domElement;
        const width = Math.max(1, Math.floor(opts?.width ?? source.width));
        const height = Math.max(1, Math.floor(opts?.height ?? source.height));
        const frame = getCaptureCanvas(width, height);
        frame.width = width;
        frame.height = height;
        const ctx = frame.getContext("2d");
        if (!ctx) {
          if (hasExportRotation) {
            vg.group.rotation.y = previousY;
            controls.update();
            renderer.render(scene, camera);
          }
          return null;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const srcW = source.width;
        const srcH = source.height;
        const dstW = width;
        const dstH = height;
        const srcAspect = srcW > 0 && srcH > 0 ? srcW / srcH : camera.aspect || 1;
        const dstAspect = dstW > 0 && dstH > 0 ? dstW / dstH : 1;
        const fitMode = opts?.fit ?? "cover";

        if (fitMode === "contain") {
          const drawWidth =
            dstAspect > srcAspect ? Math.max(1, Math.round(dstH * srcAspect)) : dstW;
          const drawHeight =
            dstAspect > srcAspect ? dstH : Math.max(1, Math.round(dstW / srcAspect));
          const needsHighResSource = srcW < drawWidth || srcH < drawHeight;
          let sourceCanvas: HTMLCanvasElement = source;
          if (needsHighResSource) {
            const exportRenderer = getExportRenderer();
            exportRenderer.setSize(drawWidth, drawHeight, false);
            exportRenderer.render(scene, camera);
            sourceCanvas = exportRenderer.domElement;
          } else {
            renderer.render(scene, camera);
          }

          ctx.clearRect(0, 0, dstW, dstH);
          ctx.drawImage(
            sourceCanvas,
            0,
            0,
            sourceCanvas.width,
            sourceCanvas.height,
            Math.round((dstW - drawWidth) / 2),
            Math.round((dstH - drawHeight) / 2),
            drawWidth,
            drawHeight,
          );
        } else {
          let cropWidth = srcW;
          let cropHeight = srcH;
          if (srcAspect > dstAspect) {
            cropWidth = Math.max(1, Math.round(srcH * dstAspect));
          } else if (srcAspect < dstAspect) {
            cropHeight = Math.max(1, Math.round(srcW / dstAspect));
          }

          const needsHighResSource = cropWidth < dstW || cropHeight < dstH;
          let sourceCanvas: HTMLCanvasElement = source;
          if (needsHighResSource) {
            const exportRenderer = getExportRenderer();
            let renderWidth = dstW;
            let renderHeight = dstH;
            if (srcAspect > dstAspect) {
              renderHeight = Math.max(1, Math.round(dstH * EXPORT_RENDER_OVERSCAN));
              renderWidth = Math.max(dstW, Math.ceil(renderHeight * srcAspect));
            } else {
              renderWidth = Math.max(1, Math.round(dstW * EXPORT_RENDER_OVERSCAN));
              renderHeight = Math.max(dstH, Math.ceil(renderWidth / srcAspect));
            }
            exportRenderer.setSize(renderWidth, renderHeight, false);
            exportRenderer.render(scene, camera);
            sourceCanvas = exportRenderer.domElement;
          } else {
            renderer.render(scene, camera);
          }

          const exportSrcW = sourceCanvas.width;
          const exportSrcH = sourceCanvas.height;
          let sx = 0;
          let sy = 0;
          let sw = exportSrcW;
          let sh = exportSrcH;
          const exportAspect = exportSrcW > 0 && exportSrcH > 0 ? exportSrcW / exportSrcH : srcAspect;
          if (exportAspect > dstAspect) {
            // Too wide: crop left/right.
            sw = Math.max(1, Math.round(exportSrcH * dstAspect));
            sx = Math.round((exportSrcW - sw) / 2);
          } else if (exportAspect < dstAspect) {
            // Too tall: crop top/bottom.
            sh = Math.max(1, Math.round(exportSrcW / dstAspect));
            sy = Math.round((exportSrcH - sh) / 2);
          }
          ctx.clearRect(0, 0, dstW, dstH);
          ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, dstW, dstH);
        }

        if (hasExportRotation) {
          vg.group.rotation.y = previousY;
          controls.update();
          renderer.render(scene, camera);
        }

        return frame;
      },
    }),
    [getCaptureCanvas, getExportRenderer]
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
    const el = containerRef.current;
    setSupportsFullscreen(
      Boolean(
        document.fullscreenEnabled &&
          el &&
          typeof (el as HTMLElement & { requestFullscreen?: () => Promise<void> }).requestFullscreen === "function",
      ),
    );
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    // Keep the viewer bright/legible (avoid heavy fog/dark shading).

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(10, 8, 10);

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    // mobile retina is much more fragment-shader bound; cap lower to keep memory + frame time down
    renderer.setPixelRatio(getViewerPixelRatio());
    // important: keep canvas css size in sync with the mount, otherwise we end up showing only a corner
    renderer.setSize(mount.clientWidth, mount.clientHeight, true);
    camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    camera.updateProjectionMatrix();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const syncRendererSize = () => {
      // mobile retina is much more fragment-shader bound; cap lower to keep memory + frame time down
    renderer.setPixelRatio(getViewerPixelRatio());
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w > 0 && h > 0) {
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    };
    syncRendererSize();

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
      if (autoRotateRef.current) requestRenderRef.current?.();
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
      requestRenderRef.current?.();
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    threeRef.current = { scene, camera, renderer, controls };

    let raf = 0;
    let rendering = false;
    let last = performance.now();
    const render = (now: number) => {
      rendering = true;
      raf = 0;
      let needsFollowupFrame = false;
      try {
        const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
        last = now;
        const controlsChanged = (controls.update() as boolean | void) === true;

        const vg = voxelGroupRef.current;
        const shouldAutoRotate = Boolean(
          vg && autoRotateRef.current && !userInteractingRef.current,
        );
        if (vg && shouldAutoRotate) {
          vg.group.rotation.y += dt * 0.25;
        }
        renderer.render(scene, camera);
        needsFollowupFrame = Boolean(controlsChanged || shouldAutoRotate);
      } finally {
        rendering = false;
      }
      if (needsFollowupFrame) requestRender();
    };
    const requestRender = () => {
      if (raf !== 0 || rendering) return;
      raf = window.requestAnimationFrame(render);
    };
    requestRenderRef.current = requestRender;
    requestRender();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      syncRendererSize();
      fitView();
      requestRender();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const onPointerDownForTap = (e: PointerEvent) => {
      if (!isTouchLikePointer(e) || e.isPrimary === false) return;
      tapStartRef.current = { x: e.clientX, y: e.clientY, at: performance.now() };
    };
    const onPointerUpForTap = (e: PointerEvent) => {
      if (!isTouchLikePointer(e) || e.isPrimary === false) return;
      const now = performance.now();
      const start = tapStartRef.current;
      tapStartRef.current = null;
      if (!start) return;

      const travel = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (travel > MOBILE_TAP_MAX_TRAVEL_PX || now - start.at > MOBILE_DOUBLE_TAP_MS) {
        lastTapRef.current = null;
        return;
      }

      const previousTap = lastTapRef.current;
      const distanceFromPrevious = previousTap
        ? Math.hypot(e.clientX - previousTap.x, e.clientY - previousTap.y)
        : Number.POSITIVE_INFINITY;
      const isDoubleTap =
        previousTap != null &&
        now - previousTap.at <= MOBILE_DOUBLE_TAP_MS &&
        distanceFromPrevious <= MOBILE_DOUBLE_TAP_MAX_DISTANCE_PX;
      if (!isDoubleTap) {
        lastTapRef.current = { x: e.clientX, y: e.clientY, at: now };
        return;
      }

      e.preventDefault();
      lastTapRef.current = null;
      toggleViewerSpinPreference();
      requestRender();
    };
    const onDblClick = () => {
      if (isMobileViewerEnv()) return;
      fitView();
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    renderer.domElement.addEventListener("pointerdown", onPointerDownForTap);
    renderer.domElement.addEventListener("pointerup", onPointerUpForTap);
    renderer.domElement.addEventListener("dblclick", onDblClick);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    controls.addEventListener("change", requestRender);

    const onFullscreenChange = () => {
      const el = containerRef.current;
      setIsFullscreen(Boolean(el && document.fullscreenElement === el));
      requestRender();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      threeRef.current = null;
      mo.disconnect();
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      requestRenderRef.current = null;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
      controls.removeEventListener("change", requestRender);
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
      if (exportRendererRef.current) {
        try {
          exportRendererRef.current.forceContextLoss();
        } catch {}
        exportRendererRef.current.dispose();
        exportRendererRef.current = null;
      }
      exportCanvasRef.current = null;
      captureCanvasRef.current = null;
      tapStartRef.current = null;
      lastTapRef.current = null;
      renderer.domElement.removeEventListener("pointerdown", onPointerDownForTap);
      renderer.domElement.removeEventListener("pointerup", onPointerUpForTap);
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
  }, [voxelBuild, paletteDefs, animateIn, palette, expectedBlockCount, meshCacheKey, requestBuild]);

  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;
    autoRotateRef.current = Boolean(autoRotate && spinPreferenceEnabled);
    three.controls.autoRotate = false;
    if (autoRotate) requestRenderRef.current?.();
  }, [autoRotate, spinPreferenceEnabled]);

  const controlButtonClass =
    "mb-btn h-11 flex-1 gap-1.5 rounded-lg px-3 text-[12px] leading-none sm:h-8 sm:flex-none sm:px-2.5 sm:text-[11px]";
  const controlGhostClass = `${controlButtonClass} ring-1 ring-border/60 bg-bg/[0.46] text-fg/85 hover:bg-bg/[0.64] hover:ring-border/80`;
  const controlActiveClass = `${controlButtonClass} ring-1 ring-border/75 bg-card/65 text-fg hover:bg-card/80 hover:ring-border`;
  const controlKeyClass =
    "hidden h-5 min-w-5 items-center justify-center rounded-md border border-border/55 bg-bg/45 px-1.5 font-mono text-[10px] font-semibold leading-none text-muted/75 sm:inline-flex";
  const activeControlKeyClass = `${controlKeyClass} border-border/60 bg-bg/55 text-fg/80`;

  return (
    <div
      ref={containerRef}
      data-mb-voxel-viewer="true"
      className={`relative h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${effectivePanMode ? "cursor-move" : "cursor-grab active:cursor-grabbing"}`}
      tabIndex={0}
      onPointerEnter={(e) => {
        setPanModifierHeld(hasPanModifier(e));
      }}
      onPointerDown={(e) => {
        setPanModifierHeld(hasPanModifier(e));
        containerRef.current?.focus();
      }}
      onPointerMove={(e) => {
        setPanModifierHeld(hasPanModifier(e));
      }}
      onPointerLeave={() => {
        setPanModifierHeld(false);
      }}
      onBlur={() => {
        setPanModifierHeld(false);
      }}
      onKeyDown={(e) => {
        // OrbitControls already maps modifier+left-drag to pan when LEFT is ROTATE.
        // Flipping dragMode here inverts back to rotate due its modifier behavior.
        if (isPanModifierKey(e)) {
          setPanModifierHeld(hasPanModifier(e));
        }
        if ((e.key === "r" || e.key === "R") && !e.repeat) {
          e.preventDefault();
          fitView();
        }
        if ((e.key === "f" || e.key === "F") && !e.repeat) {
          e.preventDefault();
          void toggleFullscreen();
        }
        if ((e.key === "s" || e.key === "S") && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          toggleViewerSpinPreference();
          requestRenderRef.current?.();
        }
      }}
      onKeyUp={(e) => {
        if (isPanModifierKey(e)) setPanModifierHeld(hasPanModifier(e));
      }}
    >
      <div ref={mountRef} className="h-full w-full" />

      {showControls ? (
        <>
          <ViewerControlHint isPanMode={effectivePanMode} spinEnabled={Boolean(autoRotate && spinPreferenceEnabled)} />
          <div className="absolute inset-x-2.5 bottom-2 flex items-center gap-1 rounded-xl border border-border/60 bg-bg/65 p-1 backdrop-blur-md sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:gap-1.5 sm:rounded-full sm:border-transparent sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-0">
            <button
              aria-pressed={effectivePanMode}
              aria-label={effectivePanMode ? "Switch to rotate mode" : "Switch to pan mode"}
              className={effectivePanMode ? controlActiveClass : controlGhostClass}
              onClick={() => setDragMode((m) => (m === "pan" ? "orbit" : "pan"))}
            >
              <span>Pan</span>
              <span className={effectivePanMode ? activeControlKeyClass : controlKeyClass}>Ctrl</span>
            </button>
            <button
              aria-label="Reset camera framing"
              className={controlGhostClass}
              onClick={fitView}
            >
              <span>Reset</span>
              <span className={controlKeyClass}>R</span>
            </button>
            {supportsFullscreen || isFullscreen ? (
              <button
                aria-label={isFullscreen ? "Exit fullscreen" : "Open fullscreen"}
                className={controlGhostClass}
                onClick={() => void toggleFullscreen()}
              >
                <span>{isFullscreen ? "Exit" : "Expand"}</span>
                <span className={controlKeyClass}>F</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
});

VoxelViewer.displayName = "VoxelViewer";
