"use client";

import { useEffect, useState } from "react";
import {
  isManagedRequestBodyField,
  MAX_CUSTOM_REQUEST_ENTRIES,
  type CustomRequestEntry,
} from "@/lib/ai/customProviderConfig";

function RequestEntriesEditor({
  label,
  addLabel,
  entries,
  defaults = [],
  managed = () => false,
  onChange,
  disabled,
}: {
  label: string;
  addLabel: string;
  entries: CustomRequestEntry[];
  defaults?: CustomRequestEntry[];
  managed?: (entry: CustomRequestEntry) => boolean;
  onChange: (entries: CustomRequestEntry[]) => void;
  disabled: boolean;
}) {
  const defaultNames = new Set(defaults.map((entry) => entry.name.toLowerCase()));
  const extraEntries = entries.filter((entry) => !defaultNames.has(entry.name.toLowerCase()));
  const updateExtras = (next: CustomRequestEntry[]) =>
    onChange([...entries.filter((entry) => defaultNames.has(entry.name.toLowerCase())), ...next]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted">{label}</div>
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-1 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          disabled={disabled || entries.length >= MAX_CUSTOM_REQUEST_ENTRIES}
          onClick={() => updateExtras([...extraEntries, { name: "", value: "" }])}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
          </svg>
          {addLabel}
        </button>
      </div>

      {defaults.length > 0 ? (
        <div className="flex flex-col gap-2">
          {defaults.map((entry) => {
            const override = entries.find((item) => item.name.toLowerCase() === entry.name.toLowerCase());
            const readOnly = managed(entry);
            return (
              <div key={entry.name} className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-2 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_2.75rem]">
                <input aria-label={`${label} ${entry.name} name`} className="mb-field col-start-1 row-start-1 h-10 min-w-0" value={entry.name} disabled />
                <input
                  aria-label={`${label} ${entry.name} value`}
                  className="mb-field col-start-1 row-start-2 h-10 min-w-0 sm:col-start-2 sm:row-start-1"
                  value={readOnly ? entry.value : override?.value ?? entry.value}
                  disabled={disabled || readOnly}
                  maxLength={16_384}
                  spellCheck={false}
                  onChange={(event) => onChange([
                    ...entries.filter((item) => item.name.toLowerCase() !== entry.name.toLowerCase()),
                    ...(event.target.value === entry.value ? [] : [{ name: entry.name, value: event.target.value }]),
                  ])}
                />
                <button
                  type="button"
                  aria-label={`Reset ${entry.name}`}
                  title="Reset"
                  className="col-start-2 row-span-2 row-start-1 inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted hover:text-fg disabled:opacity-30 sm:col-start-3 sm:row-span-1"
                  disabled={disabled || !override}
                  onClick={() => onChange(entries.filter((item) => item.name.toLowerCase() !== entry.name.toLowerCase()))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {extraEntries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="hidden grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_2.75rem] gap-2 px-0.5 text-[11px] font-medium text-muted sm:grid">
            <div>Name</div>
            <div>Value</div>
            <span aria-hidden="true" />
          </div>
          {extraEntries.map((entry, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-2 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_2.75rem]"
            >
              <input
                aria-label={`${label} ${index + 1} name`}
                className="mb-field col-start-1 row-start-1 h-10 min-w-0"
                value={entry.name}
                placeholder="Name"
                maxLength={128}
                disabled={disabled}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => updateExtras(extraEntries.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, name: event.target.value } : item
                ))}
              />
              <input
                aria-label={`${label} ${index + 1} value`}
                className="mb-field col-start-1 row-start-2 h-10 min-w-0 sm:col-start-2 sm:row-start-1"
                value={entry.value}
                placeholder="Value"
                maxLength={16_384}
                disabled={disabled}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => updateExtras(extraEntries.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item
                ))}
              />
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                title="Remove"
                className="col-start-2 row-span-2 row-start-1 inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted transition-colors hover:bg-fg/[0.05] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:col-start-3 sm:row-span-1"
                disabled={disabled}
                onClick={() => updateExtras(extraEntries.filter((_, itemIndex) => itemIndex !== index))}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
                  <path d="M3.5 4.5h9M6 2.75h4M5 6.5v5.25m3-5.25v5.25m3-5.25v5.25M4.25 4.5l.5 9h6.5l.5-9" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type RequestOverridesProfile = {
  headers: CustomRequestEntry[];
  body: CustomRequestEntry[];
};

type RequestPreview = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function previewValue(name: string, value: unknown): string {
  if (name === "output_config" && value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "format"),
    ));
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function RequestOverridesEditor({
  profile,
  previewBody,
  onChange,
  disabled = false,
}: {
  profile: RequestOverridesProfile;
  previewBody?: object;
  onChange: (profile: RequestOverridesProfile) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewKey = previewBody ? JSON.stringify(previewBody) : null;
  useEffect(() => {
    if (!open || !previewKey) return;
    const controller = new AbortController();
    setPreviewError(null);
    const timeout = setTimeout(() => {
      void fetch("/api/generate?preview=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: previewKey,
        signal: controller.signal,
      }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Request unavailable");
        if (!controller.signal.aborted) setPreview(data.request as RequestPreview);
      }).catch((error) => {
        if (!controller.signal.aborted) setPreviewError(error instanceof Error ? error.message : "Request unavailable");
      });
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [open, previewKey]);
  const count = [...profile.headers, ...profile.body].filter(
    (entry) => Boolean(entry.name.trim() || entry.value.trim()),
  ).length;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="mb-disclosure-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-medium text-fg">Headers &amp; body</span>
          <span className="truncate text-[11px] text-muted">
            {preview ? `${Object.keys(preview.headers).length + Object.keys(preview.body).length} fields` : count ? `${count} set` : "Optional"}
          </span>
        </span>
        <svg
          aria-hidden="true"
          className={`mb-disclosure-chevron h-3 w-3 shrink-0 text-muted ${open ? "is-open" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6.5L8 10.5L12 6.5" />
        </svg>
      </button>

      {open ? (
        <div className="mb-fade-in flex flex-col gap-5 pt-3">
          {previewError ? <p role="alert" className="text-xs text-danger">{previewError}</p> : null}
          {preview ? <div className="text-[11px] text-muted">{preview.method} {preview.url}</div> : null}
          <RequestEntriesEditor
            label="Headers"
            addLabel="Add header"
            entries={profile.headers}
            defaults={preview ? Object.entries(preview.headers).map(([name, value]) => ({ name, value })) : undefined}
            managed={(entry) => entry.value === "[hidden]"}
            onChange={(headers) => onChange({ ...profile, headers })}
            disabled={disabled}
          />
          <RequestEntriesEditor
            label="Body parameters"
            addLabel="Add parameter"
            entries={profile.body}
            defaults={preview ? Object.entries(preview.body).map(([name, value]) => ({ name, value: previewValue(name, value) })) : undefined}
            managed={(entry) => isManagedRequestBodyField(entry.name)}
            onChange={(body) => onChange({ ...profile, body })}
            disabled={disabled}
          />
          {preview ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Full request</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-fg/[0.04] p-3 text-[11px]">{JSON.stringify(preview, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
