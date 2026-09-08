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
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; detail: string }>;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-2 text-xs font-medium text-muted">{legend}</legend>
      <div data-stretch="true" className="mb-choice-group mb-choice-group-compact w-full">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              aria-label={`${option.label}: ${option.detail}`}
              disabled={disabled}
              className="mb-choice-option mb-choice-option-stretch mb-choice-option-compact grid min-h-10 place-items-center text-center"
              onClick={() => onChange(option.value)}
            >
              <span className="text-xs">{option.label}</span>
            </button>
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
  const selectedQuality = QUALITY_OPTIONS.find((option) => option.value === preference.quality)
    ?? QUALITY_OPTIONS[0];

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

      <fieldset className="mt-5">
        <legend className="sr-only">Export quality</legend>
        <div data-stretch="true" className="mb-choice-group w-full">
          {QUALITY_OPTIONS.map((option) => {
            const selected = preference.quality === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                aria-label={`${option.label}: ${option.detail}`}
                className="mb-choice-option mb-choice-option-stretch grid min-h-11 place-items-center text-center"
                onClick={() => save({ ...preference, quality: option.value })}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">{selectedQuality.detail}</p>
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
              value={preference.fileType}
              options={FILE_TYPE_OPTIONS}
              disabled={!creator}
              onChange={(fileType) => save({ ...preference, fileType })}
            />
            <CreatorOptionGroup
              legend="Framing"
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
