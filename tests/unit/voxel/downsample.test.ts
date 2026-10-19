import assert from "node:assert/strict";
import { downsampleLinear } from "../../../lib/voxel/downsample";

const rgba = (...colors: number[][]) => new Uint8ClampedArray(colors.flatMap((c) => [...c, 255]));
const black = [0, 0, 0];
const white = [255, 255, 255];
const red = [200, 30, 10];
const blue = [10, 40, 220];

// half black and half white is half the light, which sRGB stores as 188 rather than 128
assert.deepEqual([...downsampleLinear(rgba(black, white, white, black), 2, 2, 2)], [188, 188, 188, 255]);

// every byte survives the trip through linear light unchanged
const all = Array.from({ length: 256 }, (_, v) => [v, 255 - v, v]);
assert.deepEqual(downsampleLinear(rgba(...all), 256, 1, 1), rgba(...all));

// blocks follow rows and columns: a 4x2 image with a red left half and a blue right half
assert.deepEqual(downsampleLinear(rgba(red, red, blue, blue, red, red, blue, blue), 4, 2, 2), rgba(red, blue));

assert.throws(() => downsampleLinear(new Uint8ClampedArray(3 * 3 * 4), 3, 3, 2), /do not split/);
