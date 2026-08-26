const voxels = [
  { x: 8, y: 36 },
  { x: 30, y: 24 },
  { x: 52, y: 36, accent: true },
  { x: 74, y: 20 },
  { x: 96, y: 34 },
];

export function GalleryBuildPlaceholder({ className = "" }: { className?: string }) {
  return (
    <div className={`grid place-items-center bg-card/15 ${className}`} aria-hidden="true">
      <svg viewBox="0 0 128 78" className="h-20 w-32" fill="none">
        {voxels.map((voxel) => (
          <g
            key={`${voxel.x}-${voxel.y}`}
            transform={`translate(${voxel.x} ${voxel.y})`}
            className={voxel.accent ? "text-accent/55" : "text-muted/35"}
            stroke="currentColor"
            strokeLinejoin="round"
          >
            <path d="M10 0 20 5.5 10 11 0 5.5Z" fill="currentColor" fillOpacity="0.06" />
            <path d="M0 5.5 10 11v11L0 16.5Z" fill="currentColor" fillOpacity="0.03" />
            <path d="m20 5.5-10 5.5v11l10-5.5Z" fill="currentColor" fillOpacity="0.1" />
          </g>
        ))}
      </svg>
    </div>
  );
}
