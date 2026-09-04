"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Upload } from "tus-js-client";

type BuildSlot = {
  resultId: string;
  prompt: string;
  status: string;
  error: string | null;
  uploadPending: boolean;
};

type UploadTarget = {
  bucket: string;
  path: string;
  endpoint: string;
  token: string;
};

type LocalState =
  | { kind: "uploading"; progress: number }
  | { kind: "error"; message: string };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Keep the stable fallback
  }
  return fallback;
}

function uploadBuild(
  file: File,
  target: UploadTarget,
  onProgress: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: target.endpoint,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
      headers: { "x-signature": target.token, "x-upsert": "true" },
      metadata: {
        bucketName: target.bucket,
        objectName: target.path,
        contentType: file.type || "application/json",
        cacheControl: "0",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onError: reject,
      onProgress: (uploaded, total) =>
        onProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0),
      onSuccess: () => resolve(),
    });
    void upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }, reject);
  });
}

function slotLabel(slot: BuildSlot, local?: LocalState): string {
  if (local?.kind === "uploading") return `Uploading ${local.progress}%`;
  if (local?.kind === "error") return "Needs attention";
  if (slot.status === "READY") return "Ready";
  if (slot.status === "FAILED") return "Needs attention";
  if (slot.uploadPending || slot.status === "GENERATING" || slot.status === "VALIDATING") {
    return "Processing";
  }
  return "Not uploaded";
}

export function CheckpointBuildUploads({
  slots,
  signUrl,
  queueAction,
}: {
  slots: BuildSlot[];
  signUrl: string;
  queueAction: (resultId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [local, setLocal] = useState<Record<string, LocalState>>({});

  async function chooseFile(slot: BuildSlot, file: File | undefined) {
    if (!file || file.size === 0) return;
    setLocal((current) => ({ ...current, [slot.resultId]: { kind: "uploading", progress: 0 } }));
    try {
      const response = await fetch(`${signUrl}/${encodeURIComponent(slot.resultId)}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response, "Upload unavailable"));
      const target = (await response.json()) as UploadTarget;
      await uploadBuild(file, target, (progress) => {
        setLocal((current) => ({
          ...current,
          [slot.resultId]: { kind: "uploading", progress },
        }));
      });
      const queued = await queueAction(slot.resultId);
      if (!queued.ok) throw new Error(queued.error);
      setLocal((current) => {
        const next = { ...current };
        delete next[slot.resultId];
        return next;
      });
      router.refresh();
    } catch (error) {
      setLocal((current) => ({
        ...current,
        [slot.resultId]: {
          kind: "error",
          message: error instanceof Error && error.message ? error.message : "Upload failed",
        },
      }));
    }
  }

  const ready = slots.filter((slot) => slot.status === "READY").length;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted">Upload one build for each prompt</p>
        <span className="font-mono text-xs tabular-nums text-fg">{ready}/{slots.length}</span>
      </div>
      <div className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/70">
        {slots.map((slot, index) => {
          const state = local[slot.resultId];
          const disabled =
            slot.status === "READY" ||
            (slot.status !== "FAILED" && slot.uploadPending) ||
            slot.status === "GENERATING" ||
            slot.status === "VALIDATING" ||
            state?.kind === "uploading";
          const message = state?.kind === "error" ? state.message : slot.error;
          return (
            <div key={slot.resultId} className="grid gap-3 px-4 py-3 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-center">
              <span className="font-mono text-[10px] tabular-nums text-muted2">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{slot.prompt}</p>
                <p className={`mt-1 text-xs ${message ? "text-danger" : "text-muted"}`}>
                  {message || slotLabel(slot, state)}
                </p>
              </div>
              <label
                className={`mb-btn min-h-10 px-4 text-xs ${disabled ? "cursor-not-allowed opacity-45" : "mb-btn-ghost cursor-pointer"}`}
              >
                <span>{slot.status === "FAILED" || state?.kind === "error" ? "Replace" : "Choose JSON"}</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={disabled}
                  className="sr-only"
                  aria-label={`Choose JSON for ${slot.prompt}`}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void chooseFile(slot, file);
                  }}
                />
              </label>
            </div>
          );
        })}
      </div>
      <p className="text-xs leading-5 text-muted">
        Interrupted uploads resume when you choose the same file. Processing continues after you leave.
      </p>
    </div>
  );
}
