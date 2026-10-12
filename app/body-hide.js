// Hide naked-body regions covered by equipment, the way BG3 does it.
// The body mesh carries a per-vertex region id (glTF attribute `_REGION`, three: `_region`); each item lists the
// region ids it covers (`items.json` → hideBody.M / hideBody.F). Triangles whose vertices are all in a hidden
// region are discarded in the fragment shader.
const MAX = 32;

export function applyBodyHide(material, regionIds) {
  const ids = [...new Set(regionIds || [])].slice(0, MAX);
  const arr = new Float32Array(MAX).fill(-1);
  ids.forEach((v, i) => { arr[i] = v; });
  if (!material.userData.bodyHide) {
    const u = { uHidden: { value: arr } };
    material.userData.bodyHide = u;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHidden = u.uHidden;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float _region;
uniform float uHidden[${MAX}];
varying float vBodyHide;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vBodyHide = 0.0;
for (int i = 0; i < ${MAX}; i++) { if (uHidden[i] >= 0.0 && abs(_region - uHidden[i]) < 0.5) vBodyHide = 1.0; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vBodyHide;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (vBodyHide > 0.999) discard;`);
    };
    material.customProgramCacheKey = () => 'bg3-bodyhide-v1';
    material.needsUpdate = true;
  } else {
    material.userData.bodyHide.uHidden.value = arr;
  }
}

// Union of the hide lists of every equipped item for a body type ('M' | 'F').
export function hiddenRegions(items, bodyType) {
  const out = new Set();
  for (const it of items) for (const r of (it?.hideBody?.[bodyType] || [])) out.add(r);
  return [...out];
}
