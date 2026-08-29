"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_MEDIA_EXPORT_PREFERENCE,
  type MediaExportFileType,
  type MediaExportFraming,
  type MediaExportPreference,
  type MediaExportQuality,
  readMediaExportPreference,
  writeMediaExportPreference,
} from "@/lib/sandbox/mediaExportPreference";

const QUALITY_OPTIONS: ReadonlyArray<{
  value: MediaExportQuality;
  label: string;
  detail: string;
}> = [
  { value: "standard", label: "Standard", detail: "GIF · quick sharing" },
  { value: "creator", label: "Creator", detail: "Full HD · 30 FPS" },
];

const FILE_TYPE_OPTIONS: ReadonlyArray<{
  value: MediaExportFileType;
  label: string;
  detail: string;
}> = [
  { value: "mp4", label: "MP4", detail: "Best quality" },
  { value: "gif", label: "GIF", detail: "Compatibility" },
];

const FRAMING_OPTIONS: ReadonlyArray<{
  value: MediaExportFraming;
  label: string;
  detail: string;
}> = [
  { value: "social-safe", label: "Social safe", detail: "TikTok & Reels" },
  { value: "full", label: "Full frame", detail: "Every pixel" },
];

function CreatorOptionGroup<T extends string>({
  legend,
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; detail: string }>;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-2 text-xs font-medium text-muted">{legend}</legend>
      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border/75">
        {options.map((option, index) => {
          const selected = value === option.value;
          return (
            <label key={option.value} className="cursor-pointer">
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />
              <span
                className={`flex min-h-14 flex-col justify-center px-3 py-2 text-center transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-accent/45 motion-reduce:transition-none ${
                  index > 0 ? "border-l border-border/75" : ""
                } ${selected ? "bg-fg text-bg" : "bg-transparent text-muted hover:text-fg"}`}
              >
                <span className="text-xs font-semibold">{option.label}</span>
                <span className={`mt-0.5 text-[10px] ${selected ? "text-bg/70" : "text-muted"}`}>
                  {option.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function MediaExportSettings() {
  const [preference, setPreference] = useState<MediaExportPreference>(
    DEFAULT_MEDIA_EXPORT_PREFERENCE,
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setPreference(readMediaExportPreference());
  }, []);

  function save(next: MediaExportPreference) {
    if (!writeMediaExportPreference(next)) {
      setSaveError("Couldn’t save on this device.");
      return;
    }
    setPreference(next);
    setSaveError(null);
  }

  const creator = preference.quality === "creator";

  return (
    <section
      className="rounded-md border border-border/80 bg-card/10 p-5"
      aria-labelledby="media-export-title"
    >
      <p className="mb-eyebrow">Exports</p>
      <h2 id="media-export-title" className="mt-2 text-lg font-semibold tracking-tight text-fg">
        Export quality
      </h2>
      <p className="mt-2 text-sm text-muted">Saved on this device.</p>

      <fieldset className="mt-5 space-y-2">
        <legend className="sr-only">Export quality</legend>
        {QUALITY_OPTIONS.map((option) => {
          const selected = preference.quality === option.value;
          return (
            <label key={option.value} className="block cursor-pointer">
              <input
                type="radio"
                name="media-export-quality"
                value={option.value}
                checked={selected}
                onChange={() => save({ ...preference, quality: option.value })}
                className="peer sr-only"
              />
              <span
                className={`flex min-h-14 items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] peer-focus-visible:ring-2 peer-focus-visible:ring-accent/45 motion-reduce:transition-none ${
                  selected
                    ? "border-accent/55 bg-accent/[0.07]"
                    : "border-border/75 hover:border-border hover:bg-card/25"
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{option.detail}</span>
                </span>
                <span
                  aria-hidden="true"
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-[background-color,border-color] duration-200 motion-reduce:transition-none ${
                    selected ? "border-accent bg-accent text-bg" : "border-border text-transparent"
                  }`}
                >
                  <svg
                    viewBox="0 0 20 20"
                    className={`h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                      selected ? "scale-100 opacity-100" : "scale-75 opacity-0"
                    }`}
                  >
                    <path
                      d="m5.25 10.25 3 3 6.5-6.5"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div
        className={`grid transition-[grid-template-rows,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:transition-none ${
          creator
            ? "grid-rows-[1fr] translate-y-0 opacity-100"
            : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-4 pt-4">
            <CreatorOptionGroup
              legend="Format"
              name="media-export-file-type"
              value={preference.fileType}
              options={FILE_TYPE_OPTIONS}
              disabled={!creator}
              onChange={(fileType) => save({ ...preference, fileType })}
            />
            <CreatorOptionGroup
              legend="Framing"
              name="media-export-framing"
              value={preference.framing}
              options={FRAMING_OPTIONS}
              disabled={!creator}
              onChange={(framing) => save({ ...preference, framing })}
            />
          </div>
        </div>
      </div>

      {saveError ? <p role="alert" className="mt-3 text-sm text-danger">{saveError}</p> : null}
    </section>
  );
}
