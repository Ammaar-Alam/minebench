export type ConsistencyBand = "unknown" | "very-steady" | "steady" | "mixed" | "high-swing";

export function getConsistencyBand(consistency: number | null): ConsistencyBand {
  if (consistency == null) return "unknown";
  if (consistency >= 85) return "very-steady";
  if (consistency >= 72) return "steady";
  if (consistency >= 58) return "mixed";
  return "high-swing";
}

export function getConsistencyLabel(consistency: number | null): string {
  const band = getConsistencyBand(consistency);
  if (band === "unknown") return "Insufficient data";
  if (band === "very-steady") return "Very steady";
  if (band === "steady") return "Steady";
  if (band === "mixed") return "Mixed";
  return "High swing";
}
