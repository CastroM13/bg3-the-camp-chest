// DDS container parser. Pure ES module: no DOM / Node APIs, safe in a Web Worker.
//
// parseDDS(bytes: Uint8Array | ArrayBuffer) ->
//   { width, height, format, srgb, mips: [{ width, height, data: Uint8Array }], fourCC, dxgiFormat, arraySize, cubemap }
//   format: 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC5' | 'BC7' | 'RGBA8' | 'BGRA8' | 'RGBX8' | 'BGRX8'
//   Only the first surface (array slice 0 / cube face +X) is returned; every mip level of it that fits in
//   the file is parsed. mip data are subarray views into `bytes` (no copy).
// Feed each mip to decodeBC(format, mip.data, mip.width, mip.height) from ./bcdecode.js.

import { surfaceSize } from './bcdecode.js';

const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_ALPHAPIXELS = 0x1, DDPF_FOURCC = 0x4, DDPF_RGB = 0x40;
const DDSCAPS2_CUBEMAP = 0x200;

const FOURCC = {
  DXT1: 'BC1', DXT2: 'BC2', DXT3: 'BC2', DXT4: 'BC3', DXT5: 'BC3',
  BC4U: 'BC4', ATI1: 'BC4', BC5U: 'BC5', ATI2: 'BC5',
};

// dxgi -> [format, srgb]
const DXGI = {
  27: ['RGBA8', false], 28: ['RGBA8', false], 29: ['RGBA8', true],
  70: ['BC1', false], 71: ['BC1', false], 72: ['BC1', true],
  73: ['BC2', false], 74: ['BC2', false], 75: ['BC2', true],
  76: ['BC3', false], 77: ['BC3', false], 78: ['BC3', true],
  79: ['BC4', false], 80: ['BC4', false],
  82: ['BC5', false], 83: ['BC5', false],
  87: ['BGRA8', false], 88: ['BGRX8', false],
  90: ['BGRA8', false], 91: ['BGRA8', true], 92: ['BGRX8', false], 93: ['BGRX8', true],
  97: ['BC7', false], 98: ['BC7', false], 99: ['BC7', true],
};

function fourccStr(v) {
  return String.fromCharCode(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

export function parseDDS(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (bytes.length < 128) throw new Error('parseDDS: file too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('parseDDS: bad magic');
  const u32 = (o) => dv.getUint32(o, true);
  const flags = u32(8), height = u32(12), width = u32(16);
  const mipCountField = u32(28);
  const pfFlags = u32(80), fourccV = u32(84), bitCount = u32(88);
  const rMask = u32(92), gMask = u32(96), bMask = u32(100), aMask = u32(104);
  const caps2 = u32(112);
  if (!width || !height) throw new Error('parseDDS: zero size');

  let format = null, srgb = false, dxgiFormat = 0, arraySize = 1, offset = 128, fourCC = '';
  if (pfFlags & DDPF_FOURCC) {
    fourCC = fourccStr(fourccV);
    if (fourCC === 'DX10') {
      if (bytes.length < 148) throw new Error('parseDDS: truncated DX10 header');
      dxgiFormat = u32(128);
      arraySize = u32(140) || 1;
      offset = 148;
      const f = DXGI[dxgiFormat];
      if (!f) throw new Error(`parseDDS: unsupported DXGI format ${dxgiFormat}`);
      [format, srgb] = f;
    } else {
      format = FOURCC[fourCC];
      if (!format) throw new Error(`parseDDS: unsupported FourCC '${fourCC}' (0x${fourccV.toString(16)})`);
    }
  } else if ((pfFlags & DDPF_RGB) && bitCount === 32) {
    const hasA = (pfFlags & DDPF_ALPHAPIXELS) && aMask === 0xff000000;
    if (rMask === 0xff && gMask === 0xff00 && bMask === 0xff0000) format = hasA ? 'RGBA8' : 'RGBX8';
    else if (rMask === 0xff0000 && gMask === 0xff00 && bMask === 0xff) format = hasA ? 'BGRA8' : 'BGRX8';
    else throw new Error(`parseDDS: unsupported RGB masks ${[rMask, gMask, bMask, aMask].map((m) => m.toString(16))}`);
  } else {
    throw new Error(`parseDDS: unsupported pixel format (flags 0x${pfFlags.toString(16)}, bits ${bitCount})`);
  }

  // Mip count: honour the field even if DDSD_MIPMAPCOUNT is missing (common in the wild), clamp to
  // what is actually possible and what fits in the file.
  let mipCount = (flags & DDSD_MIPMAPCOUNT) || mipCountField > 1 ? Math.max(1, mipCountField) : 1;
  const maxMips = 32 - Math.clz32(Math.max(width, height));
  if (mipCount > maxMips) mipCount = maxMips;

  const mips = [];
  let w = width, h = height, o = offset;
  for (let i = 0; i < mipCount; i++) {
    const size = surfaceSize(format, w, h);
    if (o + size > bytes.length) {
      if (i === 0) throw new Error(`parseDDS: truncated (need ${o + size} bytes, have ${bytes.length})`);
      break;
    }
    mips.push({ width: w, height: h, data: bytes.subarray(o, o + size) });
    o += size;
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }
  return { width, height, format, srgb, mips, fourCC, dxgiFormat, arraySize, cubemap: !!(caps2 & DDSCAPS2_CUBEMAP) };
}
