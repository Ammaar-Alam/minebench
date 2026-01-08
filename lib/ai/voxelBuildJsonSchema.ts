export const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build";

export function makeVoxelBuildJsonSchema(params: {
  gridSize: number;
  minBlocks: number;
  maxBlocks: number;
}) {
  const maxCoord = Math.max(0, Math.floor(params.gridSize) - 1);
  const minBlocks = Math.max(1, Math.floor(params.minBlocks));
  const maxBlocks = Math.max(minBlocks, Math.floor(params.maxBlocks));

  return {
    type: "object",
    properties: {
      version: { type: "string", enum: ["1.0"] },
      blocks: {
        type: "array",
        minItems: minBlocks,
        maxItems: maxBlocks,
        items: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0, maximum: maxCoord },
            y: { type: "integer", minimum: 0, maximum: maxCoord },
            z: { type: "integer", minimum: 0, maximum: maxCoord },
            type: { type: "string", minLength: 1 },
          },
          required: ["x", "y", "z", "type"],
          additionalProperties: false,
        },
      },
    },
    required: ["version", "blocks"],
    additionalProperties: false,
  } as const;
}

