# Third-party code

- **BitKnit2 decoder** (`lib/bitknit2.js`): JavaScript port of `rans.h` from pybg3, https://github.com/eiz/pybg3. Copyright (C) 2024 Mackenzie Straight. MIT License.
- **Granny 2 file layout** (`lib/granny.js`): follows libbg3, https://github.com/eiz/libbg3. Copyright (C) 2024 Mackenzie Straight. MIT License.
- **.pak, virtual texture and QTangent conventions** (`lib/pak.js`, `lib/vt.js`, `lib/mesh.js`): follow LSLib, https://github.com/Norbyte/lslib. Copyright (c) 2015 Norbyte. MIT License.
- **LSF / LOCA readers and animation curves** (`lib/lsf.js`, `lib/anim.js`): follow LSLib's readers and curve formats, https://github.com/Norbyte/lslib. Copyright (c) 2015 Norbyte. MIT License.
- **BC1-BC7 texture decoding** (`lib/bcdecode.js`): written from the Direct3D block-compression specification, structured after bcdec by Sergii Kudlai (https://github.com/iOrange/bcdec, MIT License); verified against Pillow's decoder.
- **LZ4 block decoder** (`lib/lz4.js`): written for this project from the LZ4 block format specification.
- **FastLZ format** (`lib/fastlz.js`): FastLZ by Ariya Hidayat, MIT License.
- **three.js** (loaded from a CDN): MIT License.
- **Cinzel** and **EB Garamond** fonts (loaded from Google Fonts, not redistributed): SIL Open Font License 1.1.

The project's own code is released under the MIT License; see `LICENSE`.

No Baldur's Gate 3 game data is included in this project. All game content is read from the user's own installation, in their browser.
