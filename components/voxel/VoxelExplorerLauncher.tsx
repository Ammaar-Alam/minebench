"use client";

import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";

export type VoxelExplorerBuild = {
  id: string;
  model: string;
  prompt: string;
  blockCount: number;
  source: "benchmark" | "gallery" | "current";
  checksum: string | null;
  palette: "simple" | "advanced";
  voxelBuild: RenderableVoxelBuild;
};

type ExplorerRequest = {
  build: VoxelExplorerBuild;
  onContinue?: () => void;
  onExit?: () => void;
};

type ExplorerContextValue = {
  active: boolean;
  launch: (request: ExplorerRequest) => void;
};

const ExplorerContext = createContext<ExplorerContextValue | null>(null);
const VoxelExplorerOverlay = dynamic(
  () => import("@/components/voxel/VoxelExplorer").then((module) => module.VoxelExplorerOverlay),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[oklch(0.86_0.055_235)] text-sm font-semibold text-slate-800">
        Loading
      </div>
    ),
  },
);

export function VoxelExplorerProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<ExplorerRequest | null>(null);
  const [active, setActive] = useState<ExplorerRequest | null>(null);
  const launch = useCallback((request: ExplorerRequest) => setPending(request), []);
  const context = useMemo(() => ({ active: Boolean(active), launch }), [active, launch]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) dialog.showModal();
  }, [pending]);

  useEffect(() => {
    if (!active) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [active]);

  const continueToExplorer = () => {
    if (!pending) return;
    pending.onContinue?.();
    setActive(pending);
    setPending(null);
  };

  const exitExplorer = () => {
    active?.onExit?.();
    setActive(null);
  };

  return (
    <ExplorerContext.Provider value={context}>
      {children}
      {pending ? (
        <dialog
          ref={dialogRef}
          aria-labelledby="voxel-explorer-confirm-title"
          className="mb-dialog m-auto w-[min(28rem,calc(100%-2rem))] rounded-md border-0 bg-card p-0 text-fg ring-1 ring-border-xl backdrop:bg-bg/60 backdrop:backdrop-blur-sm"
          onCancel={(event) => {
            event.preventDefault();
            setPending(null);
          }}
          onClose={() => setPending(null)}
        >
          <div className="space-y-6 p-6 sm:p-7">
            <div>
              <p className="mb-eyebrow">Explorer</p>
              <h2
                id="voxel-explorer-confirm-title"
                className="mt-2 text-2xl font-semibold tracking-tight"
              >
                Explore this build?
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Step inside at block scale with keyboard and mouse.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                autoFocus
                className="mb-btn mb-btn-primary h-11"
                onClick={continueToExplorer}
              >
                Continue
              </button>
              <button type="button" className="mb-btn h-11" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
      {active ? <VoxelExplorerOverlay initialBuild={active.build} onExit={exitExplorer} /> : null}
    </ExplorerContext.Provider>
  );
}

export function useVoxelExplorerActive(): boolean {
  return useContext(ExplorerContext)?.active ?? false;
}

export function VoxelExplorerLaunchButton({
  build,
  onContinue,
  onExit,
}: ExplorerRequest) {
  const context = useContext(ExplorerContext);
  if (!context) return null;
  return (
    <button
      type="button"
      aria-label="Explore build"
      title="Explore build"
      className="mb-explorer-launch mb-btn mb-btn-ghost h-8 w-8 border border-border/70 bg-bg/55 p-0 text-muted shadow-sm backdrop-blur-sm hover:border-accent/60 hover:bg-accent/10 hover:text-fg"
      onClick={() => context.launch({ build, onContinue, onExit })}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-[18px] w-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7.5 7h9a4.5 4.5 0 0 1 4.3 3.2l1 3.4a3.4 3.4 0 0 1-5.7 3.3l-1.2-1.2a2 2 0 0 0-1.4-.6h-3a2 2 0 0 0-1.4.6l-1.2 1.2a3.4 3.4 0 0 1-5.7-3.3l1-3.4A4.5 4.5 0 0 1 7.5 7Z" />
        <path d="M7.5 10v4M5.5 12h4M16.5 11h.01M18.5 13h.01" />
      </svg>
    </button>
  );
}
