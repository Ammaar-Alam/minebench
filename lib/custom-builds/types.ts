export const CUSTOM_BUILD_EXPORT_FORMATS = ["glb", "stl", "schem"] as const;

export type CustomBuildExportFormat = (typeof CUSTOM_BUILD_EXPORT_FORMATS)[number];

export type CustomBuildArtifactKind =
  | "build_json"
  | "preview_json"
  | "raw_text_debug"
  | CustomBuildExportFormat;

export type CustomBuildStorageEncoding = "identity" | "gzip";

export type CustomBuildArtifactFormat = "json.gz" | "json" | "txt" | CustomBuildExportFormat;

export type CustomBuildArtifactDescriptor = {
  kind: CustomBuildArtifactKind;
  format: CustomBuildArtifactFormat;
  contentType: string;
  fileExtension: string;
  storageFolder: "build" | "preview" | "debug" | "exports";
};
