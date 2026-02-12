"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { createVoxelGroup, VoxelGroup } from "@/lib/voxel/mesh";
import type { VoxelBuild } from "@/lib/voxel/types";

type ViewerProps = {
  voxelBuild: VoxelBuild | null;
  palette: "simple" | "advanced";
  autoRotate?: boolean;
  animateIn?: boolean;
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

function computeBuildBounds(build: VoxelBuild, allowed: Set<string>): BuildBounds {
  const blocks = build.blocks.filter((b) => allowed.has(b.type));

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const b of blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxY = Math.max(maxY, b.y);
    maxZ = Math.max(maxZ, b.z);
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  const cx = (minX + maxX + 1) / 2;
  const cy = minY;
  const cz = (minZ + maxZ + 1) / 2;

  const box = new THREE.Box3(
    new THREE.Vector3(minX - cx, minY - cy, minZ - cz),
    new THREE.Vector3(maxX - cx + 1, maxY - cy + 1, maxZ - cz + 1)
  );

  const center = box.getCenter(new THREE.Vector3());

  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];

  let radius = 0.001;
  for (const p of corners) {
    radius = Math.max(radius, p.distanceTo(center));
  }

  return { box, center, radius };
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
  { voxelBuild, palette, autoRotate, animateIn },
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
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
  } | null>(null);

  type DragMode = "orbit" | "pan";
  const [dragMode, setDragMode] = useState<DragMode>("orbit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragModeBeforeSpaceRef = useRef<DragMode>("orbit");
  const spaceHeldRef = useRef(false);

  const paletteDefs: BlockDefinition[] = useMemo(() => getPalette(palette), [palette]);

  function fitView() {
    const three = threeRef.current;
    const vg = voxelGroupRef.current;
    const bounds = boundsRef.current;
    if (!three || !vg || !bounds) return;
    frameBounds(three.camera, three.controls, bounds);
    if (gridRef.current) {
      gridRef.current.position.y = bounds.box.min.y - 0.5;
    }
  }

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

      renderer.dispose();
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.remove();
      gridRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const three = threeRef.current;
    if (!three) return;
    void (async () => {
      const tex = await loadAtlasTexture();
      if (cancelled) return;

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

      if (!voxelBuild) return;

      const allowed = new Set(paletteDefs.map((p) => p.id));
      boundsRef.current = computeBuildBounds(voxelBuild, allowed);
      const vg = createVoxelGroup(voxelBuild, paletteDefs, tex);
      voxelGroupRef.current = vg;
      three.scene.add(vg.group);
      fitView();
      autoRotateRef.current = Boolean(autoRotate);

      if (!animateIn) return;

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

      const durationMs = 900;
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
    })();
    return () => {
      cancelled = true;
      if (revealRafRef.current) {
        window.cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
    };
  }, [voxelBuild, paletteDefs, autoRotate, animateIn]);

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
        if (spaceHeldRef.current) {
          spaceHeldRef.current = false;
          setDragMode(dragModeBeforeSpaceRef.current);
        }
      }}
      onKeyDown={(e) => {
        if (e.code === "Space" && !e.repeat) {
          e.preventDefault();
          spaceHeldRef.current = true;
          dragModeBeforeSpaceRef.current = dragMode;
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
        if (e.code === "Space") {
          if (!spaceHeldRef.current) return;
          spaceHeldRef.current = false;
          setDragMode(dragModeBeforeSpaceRef.current);
        }
      }}
    >
      <div ref={mountRef} className="h-full w-full" />

      <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5 sm:right-3 sm:top-3 sm:gap-2">
        <button
          aria-pressed={dragMode === "pan"}
          className={`mb-btn h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs ${dragMode === "pan" ? "mb-btn-primary" : "mb-btn-ghost"}`}
          onClick={() => setDragMode((m) => (m === "pan" ? "orbit" : "pan"))}
        >
          Pan <span className="hidden sm:inline"><span className="mb-kbd">Space</span></span>
        </button>
        <button className="mb-btn mb-btn-ghost h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs" onClick={fitView}>
          Fit <span className="hidden sm:inline"><span className="mb-kbd">R</span></span>
        </button>
        <button className="mb-btn mb-btn-ghost h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "Exit" : "Full"}{" "}
          <span className="hidden sm:inline"><span className="mb-kbd">F</span></span>
        </button>
      </div>
    </div>
  );
});

VoxelViewer.displayName = "VoxelViewer";
