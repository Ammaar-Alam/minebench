import assert from "node:assert/strict";
import {
  appendQuad,
  makeBucket,
  serializeBucket,
} from "../../../lib/voxel/meshBuckets";

// what a face cost before this representation: 11 floats per vertex across
// four vertices, plus six 32-bit indices
const LEGACY_BYTES_PER_FACE = 11 * 4 * 4 + 6 * 4;

const QUAD: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [1, 0, 0],
];
const UV: readonly [number, number, number, number, number, number, number, number] = [
  0, 0, 0, 1, 1, 1, 1, 0,
];

async function main() {
  {
    const bucket = makeBucket();
    // the six axis-aligned directions are the only normals the mesher emits
    const normals = [
      { nx: 1, ny: 0, nz: 0 },
      { nx: -1, ny: 0, nz: 0 },
      { nx: 0, ny: 1, nz: 0 },
      { nx: 0, ny: -1, nz: 0 },
      { nx: 0, ny: 0, nz: 1 },
      { nx: 0, ny: 0, nz: -1 },
    ];
    for (const normal of normals) appendQuad(bucket, QUAD, normal, [1, 1, 1], UV);
    const serialized = serializeBucket(bucket);
    assert.ok(serialized);

    for (let i = 0; i < normals.length; i += 1) {
      const expected = normals[i];
      for (let v = 0; v < 4; v += 1) {
        const at = (i * 4 + v) * 3;
        // signed-normalized reads divide by 127, so the round trip is exact
        assert.equal(serialized.normals[at] / 127, expected.nx, `nx quad ${i} vertex ${v}`);
        assert.equal(serialized.normals[at + 1] / 127, expected.ny, `ny quad ${i} vertex ${v}`);
        assert.equal(serialized.normals[at + 2] / 127, expected.nz, `nz quad ${i} vertex ${v}`);
      }
    }
  }

  {
    // atlas coordinates survive at far finer than one texel of a 4096px atlas
    const bucket = makeBucket();
    const uv: [number, number, number, number, number, number, number, number] = [
      0, 0, 0.125, 0.375, 0.6251, 0.9999, 1, 0.5,
    ];
    appendQuad(bucket, QUAD, { nx: 0, ny: 1, nz: 0 }, [1, 1, 1], uv);
    const serialized = serializeBucket(bucket);
    assert.ok(serialized);
    assert.ok(serialized.uvs instanceof Uint16Array);
    for (let i = 0; i < 8; i += 1) {
      const decoded = serialized.uvs[i] / 65535;
      assert.ok(
        Math.abs(decoded - uv[i]) <= 1 / 65535,
        `uv ${i}: ${decoded} vs ${uv[i]}`,
      );
      assert.ok(Math.abs(decoded - uv[i]) < 1 / 4096, `uv ${i} finer than a texel`);
    }
  }

  {
    // Merged water rectangles use repeat-wrapped UVs above one.
    const bucket = makeBucket({ repeatingUvs: true });
    const uv: [number, number, number, number, number, number, number, number] = [
      0, 0, 0, 3, 5, 3, 5, 0,
    ];
    appendQuad(bucket, QUAD, { nx: 0, ny: 1, nz: 0 }, [1, 1, 1], uv);
    const serialized = serializeBucket(bucket);
    assert.ok(serialized);
    assert.ok(serialized.uvs instanceof Float32Array);
    assert.deepEqual(Array.from(serialized.uvs), uv);
  }

  {
    // the mesher emits flat tints, so eight bits per channel is beyond visible
    const bucket = makeBucket();
    const tints: [number, number, number][] = [
      [1, 1, 1],
      [0.0343, 0.4179, 0.0075],
      [0.2158, 0.4397, 0.0423],
      [0.0508, 0.1712, 0.7379],
    ];
    for (const tint of tints) appendQuad(bucket, QUAD, { nx: 0, ny: 1, nz: 0 }, tint, UV);
    const serialized = serializeBucket(bucket);
    assert.ok(serialized);
    for (let i = 0; i < tints.length; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        const decoded = serialized.colors[i * 4 * 3 + c] / 255;
        assert.ok(
          Math.abs(decoded - tints[i][c]) <= 1 / 255,
          `tint ${i} channel ${c}: ${decoded} vs ${tints[i][c]}`,
        );
      }
    }
  }

  {
    // growth has to preserve everything already written, and the serialized
    // arrays must carry no slack from the growth steps
    const bucket = makeBucket();
    const faces = 5000;
    for (let i = 0; i < faces; i += 1) {
      appendQuad(
        bucket,
        [
          [i, 0, 0],
          [i, 1, 0],
          [i + 1, 1, 0],
          [i + 1, 0, 0],
        ],
        { nx: 0, ny: 0, nz: 1 },
        [1, 1, 1],
        UV,
      );
    }
    const serialized = serializeBucket(bucket);
    assert.ok(serialized);
    assert.equal(serialized.positions.length, faces * 4 * 3);
    assert.equal(serialized.indices.length, faces * 6);
    assert.equal(serialized.normals.length, faces * 4 * 3);
    assert.equal(serialized.uvs.length, faces * 4 * 2);
    assert.equal(serialized.colors.length, faces * 4 * 3);

    for (let i = 0; i < faces; i += 1) {
      assert.equal(serialized.positions[i * 12], i, `first x of face ${i}`);
      assert.equal(serialized.indices[i * 6], i * 4, `base index of face ${i}`);
      assert.equal(serialized.indices[i * 6 + 5], i * 4 + 3, `last index of face ${i}`);
    }

    const bytes =
      serialized.positions.byteLength +
      serialized.normals.byteLength +
      serialized.uvs.byteLength +
      serialized.colors.byteLength +
      serialized.indices.byteLength;
    const perFace = bytes / faces;
    assert.equal(perFace, 112, `bytes per face: ${perFace}`);
    assert.ok(perFace < LEGACY_BYTES_PER_FACE, "must be smaller than the float layout");
    console.log(
      `  ${perFace} bytes/face against ${LEGACY_BYTES_PER_FACE} before ` +
        `(${(LEGACY_BYTES_PER_FACE / perFace).toFixed(2)}x)`,
    );
  }

  {
    assert.equal(serializeBucket(makeBucket()), null, "an empty bucket serializes to null");
  }

  console.log("mesh bucket checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
