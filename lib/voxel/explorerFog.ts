import * as THREE from "three";

type SkyUniforms = {
  explorerDaySky: { value: THREE.Texture };
  explorerNightSky: { value: THREE.Texture };
  explorerNightBlend: { value: number };
};

function addSkyDirection(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vExplorerViewRay;")
    .replace("#include <project_vertex>", "#include <project_vertex>\nvExplorerViewRay = mvPosition.xyz * mat3(viewMatrix);");
  shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vExplorerViewRay;
vec2 explorerSkyUv() {
  return vec2(0.5, acos(clamp(-normalize(vExplorerViewRay).y, -1.0, 1.0)) / PI);
}`);
}

export function enableExplorerSkyGradient(material: THREE.MeshBasicMaterial): void {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    addSkyDirection(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      "diffuseColor *= texture2D(map, explorerSkyUv());",
    );
  };
  material.customProgramCacheKey = () => `${key}:explorer-sky-v1`;
  material.needsUpdate = true;
}

export function enableExplorerFog(material: THREE.Material, uniforms: SkyUniforms): void {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    addSkyDirection(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <fog_pars_fragment>", `#include <fog_pars_fragment>
uniform sampler2D explorerDaySky;
uniform sampler2D explorerNightSky;
uniform float explorerNightBlend;`)
      .replace("#include <fog_fragment>", THREE.ShaderChunk.fog_fragment
        .replaceAll("vFogDepth", "length(vExplorerViewRay)")
        .replace("gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );", `
vec3 explorerFogColor = fogColor;
// bloom uses black fog to extinguish distant emission
if (fogFactor > 0.0 && any(greaterThan(fogColor, vec3(0.0)))) {
  vec2 skyUv = explorerSkyUv();
  vec3 day = linearToOutputTexel(texture2D(explorerDaySky, skyUv)).rgb;
  explorerFogColor = day;
  if (explorerNightBlend > 0.0) {
    vec3 night = linearToOutputTexel(texture2D(explorerNightSky, skyUv)).rgb;
    explorerFogColor = mix(day, night, explorerNightBlend);
  }
}
gl_FragColor.rgb = mix(gl_FragColor.rgb, explorerFogColor, fogFactor);`));
  };
  material.customProgramCacheKey = () => `${key}:explorer-fog-v1`;
  material.needsUpdate = true;
}
