export type SandboxGifExportLayoutFormat = "wide" | "vertical" | "single";

export type SandboxGifExportPanelGrid = {
  columns: number;
  rows: number;
  rowColumns: number[];
};

export function getSandboxGifExportPanelGrid(
  count: number,
  format: SandboxGifExportLayoutFormat,
): SandboxGifExportPanelGrid {
  const safeCount = Math.max(1, Math.min(4, Math.floor(count)));

  if (safeCount === 1 || format === "single") {
    return {
      columns: 1,
      rows: 1,
      rowColumns: [1],
    };
  }

  if (safeCount === 2 && format === "vertical") {
    return {
      columns: 1,
      rows: 2,
      rowColumns: [1, 1],
    };
  }

  if (safeCount === 2) {
    return {
      columns: 2,
      rows: 1,
      rowColumns: [2],
    };
  }

  return {
    columns: 2,
    rows: 2,
    rowColumns: [2, safeCount - 2],
  };
}
