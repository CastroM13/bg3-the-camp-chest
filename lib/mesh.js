// Turn Granny mesh data into flat typed arrays (positions, normals, tangents, uvs, indices, skinning).
import { DT } from './granny.js';

function half(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

// QTangent: a quaternion (int16/32767) encoding the tangent frame; the sign of w carries handedness.
export function qtangentFrame(x, y, z, w) {
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  const sign = w < 0 ? -1 : 1;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  // rotation matrix rows
  const m = [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
  return { m, sign };
}

/** Decode a mesh. Returns { name, positions, normals, tangents, uvs, indices, joints, weights, boneNames }. */
export function decodeMesh(g, mesh) {
  const va = mesh.PrimaryVertexData?.Vertices;
  const n = va?.count || 0;
  const out = { name: mesh.Name, vertexCount: n };
  if (!n) return out;
  const view = g.views[va.loc.s], base = va.loc.o, stride = va.stride;
  let off = 0;
  const comp = {};
  for (const m of va.members) {
    comp[m.name] = { off, type: m.type, count: Math.max(1, m.count) };
    off += g.memberSize(m);
  }
  const rd = (type, o) => {
    switch (type) {
      case DT.float: return view.getFloat32(o, true);
      case DT.half: return half(view.getUint16(o, true));
      case DT.int16: case DT.binormalInt16: return view.getInt16(o, true);
      case DT.uint16: case DT.normalUint16: return view.getUint16(o, true);
      case DT.uint8: case DT.normalUint8: return view.getUint8(o);
      case DT.int8: case DT.binormalInt8: return view.getInt8(o);
      default: return 0;
    }
  };
  const size = { [DT.float]: 4, [DT.half]: 2, [DT.int16]: 2, [DT.binormalInt16]: 2, [DT.uint16]: 2, [DT.normalUint16]: 2,
    [DT.uint8]: 1, [DT.normalUint8]: 1, [DT.int8]: 1, [DT.binormalInt8]: 1 };
  const get = (c, i, k) => rd(c.type, base + i * stride + c.off + k * size[c.type]);

  const P = comp.Position;
  out.positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out.positions[i * 3 + k] = get(P, i, k);

  const Q = comp.QTangent;
  if (Q) {
    out.normals = new Float32Array(n * 3);
    out.tangents = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const { m, sign } = qtangentFrame(get(Q, i, 0), get(Q, i, 1), get(Q, i, 2), get(Q, i, 3));
      // matches LSLib: normal = column 2 * sign, tangent = column 1, handedness w = -sign
      const col = (c) => [m[0][c], m[1][c], m[2][c]];
      const nn = col(2), tt = col(1);
      out.normals.set(nn.map((v) => v * sign), i * 3);
      out.tangents.set([...tt, -sign], i * 4);
    }
  } else if (comp.Normal) {
    out.normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out.normals[i * 3 + k] = get(comp.Normal, i, k);
  }
  const UV = comp.TextureCoordinates0;
  if (UV) {
    out.uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { out.uvs[i * 2] = get(UV, i, 0); out.uvs[i * 2 + 1] = get(UV, i, 1); }
  }
  if (comp.BoneIndices && comp.BoneWeights) {
    out.joints = new Uint16Array(n * 4);
    out.weights = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) { out.joints[i * 4 + k] = get(comp.BoneIndices, i, k); s += (out.weights[i * 4 + k] = get(comp.BoneWeights, i, k)); }
      for (let k = 0; k < 4; k++) out.weights[i * 4 + k] /= s || 1;
    }
    out.boneNames = (mesh.BoneBindings || []).map((b) => b.BoneName);
  }
  if (comp.DiffuseColor0) {
    out.colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) out.colors[i * 4 + k] = get(comp.DiffuseColor0, i, k) / 255;
  }
  const top = mesh.PrimaryTopology;
  const src = top?.Indices?.length ? top.Indices.map((x) => x.Int32 ?? Object.values(x)[0])
    : (top?.Indices16 || []).map((x) => x.Int16 ?? Object.values(x)[0]);
  out.indices = Uint32Array.from(src, (v) => v & (top?.Indices?.length ? 0xFFFFFFFF : 0xFFFF));
  return out;
}
