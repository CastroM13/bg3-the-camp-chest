// BG3 Catalog - Dressing Room 3D scene (ES module, three.js r160 via the import map).
// See CONTRACT.md "Dressing Room". One WebGL context; create it lazily.
//
//   import { createDressingRoom } from './dressing.js';
//   const dr = createDressingRoom(container, { bodies: { M: url, F: url }, bodyType: 'F', reducedMotion });
//   await dr.setBodyType('M');                                   // (re)loads the body and every piece's rig for that type
//   await dr.setPiece('Breast', { urls: { M: rigM, F: rigF }, colors, hide: item.hideBody });   // equip / replace (idempotent)
//   dr.removePiece('Breast');
//   await dr.setPieceDye('Breast', dye.colors | null);
//   await dr.setPose({ id, animated, urls: { M, F } } | null);   // null = T-pose
//   dr.setAnimationPlaying(bool); dr.setSkinTone('#8f8b86'); dr.resetView(); dr.setActive(bool); dr.dispose();
//   dr.on('loading', n => ...); dr.on('piece', (slot, info) => ...); dr.on('error', (what, err) => ...)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {
  dyeMaterialsOf, resolveDyeUrls, configureDyeTexture, setMaterialDye, undyeMaterial,
} from './dye-shader.js';
import { applyBodyHide } from './body-hide.js';

const DEG = Math.PI / 180;
const DEFAULTS = {
  bodies: { M: '../vfs/dressing/body_M.gltf', F: '../vfs/dressing/body_F.gltf' },
  heads: { M: '../vfs/dressing/head_M.gltf', F: '../vfs/dressing/head_F.gltf' },   // game's mannequin heads
  bodyType: 'M',
  skin: '#8f8b86',          // neutral clay mannequin
  reducedMotion: false,     // true: animated poses start paused on a still frame
  fov: 30,
  exposure: 1.0,
  envIntensity: 0.85,
  shadow: true,
  maxCachedModels: 32,      // unused glTFs kept in memory (CPU + textures) for quick re-equips
};

export function createDressingRoom(container, options = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('createDressingRoom: container must be an HTMLElement');
  const opts = { ...DEFAULTS, ...options, bodies: { ...DEFAULTS.bodies, ...(options.bodies || {}) },
    heads: { ...DEFAULTS.heads, ...(options.heads || {}) } };

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure;
  renderer.shadowMap.enabled = !!opts.shadow;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Dressing room character preview. Drag to rotate, scroll or pinch to zoom.');
  container.appendChild(canvas);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment(renderer);
  const envRT = pmrem.fromScene(roomEnv, 0.04);
  scene.environment = envRT.texture;
  disposeTree(roomEnv);

  const camera = new THREE.PerspectiveCamera(opts.fov, 1, 0.02, 100);
  camera.position.set(0, 1.1, 5);

  const hemi = new THREE.HemisphereLight(0xfff1dc, 0x1a1208, 0.4);
  const key = new THREE.DirectionalLight(0xfff4e6, 2.3);
  key.castShadow = !!opts.shadow;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  const rim = new THREE.DirectionalLight(0xffb85c, 2.6);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.5);
  scene.add(hemi, key, key.target, rim, rim.target, fill, fill.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.4, transparent: true, depthWrite: false }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = -1;
  ground.visible = false;
  scene.add(ground);

  // Everything worn shares the body's space; turn the whole character to face the camera (+Z).
  const character = new THREE.Group();
  character.name = 'character';
  character.rotation.y = Math.PI;
  scene.add(character);

  // One mannequin material per loaded body (body-hide uniforms live on it); skin tone is remembered here.
  let skinHex = opts.skin;
  const makeBodyMaterial = () => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: opts.envIntensity });
    m.name = 'mannequin';
    paintSkin(m);
    return m;
  };

  // ---------------------------------------------------------------- controls
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = 175 * DEG;
  let userMoved = false;
  let tween = null;
  const onStart = () => { userMoved = true; tween = null; needsRender = true; };
  const onChange = () => { needsRender = true; };
  controls.addEventListener('start', onStart);
  controls.addEventListener('change', onChange);

  // ------------------------------------------------------------------ state
  const listeners = new Map();
  let disposed = false;
  let active = true;
  let needsRender = true;
  let bodyType = opts.bodyType === 'F' ? 'F' : 'M';
  let body = null;             // { type, root, floorY, head, headUrl, headMaterial }
  let bodySeq = 0;
  const pieces = new Map();    // slot -> { urls, colors, seq, root, url, dyeable, status }
  let pose = null;             // { id, animated, urls:{M,F} } or null (T-pose)
  let activeClip = null;       // AnimationClip for the current body type, null = T-pose
  let activeAnimated = false;
  let poseSeq = 0;
  let playing = !opts.reducedMotion;
  let animTime = 0;
  const mixers = new Map();    // model root -> AnimationMixer
  let pending = 0;
  let home = null;
  const clock = new THREE.Clock();

  function emit(type, ...args) {
    for (const fn of [...(listeners.get(type) || [])]) {
      try { fn(...args); } catch (e) { console.error(`dressing "${type}" listener failed`, e); }
    }
  }
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }
  const busy = (d) => { pending = Math.max(0, pending + d); emit('loading', pending); };

  // ------------------------------------------------------------- glTF cache
  // url -> { promise: Promise<gltf>, gltf, refs, used }
  const gltfCache = new Map();
  const loader = new GLTFLoader();

  function acquire(url) {
    let e = gltfCache.get(url);
    if (!e) {
      e = { promise: null, gltf: null, refs: 0, used: 0 };
      e.promise = loader.loadAsync(url).then((g) => { e.gltf = g; return g; });
      e.promise.catch(() => { if (gltfCache.get(url) === e) gltfCache.delete(url); });
      gltfCache.set(url, e);
    }
    e.refs++;
    e.used = performance.now();
    return e.promise;
  }

  function release(url) {
    const e = gltfCache.get(url);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    e.used = performance.now();
    // Nobody shows it any more: free the GPU geometry (re-uploaded if it is equipped again).
    if (e.refs === 0 && e.gltf) forEachMesh(e.gltf.scene, (o) => o.geometry?.dispose());
    trimCache();
  }

  function trimCache() {
    const unused = [...gltfCache.entries()].filter(([, e]) => e.refs === 0 && e.gltf).sort((a, b) => a[1].used - b[1].used);
    while (unused.length > opts.maxCachedModels) {
      const [url, e] = unused.shift();
      gltfCache.delete(url);
      disposeTree(e.gltf.scene, dyeTextures);
    }
  }

  /** A private, skinned copy of a cached glTF scene with its own materials (so dyes stay per piece). */
  function instantiate(gltf, url, { replaceMaterial = null } = {}) {
    const src = gltf.scene || gltf.scenes?.[0];
    if (!src) throw new Error(`"${url}" contains no scene`);
    const root = SkeletonUtils.clone(src);
    root.userData.__url = url;
    forEachMesh(root, (o) => {
      o.castShadow = !!opts.shadow;
      o.receiveShadow = !!opts.shadow;
      if (o.isSkinnedMesh) o.frustumCulled = false; // posed bounds differ from the bind pose
      if (replaceMaterial) { o.material = replaceMaterial; return; }
      o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
    });
    return root;
  }
  function cloneMat(m) {
    if (!m) return m;
    const c = m.clone();
    if ('envMapIntensity' in c) c.envMapIntensity = opts.envIntensity;
    if (c.alphaTest > 0) c.alphaToCoverage = true;
    for (const t of [c.map, c.normalMap]) if (t) t.anisotropy = maxAniso;
    return c;
  }

  /** Disposes a mounted instance: its materials, skeleton and mixer. Shared geometry/textures stay with the cache. */
  function unmount(root) {
    if (!root) return;
    stopMixer(root);
    character.remove(root);
    const mats = new Set();
    forEachMesh(root, (o) => {
      for (const m of toArray(o.material)) if (m) mats.add(m);
      if (o.isSkinnedMesh) o.skeleton?.dispose();
    });
    for (const m of mats) { undyeMaterial(m); m.dispose(); }
    if (root.userData.__url) release(root.userData.__url);
    needsRender = true;
  }

  // ---------------------------------------------------------- dye textures
  const dyeTexCache = new Map();  // 'c:'|'d:' + absolute url -> Promise<Texture|null>
  const dyeTextures = new Set();

  function loadDyeTexture(url, isColor) {
    const k = (isColor ? 'c:' : 'd:') + url;
    let p = dyeTexCache.get(k);
    if (p) return p;
    p = new THREE.TextureLoader().loadAsync(url).then((tex) => {
      configureDyeTexture(tex, isColor, maxAniso);
      tex.name = url;
      if (disposed) { tex.dispose(); return null; }
      dyeTextures.add(tex);
      return tex;
    }).catch((err) => {
      console.warn(`dressing: dye texture failed to load: ${url}`, err);
      dyeTexCache.delete(k);
      return null;
    });
    dyeTexCache.set(k, p);
    return p;
  }

  async function applyDye(root, colors, stale) {
    const mats = dyeMaterialsOf(root);
    if (!mats.length) return false;
    if (!colors) { let ch = false; for (const m of mats) ch = undyeMaterial(m) || ch; return ch; }
    const ready = await Promise.all(mats.map(async (m) => {
      const urls = resolveDyeUrls(m, root.userData.__url);
      if (!urls) return null;
      const [albedo, mask] = await Promise.all([loadDyeTexture(urls.albedo, true), loadDyeTexture(urls.mask, false)]);
      return albedo && mask ? { m, albedo, mask } : null;
    }));
    if (stale()) return false;
    let changed = false;
    for (const j of ready) if (j) { setMaterialDye(j.m, { albedo: j.albedo, mask: j.mask, colors }); changed = true; }
    return changed;
  }

  // ------------------------------------------------------------------ poses
  const clipCache = new Map();    // url -> Promise<AnimationClip|null>
  function loadClip(url) {
    let p = clipCache.get(url);
    if (!p) {
      p = new GLTFLoader().loadAsync(url).then((g) => {
        const clip = g.animations?.[0] || null;
        disposeTree(g.scene); // pose files carry no meshes worth keeping
        return clip;
      });
      p.catch(() => clipCache.delete(url));
      clipCache.set(url, p);
    }
    return p;
  }

  function stopMixer(root) {
    const mixer = mixers.get(root);
    if (!mixer) return;
    mixer.stopAllAction();      // restores every bound property to its bind-pose value
    mixer.uncacheRoot(root);
    mixers.delete(root);
  }

  /** Plays the active clip on one model root (only the tracks whose bones exist in it). */
  function applyPoseTo(root) {
    stopMixer(root);
    if (!activeClip) { needsRender = true; return; }
    const names = new Set();
    root.traverse((o) => { if (o.name) names.add(o.name); });
    const tracks = activeClip.tracks.filter((t) => names.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName));
    if (!tracks.length) return;
    const clip = new THREE.AnimationClip(activeClip.name, activeClip.duration, tracks);
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
    mixer.setTime(activeAnimated ? animTime : 0);
    mixers.set(root, mixer);
    needsRender = true;
  }

  function roots() {
    const out = [];
    if (body?.root) out.push(body.root);
    if (body?.head) out.push(body.head);
    for (const p of pieces.values()) if (p.root) out.push(p.root);
    return out;
  }
  function reapplyPose() { for (const r of roots()) applyPoseTo(r); }

  async function resolvePose() {
    const seq = ++poseSeq;
    const url = pose?.urls?.[bodyType] || null;
    if (!url) {
      activeClip = null; activeAnimated = false;
      reapplyPose();
      return true;
    }
    busy(+1);
    try {
      const clip = await loadClip(url);
      if (disposed || seq !== poseSeq) return false;
      activeClip = clip;
      activeAnimated = !!pose.animated && !!clip && clip.duration > 0;
      animTime = 0;
      reapplyPose();
      return true;
    } catch (err) {
      if (seq === poseSeq) { activeClip = null; activeAnimated = false; reapplyPose(); emit('error', 'pose', err); }
      return false;
    } finally { busy(-1); }
  }

  // ------------------------------------------------------------------- body
  async function loadBody() {
    const seq = ++bodySeq;
    const type = bodyType;
    const url = opts.bodies[type];
    if (!url) return;
    busy(+1);
    try {
      const gltf = await acquire(url);
      if (disposed || seq !== bodySeq) { release(url); return; }
      const material = makeBodyMaterial();
      const root = instantiate(gltf, url, { replaceMaterial: material });
      root.name = 'body';
      // default head (same clay/skin as the body; it has no body-hide regions of its own)
      let head = null, headMaterial = null;
      const headUrl = opts.heads?.[type];
      if (headUrl) {
        try {
          const hg = await acquire(headUrl);
          if (disposed || seq !== bodySeq) { release(headUrl); release(url); return; }
          headMaterial = makeBodyMaterial();
          head = instantiate(hg, headUrl, { replaceMaterial: headMaterial });
          head.name = 'head';
        } catch (err) { emit('error', 'head', err); }
      }
      if (body) { unmount(body.root); if (body.head) unmount(body.head); }
      character.add(root);
      if (head) character.add(head);
      root.updateMatrixWorld(true);
      forEachMesh(root, (o) => { if (o.isSkinnedMesh) o.skeleton.update(); });
      const box = new THREE.Box3().setFromObject(root);
      body = { type, root, material, floorY: isFinite(box.min.y) ? box.min.y : 0, head, headMaterial };
      updateBodyHide();
      applyPoseTo(root);
      if (head) applyPoseTo(head);
      needsRender = true;
    } catch (err) {
      if (seq === bodySeq) emit('error', 'body', err);
    } finally { busy(-1); }
  }

  // ----------------------------------------------------------------- pieces
  /**
   * Equips a piece. `urls` = { M, F } rig URLs; `colors` = dye colours or null.
   * Resolves { status: 'ok' | 'nomodel' | 'error' | 'cancelled', dyeable }.
   */
  async function setPiece(slot, { urls, colors = null, hide = null } = {}) {
    if (disposed) return { status: 'cancelled' };
    let p = pieces.get(slot);
    if (p) { p.hide = hide || null; updateBodyHide(); }
    const sameUrls = p && p.urls && urls && p.urls.M === urls.M && p.urls.F === urls.F;
    if (sameUrls) {
      if (!sameColors(p.colors, colors)) await setPieceDye(slot, colors);
      return { status: p.status, dyeable: p.dyeable };
    }
    if (!p) { p = { urls: null, colors: null, seq: 0, dyeSeq: 0, root: null, url: null, dyeable: false, status: 'empty' }; pieces.set(slot, p); }
    p.urls = urls ? { M: urls.M || null, F: urls.F || null } : { M: null, F: null };
    p.colors = colors ? clone(colors) : null;
    p.hide = hide || null;
    return loadPiece(slot);
  }

  async function loadPiece(slot) {
    const p = pieces.get(slot);
    if (!p) return { status: 'cancelled' };
    const seq = ++p.seq;
    const stale = () => disposed || pieces.get(slot) !== p || p.seq !== seq;
    const url = p.urls[bodyType];
    if (!url) {
      if (p.root) { unmount(p.root); p.root = null; p.url = null; }
      p.status = 'nomodel'; p.dyeable = false;
      updateBodyHide();
      emit('piece', slot, info(p));
      return { status: 'nomodel', dyeable: false };
    }
    if (p.root && p.url === url) return { status: p.status, dyeable: p.dyeable };
    busy(+1);
    p.status = 'loading';
    try {
      let gltf;
      try { gltf = await acquire(url); }
      catch (err) { if (!stale()) throw err; return { status: 'cancelled' }; }
      if (stale()) { release(url); return { status: 'cancelled' }; }
      const root = instantiate(gltf, url);
      root.name = 'piece:' + slot;
      const dyeable = dyeMaterialsOf(root).length > 0;
      // Recolour before it is shown so the baked colours never flash.
      if (dyeable && p.colors) await applyDye(root, p.colors, stale);
      if (!stale()) { try { if (renderer.compileAsync) await renderer.compileAsync(root, camera, scene); } catch { /* non-fatal */ } }
      if (stale()) { unmount(root); return { status: 'cancelled' }; }
      if (dyeable && p.colors) await applyDye(root, p.colors, stale); // setPieceDye may have run meanwhile
      if (stale()) { unmount(root); return { status: 'cancelled' }; }
      if (p.root) unmount(p.root);
      p.root = root; p.url = url; p.dyeable = dyeable; p.status = 'ok';
      character.add(root);
      applyPoseTo(root);
      updateBodyHide();
      needsRender = true;
      emit('piece', slot, info(p));
      refitSoon();
      return { status: 'ok', dyeable };
    } catch (err) {
      if (stale()) return { status: 'cancelled' };
      p.status = 'error';
      if (p.root) { unmount(p.root); p.root = null; p.url = null; }
      updateBodyHide();
      emit('error', slot, err);
      emit('piece', slot, info(p));
      return { status: 'error', dyeable: false, error: err };
    } finally { busy(-1); }
  }

  function removePiece(slot) {
    const p = pieces.get(slot);
    if (!p) return;
    pieces.delete(slot);
    p.seq++;
    if (p.root) unmount(p.root);
    updateBodyHide();
    emit('piece', slot, null);
    refitSoon();
  }

  async function setPieceDye(slot, colors) {
    const p = pieces.get(slot);
    if (!p) return false;
    p.colors = colors ? clone(colors) : null;
    const root = p.root;
    if (!root) return false;
    const mark = ++p.dyeSeq;
    const stale = () => disposed || p.root !== root || p.dyeSeq !== mark;
    const changed = await applyDye(root, p.colors, stale);
    if (changed && !stale()) {
      try { if (renderer.compileAsync) await renderer.compileAsync(root, camera, scene); } catch { /* non-fatal */ }
      needsRender = true;
    }
    return changed;
  }

  const info = (p) => ({ status: p.status, dyeable: p.dyeable, url: p.url });

  // ------------------------------------------------------------ body type
  async function setBodyType(type) {
    type = type === 'F' ? 'F' : 'M';
    const changed = type !== bodyType || !body;
    bodyType = type;
    if (!changed) return;
    const posePromise = resolvePose();
    await Promise.all([loadBody(), ...[...pieces.keys()].map((s) => loadPiece(s)), posePromise]);
    if (!userMoved) frame(true);
  }

  async function setPose(next) {
    pose = next && next.urls ? { id: next.id, animated: !!next.animated, urls: { ...next.urls } } : null;
    const ok = await resolvePose();
    if (ok && !userMoved) frame(true);
    return ok;
  }

  function setAnimationPlaying(on) {
    playing = !!on;
    needsRender = true;
  }

  function paintSkin(m) {
    try { m.color.set(skinHex || DEFAULTS.skin); } catch { m.color.set(DEFAULTS.skin); }
    // clay reads as matte; skin gets a slight sheen
    m.roughness = String(skinHex || '').toLowerCase() === DEFAULTS.skin ? 0.85 : 0.6;
  }
  function setSkinTone(hex) {
    skinHex = hex || DEFAULTS.skin;
    if (body?.material) paintSkin(body.material);
    if (body?.headMaterial) paintSkin(body.headMaterial);
    needsRender = true;
  }

  /** Discards the naked-body regions covered by every piece that is actually on screen (CONTRACT: hideBody). */
  function updateBodyHide() {
    if (!body?.material) return;
    const ids = new Set();
    for (const p of pieces.values()) {
      if (!p.root || p.status !== 'ok' || !isShown(p.root)) continue;
      for (const r of (p.hide?.[body.type] || [])) ids.add(r);
    }
    applyBodyHide(body.material, [...ids]);
    needsRender = true;
  }

  // --------------------------------------------------------------- framing
  function characterBox() {
    character.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    character.traverse((o) => {
      if (!o.isMesh || !isShown(o)) return;
      if (o.isSkinnedMesh) {
        o.skeleton.update();
        o.computeBoundingBox();          // skinned: follows the current pose
        tmp.copy(o.boundingBox).applyMatrix4(o.matrixWorld);
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      }
      if (isFiniteBox(tmp)) box.union(tmp);
    });
    return box;
  }

  function computeHome(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.05);
    const az = 14 * DEG, el = 6 * DEG;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const distance = fitDistance(box, center, dir, camera.fov, camera.aspect || 1) * 1.1;
    return { position: center.clone().addScaledVector(dir, distance), target: center, distance, radius, box: box.clone() };
  }

  function fitDistance(box, center, dir, fovDeg, aspect) {
    const tanV = Math.tan((fovDeg * DEG) / 2);
    const tanH = tanV * aspect;
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let d = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const t = p.dot(dir);
      d = Math.max(d, t + Math.abs(p.dot(right)) / tanH, t + Math.abs(p.dot(up)) / tanV);
    }
    return Math.max(d, 0.1);
  }

  function setupStage(h) {
    const c = h.target;
    const r = h.radius;
    const floorY = body ? Math.min(h.box.min.y, body.floorY) : h.box.min.y;
    ground.scale.set(r * 10, r * 10, 1);
    ground.position.set(c.x, floorY - 0.002, c.z);
    ground.visible = !!opts.shadow;
    const place = (light, az, el, dist) => {
      light.position.set(c.x + Math.sin(az) * Math.cos(el) * dist, c.y + Math.sin(el) * dist, c.z + Math.cos(az) * Math.cos(el) * dist);
      light.target.position.copy(c);
      light.target.updateMatrixWorld();
    };
    const dist = r * 4;
    place(key, 35 * DEG, 55 * DEG, dist);
    place(rim, 170 * DEG, 28 * DEG, dist);
    place(fill, -70 * DEG, 12 * DEG, dist);
    const sc = key.shadow.camera;
    sc.left = -r * 1.5; sc.right = r * 1.5; sc.top = r * 1.5; sc.bottom = -r * 1.5;
    sc.near = r * 0.3; sc.far = dist + r * 3;
    sc.updateProjectionMatrix();
    key.shadow.needsUpdate = true;
  }

  function applyLimits(h) {
    controls.minDistance = Math.max(h.radius * 0.25, 0.1);
    controls.maxDistance = h.distance * 3;
    camera.near = Math.max(h.radius * 0.01, 0.01);
    camera.far = (controls.maxDistance + h.radius) * 4;
    camera.updateProjectionMatrix();
  }

  /** Frames the whole character. animate=false jumps straight there. */
  function frame(animate = true) {
    const box = characterBox();
    if (box.isEmpty() || !isFiniteBox(box)) return;
    home = computeHome(box);
    setupStage(home);
    if (!animate || opts.reducedMotion) {
      tween = null;
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      applyLimits(home);
      controls.update();
    } else {
      controls.minDistance = 0; controls.maxDistance = Infinity;
      camera.far = Math.max(camera.far, home.distance * 12);
      camera.updateProjectionMatrix();
      tween = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), t0: performance.now(), dur: 0.7, home };
    }
    needsRender = true;
  }

  let refitTimer = 0;
  function refitSoon() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { if (!disposed && !userMoved) frame(true); }, 60);
  }

  function resetView() {
    userMoved = false;
    frame(true);
  }

  // ------------------------------------------------------------ resize/loop
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (home && !userMoved && !tween) frame(false);
    needsRender = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / (tween.dur * 1000));
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(tween.fromPos, tween.home.position, e);
      controls.target.lerpVectors(tween.fromTarget, tween.home.target, e);
      camera.lookAt(controls.target);
      if (k >= 1) { applyLimits(tween.home); tween = null; controls.update(); }
      needsRender = true;
    } else if (controls.update(dt)) needsRender = true;

    if (activeAnimated && playing && mixers.size) {
      animTime += dt;
      for (const m of mixers.values()) m.update(dt);
      needsRender = true;
    }
    if (needsRender && container.clientWidth > 0 && container.clientHeight > 0) {
      renderer.render(scene, camera);
      needsRender = false;
    }
  }
  let running = false;
  function syncLoop() {
    const want = active && !disposed && !document.hidden;
    if (want === running) return;
    running = want;
    if (want) { clock.getDelta(); needsRender = true; }
    renderer.setAnimationLoop(want ? tick : null);
  }
  const onVisibility = () => syncLoop();
  document.addEventListener('visibilitychange', onVisibility);
  syncLoop();

  /** Pauses rendering while the Dressing Room view is hidden. */
  function setActive(on) { active = !!on; syncLoop(); if (active) resize(); }

  // ----------------------------------------------------------------- dispose
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(refitTimer);
    for (const slot of [...pieces.keys()]) removePiece(slot);
    if (body) { unmount(body.root); if (body.head) unmount(body.head); body = null; }
    for (const [, e] of gltfCache) if (e.gltf) disposeTree(e.gltf.scene, dyeTextures);
    gltfCache.clear();
    for (const t of dyeTextures) t.dispose();
    dyeTextures.clear(); dyeTexCache.clear(); clipCache.clear();
    renderer.setAnimationLoop(null);
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    controls.removeEventListener('start', onStart);
    controls.removeEventListener('change', onChange);
    controls.dispose();
    listeners.clear();
    disposeTree(ground);
    key.shadow.map?.dispose();
    scene.environment = null;
    envRT.dispose();
    pmrem.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  // Start with the body of the initial type.
  const ready = (async () => {
    await Promise.all([loadBody(), resolvePose()]);
    frame(false);
  })();

  return {
    ready,
    setBodyType,
    setPiece,
    removePiece,
    setPieceDye,
    setPose,
    setAnimationPlaying,
    setSkinTone,
    resetView,
    setActive,
    dispose,
    on,
    get hiddenRegions() { return body?.material?.userData.bodyHide ? [...body.material.userData.bodyHide.uHidden.value].filter((v) => v >= 0) : []; },
    pieceInfo: (slot) => { const p = pieces.get(slot); return p ? info(p) : null; },
    get bodyType() { return bodyType; },
    get loading() { return pending; },
    get animated() { return activeAnimated; },
    get playing() { return playing; },
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
  };
}

// ------------------------------------------------------------------ helpers
const toArray = (m) => (Array.isArray(m) ? m : [m]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const sameColors = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

function forEachMesh(root, fn) { root?.traverse((o) => { if (o.isMesh) fn(o); }); }

function isShown(o) {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function isFiniteBox(b) {
  return !b.isEmpty() && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
}

/** Disposes geometries, materials and textures under root (textures in `keep` are spared). */
function disposeTree(root, keep) {
  if (!root) return;
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    if (o.material) for (const m of toArray(o.material)) if (m) mats.add(m);
  });
  for (const m of mats) for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  for (const t of texs) {
    if (keep && keep.has(t)) continue;
    const img = t.source && t.source.data;
    t.dispose();
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
  }
}
