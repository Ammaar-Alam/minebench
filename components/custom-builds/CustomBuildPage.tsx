"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { readBuildVariantJson } from "@/lib/arena/clientBuildResponse";
import type { CustomBuildStatusPayload } from "@/lib/custom-builds/api";
import type { CustomBuildExportFormat } from "@/lib/custom-builds/types";
import type { VoxelBuild } from "@/lib/voxel/types";

const EXPORT_FORMATS: CustomBuildExportFormat[] = ["glb", "stl", "schem"];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatStatus(status: CustomBuildStatusPayload["status"]): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Building";
  if (status === "succeeded") return "Ready";
  if (status === "failed") return "Failed";
  return "Canceled";
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Google";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "minimax") return "MiniMax";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "xai") return "xAI";
  if (provider === "zai") return "Z.AI";
  if (provider === "qwen") return "Qwen";
  if (provider === "meta") return "Meta";
  if (provider === "custom") return "Custom API";
  return provider;
}

function statusTone(status: CustomBuildStatusPayload["status"]): string {
  if (status === "succeeded") return "border-success/35 bg-success/10 text-success";
  if (status === "failed" || status === "canceled") return "border-danger/35 bg-danger/10 text-danger";
  return "border-accent/35 bg-accent/10 text-accent";
}

function formatStage(stage: string | null, status: CustomBuildStatusPayload["status"]): string {
  if (status === "succeeded") return "Complete";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  if (!stage) return formatStatus(status);
  if (stage === "queued") return "Queued";
  if (stage === "generating") return "Building";
  return stage
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatGridSize(value: number): string {
  if (value <= 64) return "Small";
  if (value >= 512) return "Large";
  return "Standard";
}

function formatDuration(ms: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "Pending";
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatDate(value: string | null): string {
  if (!value) return "Pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Pending";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "Pending";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}KB`;
  return `${Math.round(value)}B`;
}

function warningsFromStatus(status: CustomBuildStatusPayload): string[] {
  const warnings = status.metrics.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);
}

function hasActiveWork(status: CustomBuildStatusPayload): boolean {
  if (status.status === "queued" || status.status === "running") return true;
  return Object.values(status.exports).some((entry) => entry.status === "queued" || entry.status === "running");
}

function artifactFor(status: CustomBuildStatusPayload, kind: string) {
  return status.artifacts.find((artifact) => artifact.kind === kind);
}

function CopyButton({
  text,
  label = "Copy",
  className,
  disabled,
}: {
  text: string;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1100);
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = text;
        el.setAttribute("readonly", "true");
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.focus();
        el.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(el);
        if (!ok) throw new Error("copy failed");
        setState("copied");
        window.setTimeout(() => setState("idle"), 1100);
      } catch {
        setState("error");
        window.setTimeout(() => setState("idle"), 1300);
      }
    }
  }

  return (
    <button
      type="button"
      className={cx("mb-btn mb-btn-ghost h-8 rounded-full px-3 text-xs", className)}
      disabled={disabled}
      onClick={copy}
    >
      <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
        <path
          d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2M6 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
      {state === "copied" ? "Copied" : state === "error" ? "Failed" : label}
    </button>
  );
}

function CustomBuildPreview({ status }: { status: CustomBuildStatusPayload }) {
  const previewArtifact = artifactFor(status, "preview_json");
  const [build, setBuild] = useState<VoxelBuild | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const artifactKey = previewArtifact ? `${previewArtifact.sha256}:${previewArtifact.downloadUrl}` : "";
  const previewUrl = previewArtifact?.downloadUrl ?? "";

  useEffect(() => {
    if (!previewUrl) {
      setBuild(null);
      setError(null);
      setLoading(false);
      return;
    }

    const abort = new AbortController();
    setLoading(true);
    setError(null);
    fetch(previewUrl, { cache: "no-store", signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || "Preview unavailable");
        }
        return readBuildVariantJson<VoxelBuild>(res);
      })
      .then((nextBuild) => {
        setBuild(nextBuild);
        setError(null);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setBuild(null);
        setError(err instanceof Error ? err.message : "Preview unavailable");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });

    return () => abort.abort();
  }, [artifactKey, previewUrl]);

  const buildError = status.status === "failed" ? status.error?.message ?? "Build failed." : error ?? undefined;
  const loadingMessage = formatStage(status.currentStage, status.status);

  return (
    <VoxelViewerCard
      title={status.model.displayName}
      subtitle={providerLabel(status.model.provider)}
      voxelBuild={build}
      gridSize={status.gridSize === 64 || status.gridSize === 512 ? status.gridSize : 256}
      isLoading={status.status === "queued" || status.status === "running" || loading}
      loadingMessage={loadingMessage}
      error={buildError}
      palette={status.palette === "advanced" ? "advanced" : "simple"}
      meshCacheKey={`${status.id}:${previewArtifact?.sha256 ?? status.status}`}
      animateIn={Boolean(build)}
    />
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-t border-border/55 py-2.5 text-sm first:border-t-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{value}</dd>
    </div>
  );
}

function Snippet({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-bg/45">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <CopyButton text={value} className="h-7 px-2.5 text-[11px]" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
        {value}
      </pre>
    </div>
  );
}

function ExportAction({
  format,
  status,
  requesting,
  onRequest,
}: {
  format: CustomBuildExportFormat;
  status: CustomBuildStatusPayload;
  requesting: boolean;
  onRequest: (format: CustomBuildExportFormat) => void;
}) {
  const entry = status.exports[format];
  const available = entry.status === "available" && entry.downloadUrl;
  const working = entry.status === "queued" || entry.status === "running";
  const failed = entry.status === "failed";
  const label = format === "schem" ? "Schem" : format.toUpperCase();

  if (available) {
    return (
      <a className="mb-btn mb-btn-ghost h-9 rounded-full px-3 text-xs" href={entry.downloadUrl}>
        {label}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cx(
        "mb-btn h-9 rounded-full px-3 text-xs disabled:cursor-not-allowed disabled:opacity-55",
        failed ? "mb-btn-danger" : "mb-btn-ghost",
      )}
      disabled={status.status !== "succeeded" || working || requesting}
      onClick={() => onRequest(format)}
    >
      {working || requesting ? "Working" : failed ? "Retry" : label}
    </button>
  );
}

function DownloadActions({
  status,
  onRequestExport,
  requestingExports,
}: {
  status: CustomBuildStatusPayload;
  onRequestExport: (format: CustomBuildExportFormat) => void;
  requestingExports: Set<CustomBuildExportFormat>;
}) {
  const buildArtifact = artifactFor(status, "build_json");
  const previewArtifact = artifactFor(status, "preview_json");

  return (
    <div className="mb-panel p-4 sm:p-5">
      <div className="mb-panel-inner space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="mb-eyebrow">Downloads</div>
            <div className="mt-1 text-xs text-muted">
              {buildArtifact ? formatBytes(buildArtifact.compressedByteSize ?? buildArtifact.byteSize) : "Pending"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {buildArtifact ? (
            <a className="mb-btn mb-btn-primary h-9 rounded-full px-3 text-xs" href={buildArtifact.downloadUrl}>
              JSON
            </a>
          ) : (
            <button className="mb-btn mb-btn-primary h-9 rounded-full px-3 text-xs opacity-55" disabled>
              JSON
            </button>
          )}
          {previewArtifact ? (
            <a className="mb-btn mb-btn-ghost h-9 rounded-full px-3 text-xs" href={previewArtifact.downloadUrl}>
              Preview
            </a>
          ) : null}
          {EXPORT_FORMATS.map((format) => (
            <ExportAction
              key={format}
              format={format}
              status={status}
              requesting={requestingExports.has(format)}
              onRequest={onRequestExport}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusPanel({
  status,
  pageUrl,
}: {
  status: CustomBuildStatusPayload;
  pageUrl: string;
}) {
  const warnings = warningsFromStatus(status);
  return (
    <div className="mb-panel p-4 sm:p-5">
      <div className="mb-panel-inner space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="mb-eyebrow">Status</div>
            <div className="mt-1 text-lg font-semibold text-fg">{formatStage(status.currentStage, status.status)}</div>
          </div>
          <span
            className={cx(
              "inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold",
              statusTone(status.status),
            )}
          >
            {formatStatus(status.status)}
          </span>
        </div>

        <dl>
          <InfoRow label="Model" value={status.model.displayName} />
          <InfoRow label="Provider" value={providerLabel(status.model.provider)} />
          <InfoRow label="Size" value={formatGridSize(status.gridSize)} />
          <InfoRow label="Palette" value={status.palette === "advanced" ? "Advanced" : "Simple"} />
          <InfoRow label="Blocks" value={status.metrics.blockCount?.toLocaleString() ?? "Pending"} />
          <InfoRow label="Time" value={formatDuration(status.metrics.generationTimeMs)} />
          <InfoRow label="Created" value={formatDate(status.createdAt)} />
          <InfoRow label="Finished" value={formatDate(status.completedAt)} />
        </dl>

        <div className="rounded-xl border border-border/70 bg-bg/45 p-3">
          <div className="mb-eyebrow">Prompt</div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">{status.prompt}</p>
        </div>

        {status.error ? (
          <div className="rounded-xl border border-danger/35 bg-danger/10 p-3 text-sm leading-relaxed text-danger">
            {status.error.message ?? "Build failed."}
          </div>
        ) : null}

        {warnings.length ? (
          <details className="rounded-xl border border-border/70 bg-bg/45 p-3 text-sm">
            <summary className="cursor-pointer select-none font-medium text-fg">Warnings ({warnings.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-muted">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-bg/45 px-3 py-2">
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{pageUrl}</div>
          <CopyButton text={pageUrl} label="Copy link" className="shrink-0" disabled={!pageUrl} />
        </div>
      </div>
    </div>
  );
}

export function CustomBuildPage({ initialStatus }: { initialStatus: CustomBuildStatusPayload }) {
  const [status, setStatus] = useState(initialStatus);
  const [pageUrl, setPageUrl] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [requestingExports, setRequestingExports] = useState<Set<CustomBuildExportFormat>>(() => new Set());
  const lastEventSeqRef = useRef(0);
  const activeWorkKey = useMemo(
    () => Object.entries(status.exports).map(([format, entry]) => `${format}:${entry.status}`).join("|"),
    [status.exports],
  );

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/custom-builds/${initialStatus.id}`, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || "Status unavailable");
    }
    const nextStatus = (await res.json()) as CustomBuildStatusPayload;
    setStatus(nextStatus);
    setRefreshError(null);
    return nextStatus;
  }, [initialStatus.id]);

  useEffect(() => {
    setPageUrl(window.location.href);
  }, []);

  useEffect(() => {
    if (!hasActiveWork(status)) return;

    const events = [
      "queued",
      "started",
      "retry",
      "provider_trace",
      "artifact_ready",
      "complete",
      "failed",
      "canceled",
      "export_queued",
      "export_started",
      "export_complete",
    ];
    const source = new EventSource(
      `/api/custom-builds/${status.id}/events?after=${encodeURIComponent(String(lastEventSeqRef.current))}`,
    );
    const handler = (event: MessageEvent) => {
      const seq = Number.parseInt(event.lastEventId, 10);
      if (Number.isFinite(seq) && seq > lastEventSeqRef.current) {
        lastEventSeqRef.current = seq;
      }
      void refresh().catch((err) => {
        setRefreshError(err instanceof Error ? err.message : "Status unavailable");
      });
    };
    for (const eventName of events) source.addEventListener(eventName, handler as EventListener);
    source.onerror = () => {
      source.close();
    };
    return () => {
      for (const eventName of events) source.removeEventListener(eventName, handler as EventListener);
      source.close();
    };
  }, [activeWorkKey, refresh, status]);

  useEffect(() => {
    if (!hasActiveWork(status)) return;
    const id = window.setInterval(() => {
      void refresh().catch((err) => {
        setRefreshError(err instanceof Error ? err.message : "Status unavailable");
      });
    }, 2500);
    return () => window.clearInterval(id);
  }, [activeWorkKey, refresh, status]);

  async function requestExport(format: CustomBuildExportFormat) {
    setRequestingExports((prev) => new Set(prev).add(format));
    try {
      const res = await fetch(`/api/custom-builds/${status.id}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formats: [format] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Export unavailable");
      }
      await refresh();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Export unavailable");
    } finally {
      setRequestingExports((prev) => {
        const next = new Set(prev);
        next.delete(format);
        return next;
      });
    }
  }

  const origin = pageUrl ? new URL(pageUrl).origin : "";
  const jsonCurl = origin
    ? `curl -L ${origin}/api/custom-builds/${status.id}/artifacts/json -o minebench-${status.id}.json.gz`
    : "";
  const eventsCurl = origin ? `curl -N ${origin}/api/custom-builds/${status.id}/events` : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href="/sandbox" className="mb-back-link" aria-label="Back to Sandbox">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 6 9 12l6 6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          </Link>
          <div>
            <div className="mb-eyebrow">Private build</div>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              {status.model.displayName}
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
              Custom prompts and generated outputs are stored under private links for download/export and aggregate
              usage stats.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="mb-btn mb-btn-ghost h-9 self-start rounded-full px-3 text-xs sm:self-auto"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>

      {refreshError ? (
        <div className="rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
          {refreshError}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section className="min-w-0">
          <CustomBuildPreview status={status} />
        </section>
        <aside className="flex min-w-0 flex-col gap-4">
          <StatusPanel status={status} pageUrl={pageUrl} />
          <DownloadActions status={status} onRequestExport={requestExport} requestingExports={requestingExports} />
        </aside>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {jsonCurl ? <Snippet label="Download" value={jsonCurl} /> : null}
        {eventsCurl ? <Snippet label="Events" value={eventsCurl} /> : null}
      </div>
    </div>
  );
}
