export const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build";

export function makeVoxelBuildJsonSchema(params: {
  gridSize: number;
  minBlocks: number;
  maxBlocks: number;
}) {
  const maxCoord = Math.max(0, Math.floor(params.gridSize) - 1);
  // allow primitives to generate most blocks; blocks array can be used for fine details
  const minBlocks = 1;
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
      // Efficient primitives to avoid gaps and reduce token usage.
      // These are expanded into blocks server-side.
      boxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            x1: { type: "integer", minimum: 0, maximum: maxCoord },
            y1: { type: "integer", minimum: 0, maximum: maxCoord },
            z1: { type: "integer", minimum: 0, maximum: maxCoord },
            x2: { type: "integer", minimum: 0, maximum: maxCoord },
            y2: { type: "integer", minimum: 0, maximum: maxCoord },
            z2: { type: "integer", minimum: 0, maximum: maxCoord },
            type: { type: "string", minLength: 1 },
          },
          required: ["x1", "y1", "z1", "x2", "y2", "z2", "type"],
          additionalProperties: false,
        },
      },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0, maximum: maxCoord },
                y: { type: "integer", minimum: 0, maximum: maxCoord },
                z: { type: "integer", minimum: 0, maximum: maxCoord },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            to: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0, maximum: maxCoord },
                y: { type: "integer", minimum: 0, maximum: maxCoord },
                z: { type: "integer", minimum: 0, maximum: maxCoord },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            type: { type: "string", minLength: 1 },
          },
          required: ["from", "to", "type"],
          additionalProperties: false,
        },
      },
    },
    required: ["version", "blocks"],
    additionalProperties: false,
  } as const;
}

