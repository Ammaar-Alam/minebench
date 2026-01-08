"use client";

import { useEffect, useMemo, useRef } from "react";
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
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  controls.target.copy(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (camera.fov * Math.PI) / 180;
  const distance = maxDim / (2 * Math.tan(fov / 2));

  camera.position.set(center.x + distance * 1.2, center.y + distance * 0.9, center.z + distance * 1.2);
  camera.near = Math.max(0.05, distance / 100);
  camera.far = distance * 30;
  camera.updateProjectionMatrix();

  controls.update();
}

export function VoxelViewer({ voxelBuild, palette, autoRotate }: ViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const voxelGroupRef = useRef<VoxelGroup | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
  } | null>(null);

  const paletteDefs: BlockDefinition[] = useMemo(() => getPalette(palette), [palette]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070b, 0.035);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(10, 8, 10);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.7;
    controls.minDistance = 2;
    controls.maxDistance = 80;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.6;

    const stopAutoRotate = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener("start", stopAutoRotate);
    controls.addEventListener("end", stopAutoRotate);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(6, 10, 8);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9bb3ff, 0.35);
    fillLight.position.set(-8, 6, -6);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(24, 24, 0x2a2f3a, 0x161a22);
    grid.position.y = -0.5;
    scene.add(grid);

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

    return () => {
      threeRef.current = null;
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      controls.removeEventListener("start", stopAutoRotate);
      controls.removeEventListener("end", stopAutoRotate);
      controls.dispose();

      if (voxelGroupRef.current) {
        scene.remove(voxelGroupRef.current.group);
        voxelGroupRef.current.dispose();
        voxelGroupRef.current = null;
      }

      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const three = threeRef.current;
    if (!three) return;
    void (async () => {
      const tex = await loadAtlasTexture();
      if (cancelled) return;

      if (voxelGroupRef.current) {
        three.scene.remove(voxelGroupRef.current.group);
        voxelGroupRef.current.dispose();
        voxelGroupRef.current = null;
      }

      if (!voxelBuild) return;
      const vg = createVoxelGroup(voxelBuild, paletteDefs, tex);
      voxelGroupRef.current = vg;
      three.scene.add(vg.group);
      frameObject(three.camera, three.controls, vg.group);
    })();
    return () => {
      cancelled = true;
    };
  }, [voxelBuild, paletteDefs]);

  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;
    three.controls.autoRotate = Boolean(autoRotate);
  }, [autoRotate]);

  return <div ref={mountRef} className="h-full w-full" />;
}
