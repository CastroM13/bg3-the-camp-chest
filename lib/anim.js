// Granny 2 skeletal animation decoder (root.Animations[0] -> per-bone keyframe tracks).
// Curve decoding is a port of LSLib's LSLib/Granny/Model/CurveData/*.cs (MIT, Norbyte), and keys are produced the
// way LSLib's glTF exporter produces them (TransformTrack.ToKeyframes + GLTFExporter.ExportAnimationTrack):
// every curve contributes its knots as key times and its (dequantised) controls as key values, the three channels
// of a track are merged on one timeline with LSLib's 0.01 s key snapping, and the glTF sampler is STEP (LSLib reads
// the pre-v7 `Degree` field, which is 0 for BG3 files, so its export is never interpolated).
// Arithmetic is rounded to float32 at each step, as the C# code does, so values match the exported .glb bit-for-bit
// in the common cases.

const f = Math.fround;

// --- helpers --------------------------------------------------------------------------------------------------

/** granny.js turns arrays of one-member structs ({UInt16: n}, {Real32: x}, ...) into arrays of objects */
function nums(a) {
  if (!a) return [];
  if (ArrayBuffer.isView(a)) return a;
  return a.map((o) => (typeof o === 'number' ? o : Object.values(o)[0]));
}

const u32f = new DataView(new ArrayBuffer(4));
/** LSLib ConvertOneOverKnotScaleTrunc: the upper 16 bits of a float32 */
function oneOverKnotScaleTrunc(v) { u32f.setUint32(0, (v & 0xFFFF) << 16 >>> 0, true); return u32f.getFloat32(0, true); }

const knotsDiv = (kc, n, scale) => Array.from({ length: n }, (_, i) => f(kc[i] / scale));

// OpenTK Matrix3.ExtractRotation(rowNormalise = true); m = row-major 9 floats
function matToQuat(m) {
  const row = (r) => { const x = m[r * 3], y = m[r * 3 + 1], z = m[r * 3 + 2], l = Math.hypot(x, y, z) || 1; return [f(x / l), f(y / l), f(z / l)]; };
  const r0 = row(0), r1 = row(1), r2 = row(2);
  let x, y, z, w;
  const trace = 0.25 * (r0[0] + r1[1] + r2[2] + 1.0);
  if (trace > 0) {
    let sq = Math.sqrt(trace);
    w = sq; sq = 1.0 / (4.0 * sq);
    x = (r1[2] - r2[1]) * sq; y = (r2[0] - r0[2]) * sq; z = (r0[1] - r1[0]) * sq;
  } else if (r0[0] > r1[1] && r0[0] > r2[2]) {
    let sq = 2.0 * Math.sqrt(1.0 + r0[0] - r1[1] - r2[2]);
    x = 0.25 * sq; sq = 1.0 / sq;
    w = (r2[1] - r1[2]) * sq; y = (r1[0] + r0[1]) * sq; z = (r2[0] + r0[2]) * sq;
  } else if (r1[1] > r2[2]) {
    let sq = 2.0 * Math.sqrt(1.0 + r1[1] - r0[0] - r2[2]);
    y = 0.25 * sq; sq = 1.0 / sq;
    w = (r2[0] - r0[2]) * sq; x = (r1[0] + r0[1]) * sq; z = (r2[1] + r1[2]) * sq;
  } else {
    let sq = 2.0 * Math.sqrt(1.0 + r2[2] - r0[0] - r1[1]);
    z = 0.25 * sq; sq = 1.0 / sq;
    w = (r1[0] - r0[1]) * sq; x = (r2[0] + r0[2]) * sq; y = (r2[1] + r1[2]) * sq;
  }
  x = f(x); y = f(y); z = f(z); w = f(w);
  const l = Math.hypot(x, y, z, w) || 1;
  return [f(x / l), f(y / l), f(z / l), f(w / l)];
}

const IDENTITY9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const diag = (a, b, c) => [a, 0, 0, 0, b, 0, 0, 0, c];

// D4nK16uC15u / D4nK8uC7u tables
const SCALE_TABLE = [1.4142135, 0.70710677, 0.35355338, 0.35355338, 0.35355338, 0.17677669, 0.17677669, 0.17677669,
  -1.4142135, -0.70710677, -0.35355338, -0.35355338, -0.35355338, -0.17677669, -0.17677669, -0.17677669].map(f);
const OFFSET_TABLE = [-0.70710677, -0.35355338, -0.53033006, -0.17677669, 0.17677669, -0.17677669, -0.088388346, 0.0,
  0.70710677, 0.35355338, 0.53033006, 0.17677669, -0.17677669, 0.17677669, 0.088388346, -0.0].map(f);

function d4nQuats(cd, kc, n, bits) {
  const mul = f(bits === 15 ? 0.000030518509 : 0.0078740157);
  const sel = cd.ScaleOffsetTableEntries;
  const scales = [0, 4, 8, 12].map((s) => f(SCALE_TABLE[(sel >> s) & 15] * mul));
  const offsets = [0, 4, 8, 12].map((s) => OFFSET_TABLE[(sel >> s) & 15]);
  const top = bits === 15 ? 0x8000 : 0x80, low = top - 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = kc[n + i * 3], b = kc[n + i * 3 + 1], c = kc[n + i * 3 + 2];
    const s1 = ((b & top) ? 2 : 0) | ((c & top) ? 1 : 0);
    const s2 = (s1 + 1) & 3, s3 = (s2 + 1) & 3, s4 = (s3 + 1) & 3;
    const dA = f(f((a & low) * scales[s2]) + offsets[s2]);
    const dB = f(f((b & low) * scales[s3]) + offsets[s3]);
    const dC = f(f((c & low) * scales[s4]) + offsets[s4]);
    let dD = f(Math.sqrt(f(1 - f(f(f(dA * dA) + f(dB * dB)) + f(dC * dC)))));
    if (a & top) dD = -dD;
    const q = [0, 0, 0, 0];
    q[s2] = dA; q[s3] = dB; q[s4] = dC; q[s1] = dD;
    out.push(q);
  }
  return out;
}

const so = (v, scale, off) => f(f(v * scale) + off);

/**
 * Decode one curve (the CurveData variant of an AnimationCurve) into { format, degree, knots[], values[] } where each
 * value is [x,y,z] (kind 'position'), [x,y,z,w] (kind 'rotation') or a row-major 3x3 matrix (kind 'scaleShear').
 */
export function decodeCurve(curveData, kind) {
  if (!curveData) return null;
  const hdrKey = Object.keys(curveData).find((k) => k.startsWith('CurveDataHeader_'));
  if (!hdrKey) throw new Error('unrecognised curve data (no CurveDataHeader_ member)');
  const format = hdrKey.slice(16), degree = curveData[hdrKey]?.Degree ?? 0;
  const cd = curveData;
  let knots, points, quats, mats;
  switch (format) {
    case 'DaIdentity':
      knots = [0]; points = [[0, 0, 0]]; mats = [IDENTITY9]; break;
    case 'DaConstant32f': {
      const c = nums(cd.Controls).map(f);
      knots = [0]; mats = [c.slice(0, 9)]; break;
    }
    case 'D3Constant32f': {
      const c = nums(cd.Controls).map(f);
      knots = [0]; points = [c.slice(0, 3)]; break;
    }
    case 'D4Constant32f': {
      const c = nums(cd.Controls).map(f);
      knots = [0]; quats = [c.slice(0, 4)]; break;
    }
    case 'DaKeyframes32f': {
      const c = nums(cd.Controls).map(f), dim = cd.Dimension, n = Math.floor(c.length / dim);
      knots = Array.from({ length: n }, (_, i) => i);
      const rows = Array.from({ length: n }, (_, i) => c.slice(i * dim, i * dim + dim));
      if (dim === 3) points = rows; else if (dim === 4) quats = rows; else if (dim === 9) mats = rows;
      else throw new Error(`DaKeyframes32f: unsupported dimension ${dim}`);
      break;
    }
    case 'DaK32fC32f': {
      const k = nums(cd.Knots).map(f), c = nums(cd.Controls).map(f), n = k.length;
      knots = k;
      const dim = n ? c.length / n : 0;
      const rows = Array.from({ length: n }, (_, i) => c.slice(i * dim, i * dim + dim));
      if (dim === 3) points = rows; else if (dim === 4) quats = rows; else if (dim === 9) mats = rows;
      else if (n) throw new Error('DaK32fC32f: unsupported control data size');
      break;
    }
    case 'DaK16uC16u': case 'DaK8uC8u': {
      const sc = nums(cd.ControlScaleOffsets).map(f), comps = sc.length / 2, kc = nums(cd.KnotsControls);
      const n = Math.floor(kc.length / (comps + 1));
      knots = knotsDiv(kc, n, oneOverKnotScaleTrunc(cd.OneOverKnotScaleTrunc));
      const rows = Array.from({ length: n }, (_, i) => Array.from({ length: comps }, (_, j) => so(kc[n + i * comps + j], sc[j], sc[comps + j])));
      if (comps === 4) quats = rows; else if (comps === 9) mats = rows; else if (comps === 3) points = rows;
      else throw new Error(`${format}: unsupported component count ${comps}`);
      break;
    }
    case 'D4nK16uC15u': case 'D4nK8uC7u': {
      const kc = nums(cd.KnotsControls), n = Math.floor(kc.length / 4), sc = f(cd.OneOverKnotScale);
      knots = knotsDiv(kc, n, sc);
      quats = d4nQuats(cd, kc, n, format === 'D4nK16uC15u' ? 15 : 7);
      break;
    }
    case 'D3K16uC16u': case 'D3K8uC8u': {
      const kc = nums(cd.KnotsControls), n = Math.floor(kc.length / 4), S = nums(cd.ControlScales).map(f), O = nums(cd.ControlOffsets).map(f);
      knots = knotsDiv(kc, n, oneOverKnotScaleTrunc(cd.OneOverKnotScaleTrunc));
      points = Array.from({ length: n }, (_, i) => [0, 1, 2].map((j) => so(kc[n + i * 3 + j], S[j], O[j])));
      break;
    }
    case 'D3I1K16uC16u': case 'D3I1K8uC8u': case 'D3I1K32fC32f': {
      const kc = nums(cd.KnotsControls), n = Math.floor(kc.length / 2), S = nums(cd.ControlScales).map(f), O = nums(cd.ControlOffsets).map(f);
      knots = format === 'D3I1K32fC32f' ? Array.from({ length: n }, (_, i) => f(kc[i]))
        : knotsDiv(kc, n, oneOverKnotScaleTrunc(cd.OneOverKnotScaleTrunc));
      points = Array.from({ length: n }, (_, i) => [0, 1, 2].map((j) => so(f(kc[n + i]), S[j], O[j])));
      break;
    }
    case 'D9I1K16uC16u': case 'D9I1K8uC8u': {
      const kc = nums(cd.KnotsControls), n = Math.floor(kc.length / 2);
      knots = knotsDiv(kc, n, oneOverKnotScaleTrunc(cd.OneOverKnotScaleTrunc));
      const s = f(cd.ControlScale), o = f(cd.ControlOffset);
      mats = Array.from({ length: n }, (_, i) => { const v = so(kc[n + i], s, o); return diag(v, v, v); });
      break;
    }
    case 'D9I3K16uC16u': case 'D9I3K8uC8u': {
      const kc = nums(cd.KnotsControls), n = Math.floor(kc.length / 4), S = nums(cd.ControlScales).map(f), O = nums(cd.ControlOffsets).map(f);
      knots = knotsDiv(kc, n, oneOverKnotScaleTrunc(cd.OneOverKnotScaleTrunc));
      mats = Array.from({ length: n }, (_, i) => diag(...[0, 1, 2].map((j) => so(kc[n + i * 3 + j], S[j], O[j]))));
      break;
    }
    default:
      throw new Error(`unsupported curve format ${format}`);
  }
  let values;
  if (kind === 'position') values = points;
  else if (kind === 'rotation') values = quats || (mats && mats.map(matToQuat));
  else values = mats;
  if (!values) throw new Error(`curve format ${format} has no ${kind} data`);
  return { format, degree, knots, values };
}

// --- LSLib KeyframeTrack: a sorted list of frames; adding a key snaps to the next later frame within 0.01 s ------

function requireFrame(frames, time) {
  // frames: sorted array of { time, ... }
  let lo = 0, hi = frames.length - 1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    const t = frames[mid].time;
    if (time === t) return frames[mid];
    if (time < t) hi = mid - 1; else lo = mid + 1;
  }
  if (lo < frames.length && Math.abs(frames[lo].time - time) < 0.01) return frames[lo];
  const fr = { time };
  frames.splice(lo, 0, fr);
  return fr;
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  let k0, k1;
  if (d > 0.9995) { k0 = 1 - t; k1 = t; } else {
    const th = Math.acos(Math.min(1, d)), sn = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / sn; k1 = Math.sin(t * th) / sn;
  }
  const q = [0, 1, 2, 3].map((i) => k0 * a[i] + k1 * s * b[i]);
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}

/** value of a channel (times[], values[]) at time t: STEP (glTF semantics, held before the first key) or LINEAR */
function sampleChannel(ch, t, linear, isQuat) {
  const T = ch.times, V = ch.values, n = T.length;
  if (t <= T[0] || n === 1) return V[0];
  if (t >= T[n - 1]) return V[n - 1];
  let lo = 0, hi = n - 1;                                        // last index with T[i] <= t
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  if (!linear || T[lo] === t) return V[lo];
  const a = (t - T[lo]) / (T[lo + 1] - T[lo]);
  if (isQuat) return slerp(V[lo], V[lo + 1], a);
  return V[lo].map((v, i) => v + (V[lo + 1][i] - v) * a);
}

/**
 * Decode root.Animations[0] (track group 0).
 * @param {Granny} g
 * @param {object} root            g.root()
 * @param {string[]|object} [opts] an array of skeleton bone names, or
 *   { boneNames?: string[], interpolation?: 'step'|'linear', animation?: number, trackGroup?: number }
 *   boneNames: tracks are renamed to the skeleton bone ("Dummy_Foot" -> "Dummy_Foot_01" as LSLib does) and tracks
 *   for bones not in the list are dropped. interpolation decides how the merged per-track timeline is filled where a
 *   channel has no key of its own: 'step' (default) is exactly what LSLib's glTF export plays back.
 * @returns {{ name, duration, timeStep, interpolation, tracks: Array<{ bone, times: Float32Array,
 *   rotations: Float32Array, translations: Float32Array, scales: Float32Array,
 *   channels: { rotation, translation, scale } }> }}
 *   channels.* = { times: Float32Array, values: Float32Array, format, degree } are the raw per-channel keys
 *   (identical to the samplers of LSLib's glTF export); scales are the diagonal of the scale/shear matrix.
 */
export function decodeAnimation(g, root, opts = {}) {
  if (Array.isArray(opts)) opts = { boneNames: opts };
  const anim = root?.Animations?.[opts.animation ?? 0];
  if (!anim) throw new Error('no animation in file');
  const group = anim.TrackGroups?.[opts.trackGroup ?? 0];
  if (!group) throw new Error('animation has no track group');
  const linear = opts.interpolation === 'linear';
  const boneSet = opts.boneNames ? new Set(opts.boneNames) : null;
  const tracks = [];
  for (const tt of group.TransformTracks || []) {
    let bone = tt.Name;
    if (boneSet) {
      if (!boneSet.has(bone)) { if (boneSet.has(bone + '_01')) bone += '_01'; else continue; }
    }
    const rot = decodeCurve(tt.OrientationCurve?.CurveData, 'rotation');
    const pos = decodeCurve(tt.PositionCurve?.CurveData, 'position');
    const ss = decodeCurve(tt.ScaleShearCurve?.CurveData, 'scaleShear');
    // LSLib ToKeyframes: rotation keys first, then position, then scale/shear, each snapping onto existing frames
    const frames = [];
    const add = (c, key) => { if (c) c.knots.forEach((t, i) => { requireFrame(frames, t)[key] = c.values[i]; }); };
    add(rot, 'r'); add(pos, 't'); add(ss, 's');
    const chan = (key, map, curve, dim) => {
      const fr = frames.filter((x) => x[key] !== undefined);
      return { times: Float32Array.from(fr, (x) => x.time), values: Float32Array.from(fr.flatMap((x) => map(x[key]))), list: fr.map((x) => map(x[key])),
        format: curve?.format ?? null, degree: curve?.degree ?? 0, dim };
    };
    const cr = chan('r', (q) => q, rot, 4);
    const ct = chan('t', (v) => v, pos, 3);
    const cs = chan('s', (m) => [m[0], m[4], m[8]], ss, 3);
    const n = frames.length;
    const times = new Float32Array(n), rotations = new Float32Array(n * 4), translations = new Float32Array(n * 3), scales = new Float32Array(n * 3);
    const fill = (ch, out, dim, isQuat, def) => {
      const c = { times: ch.times, values: ch.list };
      for (let i = 0; i < n; i++) out.set(c.times.length ? sampleChannel(c, frames[i].time, linear, isQuat) : def, i * dim);
    };
    frames.forEach((fr, i) => { times[i] = fr.time; });
    fill(cr, rotations, 4, true, [0, 0, 0, 1]);
    fill(ct, translations, 3, false, [0, 0, 0]);
    fill(cs, scales, 3, false, [1, 1, 1]);
    for (const c of [cr, ct, cs]) delete c.list;
    tracks.push({ bone, times, rotations, translations, scales, channels: { rotation: cr, translation: ct, scale: cs } });
  }
  return { name: anim.Name, duration: anim.Duration, timeStep: anim.TimeStep, interpolation: linear ? 'linear' : 'step', tracks };
}
