"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

let atlasPromise: Promise<THREE.Texture> | null = null;

function loadAtlasTexture(): Promise<THREE.Texture> {
  if (atlasPromise) return atlasPromise;
  atlasPromise = new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load("/textures/atlas.png", resolve, undefined, reject);
  });
  return atlasPromise;
}

function frameObject(camera: THREE.PerspectiveCamera, controls: OrbitControls, obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  const center = sphere.center;
  const radius = Math.max(0.001, sphere.radius);

  controls.target.copy(center);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitHeight = radius / Math.sin(vFov / 2);
  const fitWidth = radius / Math.sin(hFov / 2);
  const distance = Math.max(fitHeight, fitWidth);

  const dir = new THREE.Vector3(1, 0.85, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, distance * 1.25);
  camera.near = Math.max(0.05, distance / 250);
  camera.far = Math.max(200, distance * 60);
  camera.updateProjectionMatrix();

  controls.minDistance = Math.max(0.5, distance * 0.12);
  controls.maxDistance = Math.max(40, distance * 14);

  controls.update();
  controls.saveState();

  return box;
}

export function VoxelViewer({ voxelBuild, palette, autoRotate, animateIn }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const voxelGroupRef = useRef<VoxelGroup | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const revealRafRef = useRef<number | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
  } | null>(null);

  const [spacePanning, setSpacePanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const paletteDefs: BlockDefinition[] = useMemo(() => getPalette(palette), [palette]);

  function fitView() {
    const three = threeRef.current;
    const vg = voxelGroupRef.current;
    if (!three || !vg) return;
    const box = frameObject(three.camera, three.controls, vg.group);
    if (gridRef.current) {
      gridRef.current.position.y = box.min.y - 0.5;
    }
  }

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
    renderer.setSize(mount.clientWidth, mount.clientHeight, false);
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
    controls.minDistance = 2;
    controls.maxDistance = 80;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.6;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    const stopAutoRotate = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener("start", stopAutoRotate);
    controls.addEventListener("end", stopAutoRotate);

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

    threeRef.current = { scene, camera, renderer, controls };

    let raf = 0;
    const render = () => {
      raf = window.requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
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
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      controls.removeEventListener("start", stopAutoRotate);
      controls.removeEventListener("end", stopAutoRotate);
      controls.dispose();

      if (voxelGroupRef.current) {
        scene.remove(voxelGroupRef.current.group);
        voxelGroupRef.current.dispose();
        voxelGroupRef.current = null;
      }

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

      if (!voxelBuild) return;
      const vg = createVoxelGroup(voxelBuild, paletteDefs, tex);
      voxelGroupRef.current = vg;
      three.scene.add(vg.group);
      fitView();
      three.controls.autoRotate = Boolean(autoRotate);

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
    three.controls.autoRotate = Boolean(autoRotate);
  }, [autoRotate]);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full ${spacePanning ? "cursor-move" : "cursor-grab active:cursor-grabbing"}`}
      tabIndex={0}
      onPointerDown={() => containerRef.current?.focus()}
      onBlur={() => {
        setSpacePanning(false);
        const three = threeRef.current;
        if (three) three.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      }}
      onKeyDown={(e) => {
        if (e.code === "Space" && !e.repeat) {
          e.preventDefault();
          setSpacePanning(true);
          const three = threeRef.current;
          if (three) three.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
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
          setSpacePanning(false);
          const three = threeRef.current;
          if (three) three.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        }
      }}
    >
      <div ref={mountRef} className="h-full w-full" />

      <div className="absolute right-3 top-3 flex items-center gap-2">
        <button className="mb-btn mb-btn-ghost h-9 px-3 text-xs" onClick={fitView}>
          Fit <span className="hidden sm:inline"><span className="mb-kbd">R</span></span>
        </button>
        <button className="mb-btn mb-btn-ghost h-9 px-3 text-xs" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "Exit" : "Full"}{" "}
          <span className="hidden sm:inline"><span className="mb-kbd">F</span></span>
        </button>
      </div>
    </div>
  );
}
