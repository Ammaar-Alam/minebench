import * as THREE from "three";

const shadowFragment = THREE.ShaderChunk.shadowmap_pars_fragment
  .replace("float getShadow( sampler2DShadow", `
#if NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
#endif

vec2 explorerShadowGradient(mat4 shadowMatrix, vec3 worldNormal) {
  vec3 u = vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]);
  vec3 v = vec3(shadowMatrix[0][1], shadowMatrix[1][1], shadowMatrix[2][1]);
  vec3 z = vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]);
  float depthNormal = dot(worldNormal, z);
  float depthScale = dot(z, z);
  return depthNormal == 0.0 ? vec2(0.0, 0.0) : vec2(
    -dot(worldNormal, u) * depthScale / (dot(u, u) * depthNormal),
    -dot(worldNormal, v) * depthScale / (dot(v, v) * depthNormal)
  );
}

float sampleExplorerShadow(sampler2DShadow shadowMap, vec2 shadowMapSize, vec3 shadowCoord, vec2 offset, vec2 depthGradient) {
  // texel centers avoid comparing one reference depth with four neighboring depths
  float u = (clamp(floor((shadowCoord.x + offset.x) * shadowMapSize.x), 0.0, shadowMapSize.x - 1.0) + 0.5) / shadowMapSize.x;
  float v = (clamp(floor((shadowCoord.y + offset.y) * shadowMapSize.y), 0.0, shadowMapSize.y - 1.0) + 0.5) / shadowMapSize.y;
  float depth = shadowCoord.z + depthGradient.x * (u - shadowCoord.x) + depthGradient.y * (v - shadowCoord.y);
  return texture(shadowMap, vec3(u, v, depth));
}

float getShadow( sampler2DShadow`)
  .replace("shadowCoord.z += shadowBias;", `shadowCoord.z += shadowBias;
  vec2 explorerDepthGradient = vec2(0.0);
  #if NUM_DIR_LIGHT_SHADOWS > 0
    #ifdef FLAT_SHADED
      vec3 explorerViewNormal = cross(dFdx(vViewPosition), dFdy(vViewPosition));
    #else
      vec3 explorerViewNormal = vNormal;
    #endif
    // Explorer has one directional shadow light for both sun and moon
    explorerDepthGradient = explorerShadowGradient(directionalShadowMatrix[0], inverseTransformDirection(explorerViewNormal, viewMatrix));
  #endif`)
  .replace(
    /texture\( shadowMap, vec3\( shadowCoord.xy \+ (vogelDiskSample\( [0-4], 5, phi \) \* radius), shadowCoord.z \) \)/g,
    "sampleExplorerShadow(shadowMap, shadowMapSize, shadowCoord.xyz, $1, explorerDepthGradient)",
  );

export function enableExplorerShadows(material: THREE.Material): void {
  const onBeforeCompile = material.onBeforeCompile;
  const programCacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    onBeforeCompile.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <shadowmap_pars_fragment>", shadowFragment);
  };
  material.customProgramCacheKey = () => `${programCacheKey}-explorer-shadow-plane-v1`;
  material.needsUpdate = true;
}
