// sRGB byte to linear light
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function toSrgbByte(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/**
 * Shrinks opaque RGBA pixels by a whole factor, each output pixel the mean of its factor x factor block in linear
 * light. Rendering larger and averaging this way removes the moire one sample per pixel leaves on blocks about a
 * pixel wide.
 */
export function downsampleLinear(pixels: Uint8ClampedArray, width: number, height: number, factor: number) {
  if (!Number.isInteger(factor) || factor < 1 || width % factor || height % factor) {
    throw new Error(`${width}x${height} pixels do not split into ${factor}x${factor} blocks`);
  }
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const sums = new Float64Array(outWidth * 3);
  const count = factor * factor;
  for (let y = 0; y < outHeight; y++) {
    sums.fill(0);
    for (let row = y * factor; row < (y + 1) * factor; row++) {
      let i = row * width * 4;
      for (let x = 0; x < outWidth; x++) {
        for (let k = 0; k < factor; k++, i += 4) {
          sums[x * 3] += LINEAR[pixels[i]];
          sums[x * 3 + 1] += LINEAR[pixels[i + 1]];
          sums[x * 3 + 2] += LINEAR[pixels[i + 2]];
        }
      }
    }
    for (let x = 0; x < outWidth; x++) {
      const o = (y * outWidth + x) * 4;
      out[o] = toSrgbByte(sums[x * 3] / count);
      out[o + 1] = toSrgbByte(sums[x * 3 + 1] / count);
      out[o + 2] = toSrgbByte(sums[x * 3 + 2] / count);
      out[o + 3] = 255;
    }
  }
  return out;
}
