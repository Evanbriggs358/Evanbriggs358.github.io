import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const reduceMotion =matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.getElementById('stage');
const hotspotLayer = document.getElementById('hotspots');

// ---------- camera keyframes, one per <section data-cam> ----------
// pos/look in world units (drone is ~10 units across), shift = horizontal screen offset of the drone
const KEYS = {
  hero:     { pos: [15, 7, 18],     look: [0, 0, 0],      shift: 0.2,   fade: 1 },
  frame:    { pos: [0.01, 27, 1],   look: [0, 0, 0],      shift: 0.2,   fade: 1 },
  fc:       { pos: [15, 1.6, 15],   look: [0, -0.4, 0],   shift: -0.2,  fade: 1 },
  pi:       { pos: [-15, 2.5, 15], look: [0.5, 0.6, 0],    shift: 0.2,   fade: 1 },
  scan:     { pos: [0, 5, 22],      look: [0, 0, 0],      shift: -0.2,  fade: 1 },
  mission:  { pos: [24, 30, 30],    look: [0, -3, 0],     shift: 0.18,  fade: 1 },
  hangar:   { pos: [15, 7, 18],     look: [0, 0.4, 0],    shift: 0,     fade: 1 },
  projects: { pos: [20, 12, 26],    look: [0, 0, 0],      shift: 0,     fade: 0.15 },
};

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);

// The scan texture already has the real-world lighting baked in, so keep fill light low
// (it lifts blacks toward grey) and let a neutral key light do the shaping.
scene.add(new THREE.HemisphereLight(0xffffff, 0x0c0a08, 1.3));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(6, 12, 8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4fd1ff, 1.1);
rim.position.set(-10, 4, -10);
scene.add(rim);
const warm = new THREE.DirectionalLight(0xff8a2a, 0.8);
warm.position.set(10, -2, -6);
scene.add(warm);

// Colour grade applied to the scan texture (perceptual space). ?grade=0 turns it off for comparison.
const GRADE = new URLSearchParams(location.search).get('grade') === '0'
  ? { black: 0, contrast: 1, saturation: 1 }
  : {
      black: 0.035,     // how much near-black gets crushed to true black
      contrast: 1.12,   // around mid-grey
      saturation: 1.22, // 1 = as scanned
    };
function applyGrade(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.gradeBlack = { value: GRADE.black };
    shader.uniforms.gradeContrast = { value: GRADE.contrast };
    shader.uniforms.gradeSaturation = { value: GRADE.saturation };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float gradeBlack, gradeContrast, gradeSaturation;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 c = pow(max(diffuseColor.rgb, 0.0), vec3(1.0 / 2.2));
          c = max(c - gradeBlack, 0.0) / (1.0 - gradeBlack);
          c = (c - 0.5) * gradeContrast + 0.5;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, gradeSaturation);
          diffuseColor.rgb = pow(clamp(c, 0.0, 1.0), vec3(2.2));
        }`);
  };
  material.customProgramCacheKey = () => 'grade';
}

const pivot = new THREE.Group();   // user drag + idle motion
scene.add(pivot);

// soft contact shadow
function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(13, 13),
  new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,0,0,0.75)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false })
);
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = -3.1;
scene.add(shadow);

// ---------- survey grid + lawnmower path (mission section) ----------
const survey = new THREE.Group();
survey.position.y = -6;
scene.add(survey);
const gridMat = new THREE.LineBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0 });
{
  const pts = [];
  const N = 16, S = 2.5, E = N * S;
  for (let i = -N; i <= N; i++) {
    pts.push(-E, 0, i * S, E, 0, i * S, i * S, 0, -E, i * S, 0, E);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  survey.add(new THREE.LineSegments(g, gridMat));
}
const pathMat = new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 });
const pathGeo = new THREE.BufferGeometry();
{
  const pts = [];
  const W = 18, rows = 8, gap = 4;
  for (let r = 0; r < rows; r++) {
    const z = -((rows - 1) * gap) / 2 + r * gap;
    const [a, b] = r % 2 ? [W, -W] : [-W, W];
    pts.push(a, 0.02, z, b, 0.02, z);
  }
  pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  pathGeo.setDrawRange(0, 0);
}
survey.add(new THREE.Line(pathGeo, pathMat));
const pathCount = 16;
// a camera-footprint square that follows the path
const footprint = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints([[-2, -1.4], [2, -1.4], [2, 1.4], [-2, 1.4]].map(([x, z]) => new THREE.Vector3(x, 0.05, z))),
  new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 })
);
survey.add(footprint);

// ---------- scan sweep: a thin bright ring with a faint haze inside ----------
const ring = new THREE.Group();
const ringMats = [
  new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  new THREE.MeshBasicMaterial({ map: radialTexture('rgba(79,209,255,0)', 'rgba(79,209,255,0.12)'), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
];
ring.add(new THREE.Mesh(new THREE.RingGeometry(6.4, 6.5, 96), ringMats[0]));
ring.add(new THREE.Mesh(new THREE.CircleGeometry(6.4, 96), ringMats[1]));
ring.children.forEach((m) => (m.rotation.x = -Math.PI / 2));
scene.add(ring);

// ---------- hotspots (model-local anchors resolved after load) ----------
const HOTSPOTS = [
  { id: 'motor',   section: 'frame', label: '7" motor & prop' },
  { id: 'arm',     section: 'frame', label: 'printed deadcat arms' },
  { id: 'stack',   section: 'fc',    label: 'Kakute H7 flight stack' },
  { id: 'lipo',    section: 'fc',    label: '5000 mAh LiPo' },
  { id: 'gps',     section: 'pi',    label: 'GPS / compass mast' },
  { id: 'pi',      section: 'pi',    label: 'Pi 4B companion' },
];
for (const h of HOTSPOTS) {
  const el = document.createElement('div');
  el.className = 'hs';
  el.innerHTML = `<span class="hs-dot"></span><span class="hs-line"></span><span class="hs-label">${h.label}</span>`;
  hotspotLayer.appendChild(el);
  h.el = el;
  h.local = new THREE.Vector3();
}

// ---------- load the scan ----------
let model = null, texMat = null, wireMat = null, bounds = null;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load(
  'models/drone.glb',
  (gltf) => {
    model = gltf.scene;
    model.rotation.y = 0.47; // scan was taken at an angle; square the body up with the X axis
    pivot.add(model);

    const mesh = model.getObjectByProperty('type', 'Mesh');
    mesh.geometry.computeVertexNormals();
    const src = mesh.material;
    texMat = new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.72, metalness: 0.15, side: THREE.DoubleSide });
    applyGrade(texMat);
    mesh.material = texMat;

    wireMat = new THREE.MeshBasicMaterial({ color: 0x4fd1ff, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
    const wire = new THREE.Mesh(mesh.geometry, wireMat);
    mesh.add(wire);
    texMat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 100)];
    wireMat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -100)];

    pivot.position.set(0, 0, 0);
    pivot.rotation.set(0, 0, 0);
    pivot.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model);
    findAnchors(mesh);

    document.getElementById('loader').classList.add('gone');
    upgradeScan(mesh);
  },
  (e) => {
    if (e.total) document.getElementById('loader-pct').textContent = `loading scan ${Math.round((e.loaded / e.total) * 100)}%`;
  },
  (err) => {
    console.error(err);
    document.getElementById('loader-pct').textContent = 'could not load the scan';
  }
);

// Stream in a denser scan once the preview is up. Desktops get the full-resolution scan
// (every triangle, 8K texture); phones and low-memory devices get the 4K middle tier.
// The preview mesh stays around as the wireframe for the scan sweep — the dense one
// would just read as solid blue.
function upgradeScan(previewMesh) {
  const caps = renderer.capabilities;
  const lowEnd = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory ?? 8) < 4 || caps.maxTextureSize < 8192;
  const tier = lowEnd
    ? { url: 'models/drone-mid.glb', label: '675k triangles · 4K texture' }
    : { url: 'models/drone-hq.glb', label: '1.77M triangles · 8K texture' };
  const status = document.getElementById('scan-status');
  status.textContent = 'streaming full-res scan…';
  loader.load(
    tier.url,
    (gltf) => {
      const hq = gltf.scene.getObjectByProperty('type', 'Mesh');
      hq.geometry.computeVertexNormals();
      const oldMap = texMat.map;
      texMat.map = hq.material.map;
      texMat.map.anisotropy = caps.getMaxAnisotropy();
      texMat.needsUpdate = true;
      hq.material.dispose();
      hq.material = texMat;
      model.add(gltf.scene);
      previewMesh.material = new THREE.MeshBasicMaterial({ visible: false }); // keep its wireframe child
      oldMap.dispose();
      status.textContent = `full-res scan · ${tier.label}`;
      status.classList.add('done');
    },
    (e) => {
      if (e.total) status.textContent = `streaming full-res scan ${Math.round((e.loaded / e.total) * 100)}%`;
    },
    (err) => {
      console.error(err);
      status.textContent = '';
    }
  );
}

// Pick anchor points straight off the geometry so labels land on real parts.
// Anchors are stored in pivot space (model at rest, body squared up with X).
function findAnchors(mesh) {
  const p = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  let gps = null, lipo = null, motor = null, motorD = 0;
  const stackPts = [];
  for (let i = 0; i < p.count; i += 2) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    if (!gps || v.y > gps.y) gps = v.clone();
    if (Math.abs(v.x) < 1.2 && Math.abs(v.z) < 0.8 && v.y < 1.6 && (!lipo || v.y > lipo.y)) lipo = v.clone();
    if (Math.abs(v.x) < 1.5 && Math.abs(v.z) < 0.6 && v.y < -1.0) stackPts.push(v.clone());
    const r = Math.hypot(v.x, v.z);
    if (v.x > 0 && v.z > 0 && r > motorD) { motorD = r; motor = v.clone(); }
  }
  const stack = stackPts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(Math.max(stackPts.length, 1));
  const set = (id, vec) => HOTSPOTS.find((h) => h.id === id).local.copy(vec);
  set('gps', gps);
  set('lipo', lipo);
  set('stack', stack);
  set('motor', motor);
  set('arm', motor.clone().multiplyScalar(0.55).setY(motor.y * 0.6 + stack.y * 0.4));
  set('pi', stack.clone().setY(stack.y + 0.8));
  window.__anchors = Object.fromEntries(HOTSPOTS.map((h) => [h.id, h.local.toArray().map((n) => +n.toFixed(2))]));
}

// ---------- scroll → camera ----------
const sections = [...document.querySelectorAll('section[data-cam]')];
let centers = [];
function measure() {
  centers = sections.map((s) => s.offsetTop + s.offsetHeight / 2);
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;

const debugCam = new URLSearchParams(location.search).get('cam'); // e.g. ?cam=fc&p=0.3 pins the camera
function scrollState() {
  if (debugCam && KEYS[debugCam]) {
    const p = parseFloat(new URLSearchParams(location.search).get('p') ?? '0.5');
    return { a: KEYS[debugCam], b: KEYS[debugCam], t: 0, weights: { ...Object.fromEntries(Object.keys(KEYS).map((k) => [k, 0])), [debugCam]: 1 }, drift: 0, scanP: debugCam === 'scan' ? p : 0, missionP: debugCam === 'mission' ? p : 0 };
  }
  const focus = scrollY + innerHeight / 2;
  let i = 0;
  while (i < centers.length - 1 && focus > centers[i + 1]) i++;
  const a = sections[i].dataset.cam;
  const b = sections[Math.min(i + 1, sections.length - 1)].dataset.cam;
  const span = centers[i + 1] - centers[i] || 1;
  const raw = clamp01((focus - centers[i]) / span);
  const t = smooth(raw); // no holds — the camera is always travelling
  // signed distance from the nearest section centre, in screen heights: drives the in-section drift
  const near = raw < 0.5 ? centers[i] : centers[Math.min(i + 1, centers.length - 1)];
  const drift = Math.max(-1, Math.min(1, (focus - near) / innerHeight));
  // per-section weight (1 when centered)
  const weights = {};
  sections.forEach((s, k) => {
    const d = Math.abs(focus - centers[k]) / Math.max(s.offsetHeight * 0.5, innerHeight * 0.5);
    weights[s.dataset.cam] = clamp01(1 - d);
  });
  const scan = sections.find((s) => s.dataset.cam === 'scan');
  const scanP = clamp01((focus - scan.offsetTop) / scan.offsetHeight);
  const mission = sections.find((s) => s.dataset.cam === 'mission');
  const missionP = clamp01((focus - mission.offsetTop) / mission.offsetHeight);
  return { a: KEYS[a], b: KEYS[b], t, drift, weights, scanP, missionP };
}

const cur = { pos: new THREE.Vector3(15, 7, 18), look: new THREE.Vector3(), shift: 0.2, fade: 1 };
const tgt = { pos: new THREE.Vector3(), look: new THREE.Vector3(), shift: 0, fade: 1 };

// ---------- interaction: drag to spin, pointer parallax ----------
const user = { yaw: 0, pitch: 0, vyaw: 0 };
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
let dragging = null;
addEventListener('pointerdown', (e) => {
  if (e.target.closest('.card:not(.card--bare), .project, a, nav, footer')) return;
  dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
  document.body.classList.add('dragging');
});
addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
  if (!dragging || e.pointerId !== dragging.id) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  dragging.x = e.clientX; dragging.y = e.clientY;
  user.vyaw = dx * 0.008;
  user.yaw += dx * 0.008;
  user.pitch = Math.max(-0.6, Math.min(0.6, user.pitch + dy * 0.004));
});
const endDrag = () => { dragging = null; document.body.classList.remove('dragging'); };
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);
canvas.style.touchAction = 'pan-y';

// ---------- resize ----------
let narrow = false;
function resize() {
  const w = innerWidth, h = innerHeight;
  narrow = w < 760;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  measure();
}
addEventListener('resize', resize);
resize();
addEventListener('load', measure);

// ---------- reveal cards / progress bar ----------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('in');
}, { threshold: 0.25 });
document.querySelectorAll('.card').forEach((c) => io.observe(c));
const bar = document.getElementById('progress-bar');

// ---------- frame loop ----------
const clock = new THREE.Clock();
let spin = 0;
let lastScroll = scrollY;
const flight = { pitch: 0, lift: 0, drift: 0 };const tmp = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const s = scrollState();
  const W = s.weights;

  // target camera from the two neighbouring keyframes
  tgt.pos.copy(_a.fromArray(s.a.pos)).lerp(_b.fromArray(s.b.pos), s.t);
  tgt.look.copy(_a.fromArray(s.a.look)).lerp(_b.fromArray(s.b.look), s.t);
  tgt.shift = lerp(s.a.shift, s.b.shift, s.t);
  tgt.fade = lerp(s.a.fade, s.b.fade, s.t);
  if (narrow) tgt.shift = 0;
  // back off on narrower screens so the whole drone stays in frame
  tgt.pos.sub(tgt.look).multiplyScalar(Math.min(3.2, Math.max(1, 1.7 / camera.aspect))).add(tgt.look);
  const k = 1 - Math.exp(-dt * 3.2);
  cur.pos.lerp(tgt.pos, k);
  cur.look.lerp(tgt.look, k);
  cur.shift = lerp(cur.shift, tgt.shift, k);
  cur.fade = lerp(cur.fade, tgt.fade, k);

  // gentle parallax around the camera path
  pointer.sx = lerp(pointer.sx, pointer.x, 0.05);
  pointer.sy = lerp(pointer.sy, pointer.y, 0.05);
  camera.position.copy(cur.pos);
  tmp.set(-cur.pos.z, 0, cur.pos.x).normalize().multiplyScalar(pointer.sx * 0.6);
  camera.position.add(tmp).add(new THREE.Vector3(0, -pointer.sy * 0.5, 0));
  camera.lookAt(cur.look);
  const w = innerWidth, h = innerHeight;
  camera.setViewOffset(w, h, -cur.shift * w, narrow ? h * 0.22 : 0, w, h);
  canvas.style.opacity = cur.fade.toFixed(3);

  // hero turntable; unwinds to the nearest full turn once you scroll away
  if (!reduceMotion) spin += dt * 0.35 * W.hero;
  const home = Math.round(spin / (Math.PI * 2)) * Math.PI * 2;
  spin = lerp(spin, home, (1 - W.hero) * k);

  // drag: momentum, then drift home except in the hangar
  if (!dragging) {
    user.yaw += user.vyaw;
    user.vyaw *= 0.92;
    const keep = W.hangar > 0.3;
    if (!keep) {
      user.yaw = lerp(user.yaw, Math.round(user.yaw / (Math.PI * 2)) * Math.PI * 2, 0.02);
      user.pitch = lerp(user.pitch, 0, 0.03);
    }
  }
  // flight feel: scroll speed pitches the nose and lifts it, like a quad punching forward
  const vel = (scrollY - lastScroll) / Math.max(dt, 1e-3);
  lastScroll = scrollY;
  const motion = reduceMotion ? 0 : 1;
  flight.pitch = lerp(flight.pitch, Math.max(-0.4, Math.min(0.4, -vel / 5000)) * motion, 0.08);
  flight.lift = lerp(flight.lift, Math.min(0.8, Math.abs(vel) / 4000) * motion, 0.06);
  flight.drift = lerp(flight.drift, s.drift, 0.1); // slow turn while you read a section

  pivot.rotation.set(
    user.pitch + pointer.sy * 0.12 * motion,
    spin + user.yaw + flight.drift * 0.9 * motion + pointer.sx * 0.25 * motion,
    flight.pitch + Math.sin(time * 0.9) * 0.025 * motion
  );
  pivot.position.y = (Math.sin(time * 1.3) * 0.12 + flight.lift) * motion;

  // scan sweep: down then back up across the scan section
  if (model && bounds) {
    const top = bounds.max.y + 0.2, bot = bounds.min.y - 0.2;
    const inScan = s.scanP > 0.05 && s.scanP < 0.95;
    const sweep = inScan ? Math.abs(Math.sin(clamp01((s.scanP - 0.05) / 0.9) * Math.PI)) : 0; // 0 → 1 → 0
    const y = lerp(top, bot, sweep);
    texMat.clippingPlanes[0].constant = inScan ? y : 100;
    wireMat.clippingPlanes[0].constant = inScan ? -y : -100;
    wireMat.opacity = 0.22 * W.scan;
    ring.position.y = y + pivot.position.y;
    const ro = inScan ? W.scan * Math.min(1, sweep * 6) : 0;
    ringMats.forEach((mm) => (mm.opacity = ro));
    ring.visible = ro > 0.01;
  }

  // survey grid + path
  const m = W.mission;
  gridMat.opacity = 0.18 * m;
  pathMat.opacity = m;
  footprint.material.opacity = m;
  const drawn = Math.floor(clamp01(s.missionP * 1.4 - 0.1) * pathCount * 100) / 100;
  pathGeo.setDrawRange(0, Math.max(0, Math.ceil(drawn)));
  {
    const pos = pathGeo.attributes.position;
    const seg = Math.min(pathCount - 2, Math.floor(drawn));
    const f = Math.min(1, drawn - seg);
    _a.fromBufferAttribute(pos, seg);
    _b.fromBufferAttribute(pos, Math.min(seg + 1, pathCount - 1));
    footprint.position.copy(_a.lerp(_b, f));
  }
  survey.visible = m > 0.01;
  shadow.material.opacity = 1 - m;

  renderer.render(scene, camera);

  // hotspots
  const wide = innerWidth;
  for (const hs of HOTSPOTS) {
    const on = model ? W[hs.section] : 0;
    if (on < 0.02) { hs.el.style.opacity = 0; continue; }
    tmp.copy(hs.local);
    pivot.localToWorld(tmp);
    tmp.project(camera);
    const x = (tmp.x * 0.5 + 0.5) * innerWidth;
    const y = (-tmp.y * 0.5 + 0.5) * innerHeight;
    const flip = x > wide * 0.62;
    hs.el.classList.toggle('flip', flip);
    hs.el.style.transform = `translate(${flip ? x - hs.el.offsetWidth : x}px, ${y}px)`;
    hs.el.style.opacity = clamp01((on - 0.55) * 3).toFixed(2);
  }

  bar.style.transform = `scaleX(${clamp01(scrollY / (document.documentElement.scrollHeight - innerHeight))})`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
