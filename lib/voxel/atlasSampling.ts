// smaller atlas mips blend neighbouring tiles, which washes out zoomed-out builds;
// 48px cells (32px tiles plus 8px copied edges) keep level 3 within about 2/255 of true colour, level 4 drifts
const ATLAS_MAX_MIP_LEVEL = 3;

// textureGrad with the gradients shrunk so sampling never goes below ATLAS_MAX_MIP_LEVEL
export const ATLAS_SAMPLE_GLSL = `
vec4 sampleAtlas(sampler2D atlas, vec2 uv, vec2 dx, vec2 dy) {
  vec2 size = vec2(textureSize(atlas, 0));
  float lod = 0.5 * log2(max(dot(dx * size, dx * size), dot(dy * size, dy * size)));
  float shrink = exp2(min(0.0, ${ATLAS_MAX_MIP_LEVEL}.0 - lod));
  return textureGrad(atlas, uv, dx * shrink, dy * shrink);
}`;
