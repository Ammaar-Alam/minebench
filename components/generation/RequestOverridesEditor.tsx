"use client";

import { useState } from "react";
import {
  MAX_CUSTOM_REQUEST_ENTRIES,
  type CustomRequestEntry,
} from "@/lib/ai/customProviderConfig";

function RequestEntriesEditor({
  label,
  addLabel,
  entries,
  onChange,
  disabled,
}: {
  label: string;
  addLabel: string;
  entries: CustomRequestEntry[];
  onChange: (entries: CustomRequestEntry[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted">{label}</div>
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-1 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          disabled={disabled || entries.length >= MAX_CUSTOM_REQUEST_ENTRIES}
          onClick={() => onChange([...entries, { name: "", value: "" }])}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
          </svg>
          {addLabel}
        </button>
      </div>

      {entries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="hidden grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_2.75rem] gap-2 px-0.5 text-[11px] font-medium text-muted sm:grid">
            <div>Name</div>
            <div>Value</div>
            <span aria-hidden="true" />
          </div>
          {entries.map((entry, index) => (
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
                onChange={(event) => onChange(entries.map((item, itemIndex) =>
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
                onChange={(event) => onChange(entries.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item
                ))}
              />
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                title="Remove"
                className="col-start-2 row-span-2 row-start-1 inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted transition-colors hover:bg-fg/[0.05] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:col-start-3 sm:row-span-1"
                disabled={disabled}
                onClick={() => onChange(entries.filter((_, itemIndex) => itemIndex !== index))}
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

export function RequestOverridesEditor({
  profile,
  onChange,
  disabled = false,
}: {
  profile: RequestOverridesProfile;
  onChange: (profile: RequestOverridesProfile) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = [...profile.headers, ...profile.body].filter(
    (entry) => Boolean(entry.name.trim() || entry.value.trim()),
  ).length;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-medium text-fg">Headers &amp; body</span>
          <span className="truncate text-[11px] text-muted">
            {count ? `${count} set` : "Optional"}
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
          <RequestEntriesEditor
            label="Headers"
            addLabel="Add header"
            entries={profile.headers}
            onChange={(headers) => onChange({ ...profile, headers })}
            disabled={disabled}
          />
          <RequestEntriesEditor
            label="Body parameters"
            addLabel="Add parameter"
            entries={profile.body}
            onChange={(body) => onChange({ ...profile, body })}
            disabled={disabled}
          />
        </div>
      ) : null}
    </div>
  );
}
