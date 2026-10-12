"""Reference DDS decoder for test/dds-test.mjs (run with `python -I dds_ref.py`).

Protocol (binary, little-endian):
  stdin : repeated  [u32 length][DDS file bytes]
  stdout: per input [u32 meta length][meta JSON utf-8][width*height*4 RGBA bytes]
meta = {"w":..,"h":..,"mode":..} or {"error": "..."} (no pixel bytes then).
Pillow decodes only the top mip; L (BC4) and RGB (BC5) are expanded with convert('RGBA').
Input bytes are treated purely as image data.
"""
import io, json, struct, sys

from PIL import Image


def main():
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    while True:
        hdr = inp.read(4)
        if len(hdr) < 4:
            break
        (n,) = struct.unpack('<I', hdr)
        data = inp.read(n)
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            mode = im.mode
            px = im.convert('RGBA').tobytes()
            meta = {'w': im.width, 'h': im.height, 'mode': mode}
        except Exception as e:  # report and continue
            meta, px = {'error': repr(e)}, b''
        mb = json.dumps(meta).encode()
        out.write(struct.pack('<I', len(mb)) + mb + px)
        out.flush()


if __name__ == '__main__':
    main()
