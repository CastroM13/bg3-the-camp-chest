// BG3 Catalog 3D viewer (ES module, three.js r160 via import map).
//
//   import { createViewer } from './viewer.js';
//   const v = createViewer(container, { background: 'transparent' });
//   await v.load('../weapons/WPN_Longsword/loot.gltf');
//   v.setAutoRotate(true); v.resetView(); v.dispose();
//   const off = v.on('progress', p => ...);   // p in 0..1; off() unsubscribes
//
// Dyes (see CONTRACT.md "Dyes"):
//   v.dyeable                       // true when the loaded model has a material with userData.bg3Dye
//   await v.setDye(dye.colors);     // recolour with a dye's linear-RGB `colors` dict; sticky across load()
//   await v.setDye(null);           // back to the baked look
//   v.dye                           // the current sticky colours dict (copy) or null
//   v.on('dyeable', bool => ...)    // fired after every successful load (and false on clear())
//
// See the bottom of this file / the worker report for the full API.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  dyeMaterialsOf, resolveDyeUrls, configureDyeTexture, setMaterialDye, undyeMaterial,
} from './dye-shader.js';

const DEFAULTS = {
  background: 'transparent', // 'transparent' or any CSS/three colour string, e.g. '#14110d'
  autoRotate: true,          // gentle turntable
  autoRotateSpeed: 0.9,      // three's units: 2.0 = one turn per 30 s
  resumeAutoRotateAfter: 4,  // seconds after the user stops interacting; 0 = never resume
  glow: true,                // warm radial glow disc under the item
  shadow: true,              // soft contact shadow on an invisible ground plane
  exposure: 1.0,
  envIntensity: 0.9,
  transitionDuration: 0.9,   // seconds for the camera to glide into a new framing
  fov: 32,
};

const DEG = Math.PI / 180;

// Dye shader core (slot order, mask decode, palette) is shared with dressing.js.
export { DYE_SLOTS } from './dye-shader.js';

/**
 * @param {HTMLElement} container element the canvas will fill (needs a non-zero size)
 * @param {object} [options] see DEFAULTS
 */
export function createViewer(container, options = {}) {
  if (!container || !(container instanceof HTMLElement)) {
    throw new TypeError('createViewer: container must be an HTMLElement');
  }
  const opts = { ...DEFAULTS, ...options };
  const transparent = !opts.background || opts.background === 'transparent';

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: transparent,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure;
  renderer.shadowMap.enabled = !!opts.shadow;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  if (transparent) renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.outline = 'none';
  canvas.setAttribute('aria-label', '3D item preview. Drag to rotate, scroll or pinch to zoom.');
  canvas.setAttribute('role', 'img');
  container.appendChild(canvas);

  // ---------- scene ----------
  const scene = new THREE.Scene();
  if (!transparent) scene.background = new THREE.Color(opts.background);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment(renderer);
  const envRT = pmrem.fromScene(roomEnv, 0.04);
  scene.environment = envRT.texture;
  disposeObject(roomEnv); // RoomEnvironment geometries/materials are no longer needed

  const camera = new THREE.PerspectiveCamera(opts.fov, 1, 0.01, 100);
  camera.position.set(0, 1.2, 4);

  // Lights: soft neutral key (casts the contact shadow), warm gold rim, cool low fill.
  const hemi = new THREE.HemisphereLight(0xfff1dc, 0x1a1208, 0.35);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.castShadow = !!opts.shadow;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight(0xffb85c, 3.2);
  scene.add(rim, rim.target);

  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.45);
  scene.add(fill, fill.target);

  // Ground: invisible plane that only receives the shadow, plus an optional gold glow disc.
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.42, transparent: true, depthWrite: false });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = -2;
  ground.visible = false;
  scene.add(ground);

  const glowTex = makeGlowTexture();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.renderOrder = -1;
  glow.visible = false;
  scene.add(glow);

  // ---------- controls ----------
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.autoRotate = !!opts.autoRotate;
  controls.autoRotateSpeed = opts.autoRotateSpeed;
  controls.maxPolarAngle = 179 * DEG;

  // ---------- state ----------
  const listeners = new Map(); // event -> Set<fn>
  let autoRotateWanted = !!opts.autoRotate;
  let interacting = false;
  let userPaused = false;    // auto-rotate paused because the user moved the camera
  let resumeAt = 0;
  let userMoved = false;     // the user changed the camera since the last framing
  let current = null;        // { root, url, home: {position, target, ...} }
  let loadSeq = 0;
  let tween = null;          // { fromPos, fromTarget, toPos, toTarget, t0, dur }
  let needsRender = true;
  let disposed = false;
  let running = false;
  const clock = new THREE.Clock();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  function emit(type, ...args) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error(`viewer "${type}" listener failed`, e); }
    }
  }

  const onStart = () => {
    interacting = true;
    userMoved = true;
    if (tween) { // user grabbed the camera mid-glide: hand control back immediately
      applyLimits(tween.home);
      tween = null;
    }
    userPaused = true;
    needsRender = true;
  };
  const onEnd = () => {
    interacting = false;
    resumeAt = performance.now() + opts.resumeAutoRotateAfter * 1000;
  };
  const onChange = () => { needsRender = true; };
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  controls.addEventListener('change', onChange);

  // ---------- sizing ----------
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // If the user hasn't touched the camera, keep the item framed for the new aspect ratio.
    if (current && !userMoved && !tween) {
      const home = computeHome(current.box);
      current.home = home;
      applyLimits(home);
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
    }
    needsRender = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // React to devicePixelRatio changes (moving the window between monitors, browser zoom).
  let dprQuery = null;
  const onDprChange = () => { resize(); watchDpr(); };
  function watchDpr() {
    if (dprQuery) dprQuery.removeEventListener('change', onDprChange);
    if (disposed || !window.matchMedia) return;
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  }
  watchDpr();

  // ---------- render loop ----------
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const now = performance.now();

    if (userPaused && !interacting && opts.resumeAutoRotateAfter > 0 && now >= resumeAt) userPaused = false;
    controls.autoRotate = autoRotateWanted && !interacting && !userPaused && !tween && !!current;

    if (tween) {
      const k = Math.min(1, (now - tween.t0) / (tween.dur * 1000));
      const e = easeInOutCubic(k);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
      camera.lookAt(controls.target);
      needsRender = true;
      if (k >= 1) {
        const done = tween;
        tween = null;
        applyLimits(done.home);
        controls.update();
      }
    } else if (controls.update(dt)) {
      needsRender = true;
    }

    if (needsRender && container.clientWidth > 0 && container.clientHeight > 0) {
      renderer.render(scene, camera);
      needsRender = false;
    }
  }

  function start() {
    if (running || disposed) return;
    running = true;
    clock.getDelta(); // swallow time spent hidden
    needsRender = true;
    renderer.setAnimationLoop(frame);
  }
  function stop() {
    if (!running) return;
    running = false;
    renderer.setAnimationLoop(null);
  }
  const onVisibility = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  // ---------- framing ----------
  function computeHome(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const worn = current ? current.worn : false;

    // Loot lies on the ground: look down at ~38°, from the side perpendicular to its long axis.
    // Worn shells stand up and (after our 180° turn) face +Z: look from the front, slightly above.
    let azimuth, elevation;
    if (worn) {
      azimuth = 20 * DEG;
      elevation = 8 * DEG;
    } else {
      azimuth = (size.z > size.x ? 90 * DEG : 0) + 28 * DEG;
      elevation = (size.y > Math.max(size.x, size.z) ? 12 : 38) * DEG; // upright loot (e.g. banners): lower angle
    }
    const dir = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    ).normalize();

    const distance = fitDistance(box, center, dir, camera.fov, camera.aspect || 1) * 1.18;
    const position = center.clone().addScaledVector(dir, distance);
    return { position, target: center, distance, radius, dir };
  }

  // Smallest camera distance along `dir` (from center) that keeps every box corner inside the frustum.
  function fitDistance(box, center, dir, fovDeg, aspect) {
    const tanV = Math.tan((fovDeg * DEG) / 2);
    const tanH = tanV * aspect;
    const fwd = dir.clone().negate(); // camera looks along -dir
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let d = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const towardCam = p.dot(dir);
      d = Math.max(d, towardCam + Math.abs(p.dot(right)) / tanH, towardCam + Math.abs(p.dot(up)) / tanV);
    }
    return Math.max(d, 1e-3);
  }

  function applyLimits(home) {
    const r = home.radius;
    controls.minDistance = Math.max(r * 0.35, 0.02);
    controls.maxDistance = home.distance * 3.5;
    camera.near = Math.max(r * 0.01, 0.002);
    camera.far = (controls.maxDistance + r) * 4;
    camera.updateProjectionMatrix();
  }

  function setupStage(box, radius, home) {
    const floorY = box.min.y;
    const center = box.getCenter(new THREE.Vector3());

    // Ground + glow sized to the footprint.
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, radius);
    ground.scale.set(radius * 12, radius * 12, 1);
    ground.position.set(center.x, floorY - radius * 0.002, center.z);
    ground.visible = !!opts.shadow;
    glow.scale.set(span * 1.9, span * 1.9, 1);
    glow.position.set(center.x, floorY - radius * 0.001, center.z);
    glow.visible = !!opts.glow;

    // Lights placed relative to the initial view direction so the rim stays behind the item.
    const viewAz = Math.atan2(home.dir.x, home.dir.z);
    const place = (light, azOffset, elev, dist) => {
      const a = viewAz + azOffset;
      light.position.set(
        center.x + Math.sin(a) * Math.cos(elev) * dist,
        center.y + Math.sin(elev) * dist,
        center.z + Math.cos(a) * Math.cos(elev) * dist,
      );
      light.target.position.copy(center);
      light.target.updateMatrixWorld();
    };
    const dist = radius * 4;
    place(key, 35 * DEG, 62 * DEG, dist);     // high, front-right: drives the contact shadow
    place(rim, 170 * DEG, 28 * DEG, dist);    // behind, slightly left: warm gold edge
    place(fill, -70 * DEG, 12 * DEG, dist);   // low cool fill from the left

    const sc = key.shadow.camera;
    sc.left = -radius * 1.6; sc.right = radius * 1.6;
    sc.top = radius * 1.6; sc.bottom = -radius * 1.6;
    sc.near = radius * 0.5; sc.far = dist + radius * 3;
    sc.updateProjectionMatrix();
    key.shadow.needsUpdate = true;
  }

  function prepareModel(root) {
    let meshes = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      o.castShadow = !!opts.shadow;
      o.receiveShadow = !!opts.shadow;
      for (const m of toArray(o.material)) {
        if (!m) continue;
        if ('envMapIntensity' in m) m.envMapIntensity = opts.envIntensity;
        for (const tex of texturesOf(m)) {
          if (tex !== m.normalMap && tex.colorSpace !== THREE.SRGBColorSpace) continue;
          tex.anisotropy = maxAniso; // sharper base colour / normal at grazing angles
        }
        if (m.alphaTest > 0) m.alphaToCoverage = true; // smoother cut-out edges (MASK) with MSAA
        m.needsUpdate = true;
      }
    });
    return meshes;
  }

  // ---------- dyes ----------
  let dyeColors = null;              // sticky colours dict (copy) or null
  let dyeSeq = 0;                    // bumps on every setDye(); stale applications bail out
  const dyeTexCache = new Map();     // absolute URL -> Promise<Texture|null>
  const dyeTextures = new Set();     // every texture we created (never disposed with a model)

  function loadDyeTexture(url, isColor) {
    const key = (isColor ? 'c:' : 'd:') + url;
    let p = dyeTexCache.get(key);
    if (p) return p;
    p = new THREE.TextureLoader().loadAsync(url).then((tex) => {
      configureDyeTexture(tex, isColor, maxAniso);
      tex.name = url;
      tex.needsUpdate = true;
      if (disposed) { tex.dispose(); return null; }
      dyeTextures.add(tex);
      return tex;
    }).catch((err) => {
      console.warn(`viewer: dye texture failed to load: ${url}`, err);
      dyeTexCache.delete(key); // allow a retry later
      return null;
    });
    dyeTexCache.set(key, p);
    return p;
  }

  function undyeAll(root) {
    let changed = false;
    if (root) for (const m of dyeMaterialsOf(root)) changed = undyeMaterial(m) || changed;
    return changed;
  }

  /** Applies `colors` (or restores when null) to every dyeable material under root. Never throws. */
  async function applyDye(root, colors, stale) {
    const mats = dyeMaterialsOf(root);
    if (!mats.length) return false;
    if (!colors) return undyeAll(root);

    const jobs = mats.map(async (m) => {
      const urls = resolveDyeUrls(m, root.userData.__url);
      if (!urls) return null;
      const [albedo, mask] = await Promise.all([loadDyeTexture(urls.albedo, true), loadDyeTexture(urls.mask, false)]);
      return albedo && mask ? { m, albedo, mask } : null;
    });
    const ready = await Promise.all(jobs);
    if (stale()) return false;

    let changed = false;
    for (const job of ready) {
      if (!job) continue;
      setMaterialDye(job.m, { albedo: job.albedo, mask: job.mask, colors });
      changed = true;
    }
    return changed;
  }

  /** Applies the sticky dye to root, re-applying if setDye() was called meanwhile. */
  async function applyStickyDye(root, stale) {
    let colors, seq;
    do {
      colors = dyeColors; seq = dyeSeq;
      await applyDye(root, colors, () => stale() || seq !== dyeSeq);
    } while (!stale() && seq !== dyeSeq);
  }

  /** Restores baked maps (so they get disposed with the model) and disposes it, keeping cached dye textures. */
  function disposeModel(root) {
    if (!root) return;
    undyeAll(root);
    disposeObject(root, dyeTextures);
  }

  async function renderSoon(root) {
    try { if (renderer.compileAsync && root) await renderer.compileAsync(root, camera, scene); } catch { /* non-fatal */ }
    if (disposed) return;
    if (container.clientWidth > 0 && container.clientHeight > 0) renderer.render(scene, camera);
    needsRender = true;
  }

  async function setDye(colors) {
    if (disposed) return;
    if (colors != null && typeof colors !== 'object') throw new TypeError('viewer.setDye(colors): colors must be an object or null');
    dyeColors = colors ? JSON.parse(JSON.stringify(colors)) : null;
    const seq = ++dyeSeq;
    const target = current;
    if (!target) return;
    const stale = () => disposed || seq !== dyeSeq || current !== target;
    const changed = await applyDye(target.root, dyeColors, stale);
    if (stale()) return;
    if (changed) await renderSoon(target.root);
  }

  // ---------- public: load ----------
  /**
   * Loads a glTF and frames it. Resolves with { url, cancelled:false, size, radius } once it is on screen.
   * If a newer load() starts before this one finishes, this one resolves with { url, cancelled:true }
   * (it never rejects for that reason). Rejects with an Error on network/parse/empty-model failure.
   */
  async function load(url) {
    if (disposed) throw new Error('Viewer has been disposed');
    if (!url || typeof url !== 'string') throw new TypeError('viewer.load(url): url must be a non-empty string');
    const token = ++loadSeq;
    const stale = () => disposed || token !== loadSeq;

    let reported = 0;
    const report = (p) => {
      if (stale()) return;
      p = Math.max(reported, Math.min(1, p));
      if (p === reported && p !== 0) return;
      reported = p;
      emit('progress', p);
    };
    report(0);
    emit('loadstart', url);

    // Per-load manager: progress over every file (the .gltf, .bin and each texture).
    const manager = new THREE.LoadingManager();
    manager.onProgress = (_item, loaded, total) => {
      // `total` grows as GLTFLoader discovers the .bin and textures; ignore the lone .gltf item.
      if (total > 1) report(0.05 + 0.9 * (loaded / total));
    };
    const loader = new GLTFLoader(manager);

    let gltf;
    try {
      gltf = await loader.loadAsync(url, (ev) => {
        if (ev && ev.lengthComputable && ev.total > 0) {
          report(0.05 * (ev.loaded / ev.total));
        }
      });
    } catch (err) {
      if (stale()) return { url, cancelled: true };
      const e = new Error(`Could not load 3D model "${url}": ${describeError(err)}`);
      e.cause = err;
      emit('error', e);
      throw e;
    }

    const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (stale()) {
      if (root) disposeObject(root);
      return { url, cancelled: true };
    }
    if (!root) {
      const e = new Error(`3D model "${url}" contains no scene`);
      emit('error', e);
      throw e;
    }

    const worn = /worn(?:_f)?\.gltf(?:[?#].*)?$/i.test(url);   // worn.gltf (male) / worn_f.gltf (female)
    const pivot = new THREE.Group();
    pivot.name = 'viewer-model';
    pivot.userData.__url = url; // dye extras paths resolve against this
    if (worn) pivot.rotation.y = Math.PI;
    pivot.add(root);
    pivot.updateMatrixWorld(true);

    const meshCount = prepareModel(pivot);
    const box = new THREE.Box3().setFromObject(pivot);
    if (meshCount === 0 || box.isEmpty() || !isFiniteBox(box)) {
      disposeModel(pivot);
      const e = new Error(`3D model "${url}" has no visible geometry`);
      emit('error', e);
      throw e;
    }

    // Sticky dye: recolour before the first frame so the baked look never flashes.
    const dyeable = dyeMaterialsOf(pivot).length > 0;
    if (dyeable && dyeColors) {
      await applyStickyDye(pivot, stale);
      if (stale()) {
        disposeModel(pivot);
        return { url, cancelled: true };
      }
    }

    // Pre-compile shaders off the critical frame so the first frame doesn't hitch.
    // (pivot is not in the scene yet; `scene` supplies lights + environment for the right programs.)
    try {
      if (renderer.compileAsync) await renderer.compileAsync(pivot, camera, scene);
    } catch { /* non-fatal */ }
    if (stale()) {
      disposeModel(pivot);
      return { url, cancelled: true };
    }
    // setDye() may have run during the compile; make sure the new model matches the latest dye.
    if (dyeable) {
      await applyStickyDye(pivot, stale);
      if (stale()) {
        disposeModel(pivot);
        return { url, cancelled: true };
      }
    }

    // Swap models.
    const previous = current;
    if (previous) {
      scene.remove(previous.root);
      disposeModel(previous.root);
    }
    scene.add(pivot);
    const size = box.getSize(new THREE.Vector3());
    current = { root: pivot, url, worn, box, home: null, dyeable };
    const home = computeHome(box);
    current.home = home;
    setupStage(box, home.radius, home);
    userMoved = false;

    // Glide the camera into the new framing (first load: a gentle dolly-in from further out).
    const fromPos = previous ? camera.position.clone() : home.position.clone().sub(home.target).multiplyScalar(1.7).add(home.target);
    const fromTarget = previous ? controls.target.clone() : home.target.clone();
    startTween(fromPos, fromTarget, home);

    renderer.render(scene, camera); // make it visible now, not on the next rAF
    needsRender = true;
    report(1);
    emit('load', { url, worn, size: size.clone(), radius: home.radius });
    emit('dyeable', dyeable);
    return { url, cancelled: false, worn, size, radius: home.radius };
  }

  function startTween(fromPos, fromTarget, home) {
    // Open the limits during the glide so OrbitControls doesn't clamp intermediate positions.
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    camera.near = Math.max(home.radius * 0.01, 0.002);
    camera.far = Math.max((home.distance * 3.5 + home.radius) * 4, fromPos.distanceTo(home.target) * 4);
    camera.updateProjectionMatrix();
    userPaused = false;
    camera.position.copy(fromPos);
    controls.target.copy(fromTarget);
    camera.lookAt(fromTarget);
    if (opts.transitionDuration <= 0) {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      applyLimits(home);
      controls.update();
      tween = null;
    } else {
      tween = {
        fromPos: fromPos.clone(), fromTarget: fromTarget.clone(),
        toPos: home.position.clone(), toTarget: home.target.clone(),
        t0: performance.now(), dur: opts.transitionDuration, home,
      };
    }
    needsRender = true;
  }

  // ---------- public API ----------
  function setAutoRotate(on) {
    autoRotateWanted = !!on;
    userPaused = false;
    needsRender = true;
  }

  function resetView() {
    if (!current) return;
    userMoved = false;
    const home = computeHome(current.box);
    current.home = home;
    startTween(camera.position.clone(), controls.target.clone(), home);
  }

  function on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('viewer.on(type, fn): fn must be a function');
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    listeners.get(type)?.delete(fn);
  }

  function clear() {
    loadSeq++; // cancels any in-flight load
    if (current) {
      scene.remove(current.root);
      disposeModel(current.root);
      current = null;
      emit('dyeable', false);
    }
    ground.visible = false;
    glow.visible = false;
    tween = null;
    needsRender = true;
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    dyeSeq++;
    for (const t of dyeTextures) t.dispose(); // TextureLoader images are HTMLImageElements: nothing to close
    dyeTextures.clear();
    dyeTexCache.clear();
    stop();
    ro.disconnect();
    if (dprQuery) dprQuery.removeEventListener('change', onDprChange);
    document.removeEventListener('visibilitychange', onVisibility);
    controls.removeEventListener('start', onStart);
    controls.removeEventListener('end', onEnd);
    controls.removeEventListener('change', onChange);
    controls.dispose();
    listeners.clear();
    disposeObject(ground);
    disposeObject(glow);
    glowTex.dispose();
    key.shadow.map?.dispose();
    key.dispose?.();
    rim.dispose?.();
    fill.dispose?.();
    hemi.dispose?.();
    scene.environment = null;
    envRT.dispose();
    pmrem.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  return {
    load,
    setAutoRotate,
    resetView,
    dispose,
    on,
    off,
    clear,
    setDye,
    get dyeable() { return current ? !!current.dyeable : false; },
    get dye() { return dyeColors ? JSON.parse(JSON.stringify(dyeColors)) : null; },
    get autoRotate() { return autoRotateWanted; },
    get url() { return current ? current.url : null; },
    // escape hatches for debugging / advanced UI
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get controls() { return controls; },
  };
}

// ---------- helpers ----------

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function toArray(m) {
  return Array.isArray(m) ? m : [m];
}

function texturesOf(material) {
  const out = new Set();
  for (const key of Object.keys(material)) {
    const v = material[key];
    if (v && v.isTexture) out.add(v);
  }
  // ShaderMaterial-style uniforms
  if (material.uniforms) {
    for (const u of Object.values(material.uniforms)) {
      if (u && u.value && u.value.isTexture) out.add(u.value);
    }
  }
  return out;
}

/** Disposes every geometry, material and texture under `root` (shared ones only once). */
function disposeObject(root, keep) {
  if (!root) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    if (o.material) for (const m of toArray(o.material)) if (m) materials.add(m);
    if (o.skeleton && o.skeleton.boneTexture) textures.add(o.skeleton.boneTexture);
  });
  for (const m of materials) for (const t of texturesOf(m)) textures.add(t);
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) {
    if (keep && keep.has(t)) continue;
    const img = t.source && t.source.data;
    t.dispose();
    // GLTFLoader decodes to ImageBitmap in browsers; release the decoded pixels too.
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
  }
  if (root.parent) root.parent.remove(root);
}

function isFiniteBox(box) {
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite);
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.response && err.response.status) {
    return `HTTP ${err.response.status}${err.response.statusText ? ' ' + err.response.statusText : ''} (${err.response.url || 'file'})`;
  }
  const msg = err.message || String(err);
  if (/Unexpected token|JSON/i.test(msg)) return `file is not valid glTF JSON (${msg})`;
  return msg;
}

function makeGlowTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, 'rgba(232, 188, 104, 0.42)');
  grad.addColorStop(0.25, 'rgba(206, 154, 72, 0.24)');
  grad.addColorStop(0.55, 'rgba(160, 108, 44, 0.09)');
  grad.addColorStop(1.0, 'rgba(120, 80, 30, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
