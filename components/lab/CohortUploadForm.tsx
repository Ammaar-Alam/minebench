"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";

type CohortUploadTarget = {
  bucket: string;
  path: string;
  signedUrl: string;
};

async function uploadCohortFile(
  file: File,
  target: CohortUploadTarget,
  onProgress: (percentage: number) => void,
): Promise<void> {
  const body = new FormData();
  body.append("cacheControl", "0");
  body.append("", file);
  onProgress(1);
  const response = await fetch(target.signedUrl, {
    method: "PUT",
    body,
  });
  if (!response.ok) {
    let message = "Upload failed";
    try {
      const json = (await response.json()) as { message?: unknown; error?: unknown };
      message = String(json.message ?? json.error ?? message);
    } catch {
      // keep the stable fallback
    }
    throw new Error(message);
  }
  onProgress(100);
}

export function CohortUploadForm({
  action,
  signUrl,
}: {
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  signUrl: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("cohortFile");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a cohort file");
      return;
    }

    setPending(true);
    setProgress(0);
    setError(null);
    try {
      const signed = await fetch(signUrl, { method: "POST" });
      const target = (await signed.json()) as CohortUploadTarget | { error?: string };
      if (!signed.ok || !("signedUrl" in target)) {
        throw new Error("error" in target && target.error ? target.error : "Upload unavailable");
      }
      await uploadCohortFile(file, target, setProgress);

      formData.delete("cohortFile");
      formData.set("cohortUploadBucket", target.bucket);
      formData.set("cohortUploadPath", target.path);
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error);
        setProgress(0);
        return;
      }
      form.reset();
      setProgress(0);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <label className="block max-w-sm space-y-2 text-sm font-medium text-fg">
        <span>Codename</span>
        <input name="codename" required maxLength={80} className="mb-field h-11" />
      </label>
      <label className="block space-y-2 text-sm font-medium text-fg">
        <span>Cohort file</span>
        <input
          name="cohortFile"
          type="file"
          required
          accept="application/json,.json"
          className="mb-field h-11 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg"
        />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="mb-btn mb-btn-primary min-h-11 px-5 text-sm disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? `Uploading ${progress}%` : "Upload"}
        </button>
      </div>
    </form>
  );
}
