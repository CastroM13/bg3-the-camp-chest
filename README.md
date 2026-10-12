# Camp Chest

**An unofficial, free fan catalogue of Baldur's Gate 3 items that reads everything from your own copy of the game.**

Camp Chest lets you browse every equippable item in Baldur's Gate 3, look at it in 3D, read its stats, try the game's
dyes on it, and dress a character in the Dressing Room. The website hosts **only code**. Every model, texture, icon and
line of text comes from *your* installed game, read locally in your browser.

> Camp Chest is a non-commercial fan project. It is not affiliated with, endorsed by, or sponsored by Larian Studios or
> Wizards of the Coast. See the [legal notice](LEGAL.md).

## Features

- **Full catalogue** of equippable items (weapons, armour, clothing, shields, accessories), searchable and filterable,
  with rarity, stats and descriptions as they appear in the game.
- **3D models** of every item, both as loot and as worn on a character, rendered with three.js.
- **Game dyes**: preview any of the game's dyes on an item.
- **Dressing Room**: combine items into an outfit on a character, with poses and different body types.

## Bring your own game

The site doesn't contain any Baldur's Gate 3 content. Instead it asks your browser for read-only access to your game
folder and builds everything from the game's own `.pak` files, in the browser. The first visit takes about half a
minute while it reads the game's item data; models and textures are then built on demand the first time you open them,
and kept in your browser's private storage so later visits start in a couple of seconds.

Why it works this way:

- **Respect for the creators.** Game assets belong to Larian Studios and their partners. Hosting extracted models,
  textures or text would mean redistributing them. Reading them from a copy you already own does not.
- **Always up to date.** When the game is patched, the catalogue reflects your installed version. There's no stale
  extracted data set to maintain.
- **Privacy.** Your files never leave your computer (see below).

## Requirements

- **Baldur's Gate 3, installed** on the computer you're using, and you must own it (Steam and GOG installs work;
  Xbox app / PC Game Pass installs may not, because their files can be protected).
- **Desktop Chrome or Microsoft Edge** (tested). Other desktop browsers that support folder selection may work but are
  untested. Mobile browsers can't open folders.
- A reasonably modern GPU for WebGL, and enough memory to decode textures (a few GB of RAM is comfortable).

## How to use

1. Open the site in desktop Chrome or Edge.
2. Read the notice, tick *"I own Baldur's Gate 3 and understand game files are read locally from my computer"*, and
   click **Select the Data folder**.
3. Pick the game's `Data` folder. Common locations:

   | Install | Folder |
   |---|---|
   | Steam (default) | `C:\Program Files (x86)\Steam\steamapps\common\Baldurs Gate 3\Data` |
   | Steam library on another drive | `<Drive>:\SteamLibrary\steamapps\common\Baldurs Gate 3\Data` |
   | GOG Galaxy | `C:\Program Files (x86)\GOG Galaxy\Games\Baldurs Gate 3\Data` |
   | Xbox app / PC Game Pass (may not work) | `C:\XboxGames\Baldur's Gate 3\Content\Data` |
   | macOS (Steam) | `~/Library/Application Support/Steam/steamapps/common/Baldurs Gate 3/Baldur's Gate 3.app/Contents/Data` |

   To find yours: in **Steam**, right-click the game › *Manage* › *Browse local files*; in **GOG Galaxy**, open the game ›
   *Manage installation* › *Show folder*. On macOS, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> in the dialog to
   type a path, since the game's data sits inside the app bundle.
4. The browser asks whether to "upload" the folder's files. That is only its standard wording for folder selection:
   the files are read inside the page and never leave your computer. The site checks that the required files are
   present (`Gustav.pak`, `Shared.pak`, `Models.pak`, `Textures.pak`, `VirtualTextures.pak`, `Game.pak`,
   `Localization/English.pak`) and then opens the catalogue.

The browser can't remember a folder between visits, so a short *Welcome back* screen asks you to pick `Data` again.
Later visits still open in a couple of seconds, because what was built last time is kept on your computer.

> Why not the newer folder picker (`showDirectoryPicker`)? It would remember the folder, but Chrome and Edge refuse it
> for anything inside `Program Files`, which is where Steam installs the game by default.

## Privacy

- Everything happens **locally in your browser**. Game files are never uploaded, and nothing is sent to a server.
- The site has no accounts, no analytics and no ads. The only third-party requests are for code and fonts: three.js
  from a CDN (jsDelivr) and the Cinzel / EB Garamond fonts from Google Fonts. Like any web request, those services can
  see your IP address; they never receive game files.
- The catalogue, models and textures built from your files are kept in the browser's origin-private file system on
  your computer so later visits are fast, and are rebuilt automatically after a game patch. IndexedDB only records
  that you accepted the notice and the folder's name. Use **Change game folder** (bottom of the page) or clear the
  site's data in your browser settings to remove them.

## How it works

All of this runs in your browser. There is no backend.

- **Folder access** (`onboarding.js`, `engine/filesdir.js`): the folder dialog (`<input webkitdirectory>`) gives
  `File` objects for every file in the folder; they are wrapped in a small directory-like interface and validated.
- **Pak reader** (`lib/pak.js`): reads the LSPK v18 archive format directly from `File`/`Blob` slices, so multi-GB
  archives (and their `_1`, `_2`, … parts) are never loaded into memory whole.
- **BitKnit2 decoder** (`lib/bitknit2.js`): a JavaScript port of the rANS-based BitKnit2 decompressor used by the game's
  Granny 2 (`.gr2`) model files. LZ4 and FastLZ (`lib/lz4.js`, `lib/fastlz.js`) handle other compressed data.
- **Granny 2 models** (`lib/granny.js`, `lib/mesh.js`): parse `.gr2` files into meshes and skeletons (positions,
  QTangent-encoded normals/tangents, UVs, skin weights).
- **Virtual texture rebuild** (`lib/vt.js`, `lib/bc.js`): many textures live in the game's virtual-texture tile sets
  (`.gts`/`.gtp`). The site reassembles a material's texture from its tiles back into ordinary BC-compressed images.
- **LSF reader** (`lib/lsf.js`): parses the game's binary LSF resource files (item templates, visuals, materials) and
  `.loca` localisation files for item names and descriptions.
- **Service Worker virtual file system** (`sw.js`): the app UI simply `fetch`es paths under `vfs/` (item lists, glTF
  models, PNG textures and icons). The service worker intercepts those requests and asks the in-page engine (running in
  a Web Worker) to build the response on demand from the `.pak` files.
- **Rendering**: three.js, loaded from a CDN, renders the generated glTF models.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module contracts.

## Development

The site is plain static files with ES modules; there is no build step.

```sh
# from this folder, any static server works, for example:
python -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080/>. Folder access and service workers only work in a **secure context**:
`https://` or `http://localhost`. Opening `index.html` from `file://` or over plain `http://` on another host will not
work.

Format readers in `lib/` are DOM-free ES modules, so they also run in Node for tests (`node test/<name>.mjs`; most
tests need a local game install and compare against reference exports you make yourself, never committed).

- `node test/engine-test.mjs "<path to Baldurs Gate 3/Data>"` builds the item index and a few models in Node.
- `python -I test/dev_server.py . "<path to Baldurs Gate 3/Data>"` serves the site on <http://localhost:8772/> and
  exposes your local game folder to it **on this machine only**, so `http://localhost:8772/?devdata` can be tested by
  automated browsers that cannot use the folder dialog. The `?devdata` switch only works on localhost.
- After editing `LEGAL.md`, run `node tools/build-legal.mjs` to regenerate `legal.html`.

## Deployment (GitHub Pages)

The site is live at <https://castrom13.github.io/bg3-the-camp-chest/>.

`.github/workflows/pages.yml` publishes it on every push to `main`: it refuses to run if any game-like file
(`.pak`, `.gr2`, `.dds`, images, models, …) is tracked, then deploys only what the site needs (`index.html`,
`legal.html`, `onboarding.*`, `sw.js`, `app/`, `engine/`, `lib/`, licence and notices). Tests and tools are not
deployed. One-time setup: **Settings › Pages › Build and deployment › Source: GitHub Actions**.

GitHub Pages serves over HTTPS, which folder access and service workers require. Keep `sw.js` at the site root so its
scope covers `vfs/`. After editing `LEGAL.md`, run `node tools/build-legal.mjs` to regenerate `legal.html`.

## Credits

Camp Chest builds on the work of the BG3 modding community. Third-party code and the formats it follows (LSLib,
pybg3 / libbg3, FastLZ, three.js and others) are credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Legal

Camp Chest is an unofficial, non-commercial fan project and is not affiliated with Larian Studios. It contains no game
content; you need your own copy of the game. The project's own code is released under the [MIT License](LICENSE). See
[LEGAL.md](LEGAL.md) for the full notice, including trademarks, your obligations, and how to send a removal request.

Source: <https://github.com/CastroM13/bg3-the-camp-chest>
