"use client";

/**
 * top-level error boundary that replaces the entire <html> when the root
 * layout itself throws. keeps styling self-contained so it works even if
 * globals.css never loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1rem",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0b0f14",
          color: "#e8edf3",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            padding: "1.75rem",
            borderRadius: 18,
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.08)",
            textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
            MineBench is having a bad moment
          </h1>
          <p style={{ margin: "0.75rem 0 1.25rem", opacity: 0.75, fontSize: 14, lineHeight: 1.5 }}>
            Something went wrong at the root of the app. Reload to try again — if it keeps
            happening, the site may be under heavy load.
          </p>
          {error.digest ? (
            <p
              style={{
                margin: "0 0 1rem",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                opacity: 0.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              ref {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              appearance: "none",
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              color: "inherit",
              padding: "0.55rem 1.1rem",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
