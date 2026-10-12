// Shared BG3 dye recolouring (mask-decode shader) used by viewer.js and dressing.js.
// See CONTRACT.md "Dyes" for the data and the decode rules.
//
//   import { dyeMaterialsOf, resolveDyeUrls, setMaterialDye, undyeMaterial, configureDyeTexture } from './dye-shader.js';
//   for (const m of dyeMaterialsOf(root)) {
//     const urls = resolveDyeUrls(m, modelUrl);               // { albedo, mask } absolute, or null
//     ... load both textures (configureDyeTexture(tex, isColor, aniso)) ...
//     setMaterialDye(m, { albedo, mask, colors });            // colors = a dye's `colors` dict
//   }
//   undyeMaterial(m);                                         // back to the baked map + stock shader

import * as THREE from 'three';

// Dye slot order (index = family * 4 + sub); families: Cloth 0, Leather 1, Metal 2.
export const DYE_SLOTS = [
  'Cloth_Primary', 'Cloth_Secondary', 'Cloth_Tertiary', 'Accent_Color',
  'Leather_Primary', 'Leather_Secondary', 'Leather_Tertiary', 'Custom_1',
  'Metal_Primary', 'Metal_Secondary', 'Metal_Tertiary', 'Custom_2',
];

// Appended after the stock map sampling. Mirrors the Python bake exactly (CONTRACT.md "Mask decoding").
export const DYE_FRAGMENT = /* glsl */`
#include <map_fragment>
#ifdef USE_MAP
{
	vec3 dm = texture2D( dyeMask, vMapUv ).rgb;
	float dmx = max( dm.r, max( dm.g, dm.b ) );
	if ( dmx > 0.0 ) {
		float dmn = min( dm.r, min( dm.g, dm.b ) );
		float dsat = ( dmx - dmn ) / dmx;
		float dw = dsat > 0.25 ? dmx : 0.0;
		if ( dw > 0.0 ) {
			int dfam; float dnx; float dpv;
			// dom = largest channel, ties to the lower index. R->Cloth(0), G->Metal(2), B->Leather(1)
			if ( dm.r >= dm.g && dm.r >= dm.b ) { dfam = 0; dnx = dm.g; dpv = dm.b; }
			else if ( dm.g >= dm.b )            { dfam = 2; dnx = dm.b; dpv = dm.r; }
			else                                { dfam = 1; dnx = dm.r; dpv = dm.g; }
			bool dnb = ( dnx / dmx ) > 0.25;
			bool dpb = ( dpv / dmx ) > 0.25;
			int dsub = 3;
			if ( dnb && !dpb ) dsub = 0;
			else if ( !dnb && !dpb ) dsub = 1;
			else if ( !dnb && dpb ) dsub = 2;
			vec3 dpal = dyePalette[ dfam * 4 + dsub ];
			diffuseColor.rgb *= mix( vec3( 1.0 ), dpal, dw );
		}
	}
}
#endif
`;

const DYE_CACHE_KEY = 'bg3dye-v1';

// material -> { baked: Texture|null, active: bool, uniforms: { dyeMask:{value}, dyePalette:{value:Vector3[12]} } }
const dyeStates = new WeakMap();

function dyeOnBeforeCompile(shader) {
  const state = dyeStates.get(this); // onBeforeCompile is invoked as material.onBeforeCompile(...)
  if (!state || !state.active) return;
  shader.uniforms.dyeMask = state.uniforms.dyeMask;
  shader.uniforms.dyePalette = state.uniforms.dyePalette;
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', 'uniform sampler2D dyeMask;\nuniform vec3 dyePalette[ 12 ];\nvoid main() {')
    .replace('#include <map_fragment>', DYE_FRAGMENT);
}
function dyeCacheKey() { return DYE_CACHE_KEY; }

const toArray = (m) => (Array.isArray(m) ? m : [m]);

/** True when `m` is a MeshStandardMaterial carrying usable `userData.bg3Dye` extras. */
export function isDyeMaterial(m) {
  const d = m && m.userData && m.userData.bg3Dye;
  return !!(d && typeof d === 'object' && d.albedo && d.mask && m.isMeshStandardMaterial);
}

/** Every distinct dyeable material under root. */
export function dyeMaterialsOf(root) {
  const out = new Set();
  if (!root) return [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of toArray(o.material)) if (isDyeMaterial(m)) out.add(m);
  });
  return [...out];
}

/** Absolute { albedo, mask } URLs for a dyeable material, resolved against the model URL; null if invalid. */
export function resolveDyeUrls(m, modelUrl) {
  const d = m && m.userData && m.userData.bg3Dye;
  if (!d) return null;
  let base;
  try { base = new URL(modelUrl || '', document.baseURI); } catch { base = new URL(document.baseURI); }
  try { return { albedo: new URL(d.albedo, base).href, mask: new URL(d.mask, base).href }; } catch { return null; }
}

/** Sets the texture parameters for a raw albedo (isColor) or a colour mask (data). */
export function configureDyeTexture(tex, isColor, anisotropy = 1) {
  tex.flipY = false;                       // glTF UV convention
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = anisotropy;
  } else {
    tex.colorSpace = THREE.NoColorSpace;   // region IDs are data
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }
  tex.needsUpdate = true;
  return tex;
}

/** palette[i] = colors[slot] ?? base[slot] ?? white, written into `out` (Vector3[12]) in place. */
export function buildPalette(base, colors, out) {
  for (let i = 0; i < 12; i++) {
    const name = DYE_SLOTS[i];
    const c = (colors && Array.isArray(colors[name]) && colors[name]) ||
              (base && Array.isArray(base[name]) && base[name]) || [1, 1, 1];
    out[i].set(+c[0] || 0, +c[1] || 0, +c[2] || 0);
  }
}

/**
 * Recolours one dyeable material: swaps `map` to the raw albedo, adds the mask decode and sets the palette.
 * Calling it again on an already dyed material only updates the uniforms (no recompile).
 */
export function setMaterialDye(m, { albedo, mask, colors }) {
  const d = m.userData.bg3Dye;
  let st = dyeStates.get(m);
  if (!st) {
    st = {
      baked: m.map,
      active: false,
      uniforms: {
        dyeMask: { value: null },
        dyePalette: { value: Array.from({ length: 12 }, () => new THREE.Vector3(1, 1, 1)) },
      },
    };
    dyeStates.set(m, st);
  }
  buildPalette(d.base, colors, st.uniforms.dyePalette.value); // in place: no recompile when already dyed
  st.uniforms.dyeMask.value = mask;
  if (!st.active) {
    st.baked = m.map;
    st.active = true;
    m.map = albedo;
    m.onBeforeCompile = dyeOnBeforeCompile;
    m.customProgramCacheKey = dyeCacheKey;
    m.needsUpdate = true;
  } else if (m.map !== albedo) {
    m.map = albedo;
    m.needsUpdate = true;
  }
  return true;
}

/** Restores the baked map and the stock shader. Returns true when something changed. */
export function undyeMaterial(m) {
  const st = dyeStates.get(m);
  if (!st || !st.active) return false;
  st.active = false;
  m.map = st.baked;
  st.uniforms.dyeMask.value = null;
  delete m.onBeforeCompile;          // back to the prototype no-op
  delete m.customProgramCacheKey;    // back to the prototype key
  m.needsUpdate = true;
  return true;
}

/** True while the material shows a dye. */
export function isMaterialDyed(m) {
  const st = dyeStates.get(m);
  return !!(st && st.active);
}
