# Camp Chest (web): architecture and module contracts

The site hosts **only code**. Every piece of game content (models, textures, icons, names, stats) is read from the
visitor's own Baldur's Gate 3 install, inside their browser. The folder is chosen with the browser's folder dialog (`<input webkitdirectory>`), wrapped by
`engine/filesdir.js` in a small directory-handle-like interface.
Nothing is uploaded anywhere.

```
site/
  index.html            entry: the first-visit notice + folder dialog, then the app
  app/                  the catalogue / dyes / Dressing Room UI (fetches everything under vfs/)
  sw.js                 service worker: serves vfs/* requests by asking the page's engine to build them
  engine/               runs in a dedicated Worker: opens the .pak files, builds the item index, builds assets
  lib/                  format readers (pure ES modules, no DOM; run in Worker and in Node for tests)
```

All lib/ modules are plain ES modules with no dependencies on the DOM, so they run in a Web Worker and in Node
(tests live in `test/`, run with `node test/<name>.mjs`). Inputs are `Uint8Array`s.

## lib/ contracts

### lib/pak.js (done)
`new Pak(getPart).open()`; `pak.files: Map<path, entry>`; `await pak.read(path) -> Uint8Array`.
`getPart(partIndex)` returns a Blob/File (part 0 = `Name.pak`, part n = `Name_n.pak`).

### lib/granny.js + lib/mesh.js (done)
`new Granny(bytes)`; `g.root()` -> plain object tree (Meshes, Skeletons, Models, TrackGroups, Animations, ...).
`decodeMesh(g, meshObj)` -> `{ name, vertexCount, positions, normals, tangents, uvs, indices, joints, weights, boneNames, colors }`.
Skeleton bones: `root.Skeletons[i].Bones[j] = { Name, ParentIndex, Transform:{translation, rotation[x,y,z,w], scaleShear[9]}, InverseWorldTransform[16] }`.

### lib/vt.js, lib/bc.js, lib/fastlz.js, lib/lz4.js (done)
`new TileSet(gtsBytes, readPage)`; `await set.extract(gtexName, layer, level) -> {width,height,level,data(BC3 blocks)}`.

### lib/lsf.js (done; tests: test/lsf-test.mjs [--all], test/lsf-compress-test.mjs, test/loca-test.mjs)
Sync `parseLSF` handles uncompressed + LZ4 (block/frame) sections; `parseLSFAsync` also handles zlib; zstd throws.
Extras: `node.key` (LSX `key=`), `formatAttr(attr)` -> exact LSX value text, `AttrTypeNames[type]` -> LSX type name,
`parseLocaEntries(bytes) -> [{handle, version, text}]`. 64-bit ints are numbers when safe, else decimal strings;
ScratchBuffer is a Uint8Array; matrices are full-precision row-major text (LSX prints 2 decimals).
`parseLSF(bytes) -> { regions: { [regionName]: Node } }` for LSOF version 7 (BG3).
`Node = { id: string, attrs: { [name]: Attr }, children: Node[] }`
`Attr = { type: number, value: any, handle?: string, version?: number }` where `value` is:
- numbers for ints/floats/bool (bool -> true/false), strings for FixedString/LSString/Path/WString,
- `"x y z"`-style space-joined strings for vectors/matrices (same text as LSLib's LSX output),
- GUID/UUID as the lowercase string LSLib's LSX shows,
- TranslatedString: `value` = the handle string (as LSX shows `handle=`), plus `handle`/`version` fields.
Children order and attribute names must match what Divine's LSX conversion shows for the same file.
Also `parseLoca(bytes) -> Map<handle, text>` for `.loca` (LOCA format).

### lib/dds.js + lib/bcdecode.js (to build)
`parseDDS(bytes) -> { width, height, format: 'BC1'|'BC3'|'BC4'|'BC5'|'BC7'|'RGBA8'|..., srgb, mips: [{width,height,data:Uint8Array}] }`
`decodeBC(format, data, width, height) -> Uint8Array RGBA8` for BC1, BC3, BC4 (R -> RGB grey, A=255), BC5 (RG, B=0, A=255), BC7.
Output must match Pillow's decode of the same file (max channel diff <= 1).

### lib/anim.js (to build)
`decodeAnimation(g, root, skeletonBoneNames?) -> { name, duration, tracks: [ { bone, times:Float32Array, rotations:Float32Array(xyzw), translations:Float32Array(xyz), scales:Float32Array(xyz) } ] }`
from a Granny animation file (root.Animations[0].TrackGroups[0].TransformTracks), sampling every curve format BG3 uses.
Values must match LSLib's export (output/dressing/poses/*/*.glb are LSLib's glTF exports of the same GR2 files, conformed to
HUM_M_Base / HUM_F_Base).

## engine/ (done)
- `engine/gamefs.js`: one case-insensitive file index over the .pak archives (patch archives override).
- `engine/index.js`: builds items.json / dyes.json / dressing.json from stats, RootTemplates, resource banks, VisualSlots,
  GoldValues and localisation (port of the offline Python pipeline).
- `engine/assets.js`: builds glTF + PNG files on request (icons, item models with baked dyes, rigs, mannequin body/head,
  poses as glTF animations).
- `engine/main.js` (page): starts the worker, registers `sw.js`, mounts `app/` in an iframe.
- Storage: the index and every built file are kept in the origin-private file system under `camp-chest/<game version>/`.
- `engine/worker.js`: owns the pak handles, builds `index` (items/dyes/dressing), answers `build(path)` requests for vfs.
- `vfs/` paths mirror the old offline build: `vfs/data/items.json`, `vfs/data/dyes.json`, `vfs/dressing/dressing.json`,
  `vfs/<cat>/<stat>/{icon.png,loot.gltf,worn.gltf,worn_f.gltf,rig_m.gltf,rig_f.gltf}`, `vfs/textures/*.png`, `vfs/dyes/*.png`.
