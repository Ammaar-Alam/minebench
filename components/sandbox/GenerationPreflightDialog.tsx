"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export function GenerationPreflightDialog({
  open,
  mode,
  message,
  signInHref,
  onContinue,
  onUseKey,
  onClose,
}: {
  open: boolean;
  mode: "free" | "save" | "key";
  message?: string;
  signInHref: string;
  onContinue: () => void;
  onUseKey: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="generation-preflight-title"
      className="mb-dialog m-auto w-[min(28rem,calc(100%-2rem))] rounded-md border-0 bg-card p-0 text-fg ring-1 ring-border-xl backdrop:bg-bg/60 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="space-y-6 p-6 sm:p-7">
        <div>
          <p className="mb-eyebrow">Generate</p>
          <h2 id="generation-preflight-title" className="mt-2 text-2xl font-semibold tracking-tight">
            {mode === "free"
              ? "Generate for free"
              : mode === "key"
                ? "Connect this model"
                : "Keep this build"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {mode === "free"
              ? "Sign in. No API key needed."
              : mode === "key"
                ? message ?? "Add the required API key to generate."
                : "Sign in to save it automatically."}
          </p>
        </div>
        {mode === "free" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Link href={signInHref} className="mb-btn mb-btn-primary h-11">Start free</Link>
            <button type="button" className="mb-btn h-11" onClick={onClose}>Not now</button>
          </div>
        ) : mode === "key" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="mb-btn mb-btn-primary h-11" onClick={onUseKey}>Add key</button>
            <button type="button" className="mb-btn h-11" onClick={onClose}>Not now</button>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <Link href={signInHref} className="mb-btn mb-btn-primary h-11">Sign in</Link>
            <button type="button" className="mb-btn h-11" onClick={onContinue}>Continue</button>
          </div>
        )}
      </div>
    </dialog>
  );
}
