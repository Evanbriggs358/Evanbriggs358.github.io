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
  mission:  { pos: [26, 34, 42],    look: [2, -5, 0],     shift: 0.2,   fade: 1 },
  status:   { pos: [-18, 7, -15],   look: [0, 0, 0],      shift: -0.17, fade: 1 },
  hangar:   { pos: [15, 7, 18],     look: [0, 0.4, 0],    shift: 0,     fade: 1 },
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

// ---------- survey terrain (mission section) ----------
// Generated landscape drawn as a survey map: dark ground with glowing contour lines.
// As the lawnmower path flies over it, every simulated photo stamps its footprint into a
// coverage texture, and covered ground turns into a shaded relief map — the orthomosaic
// and elevation model "developing" behind the aircraft.
const survey = new THREE.Group();
survey.position.y = -9;
scene.add(survey);

function hash2(i, j) {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function terrainHeight(x, z) {
  let h = 0, amp = 1, f = 1 / 14;
  for (let k = 0; k < 4; k++) {
    h += amp * (valueNoise(x * f + 11.3 * k, z * f - 7.1 * k) * 2 - 1);
    amp *= 0.5; f *= 2;
  }
  h *= 3.2;
  h += 2.4 * Math.exp(-((x * 0.6 + z * 0.8 - 14) ** 2) / 60); // a low ridge
  const creek = 7 * Math.sin(z / 11) - 4;
  h -= 2.4 * Math.exp(-((x - creek) ** 2) / 10); // a shallow creek valley
  return h;
}

// coverage texture: photo footprints accumulate here (additive), sampled by the terrain shader
const COV = { minX: -24, minZ: -20, sizeX: 48, sizeZ: 40, px: 512 };
const covCanvas = document.createElement('canvas');
covCanvas.width = covCanvas.height = COV.px;
const covCtx = covCanvas.getContext('2d');
const covTex = new THREE.CanvasTexture(covCanvas);
covTex.flipY = false;

const terrainMat = new THREE.ShaderMaterial({
  transparent: true,
  extensions: { derivatives: true },
  uniforms: {
    uOpacity: { value: 0 },
    uCov: { value: covTex },
    uCovRect: { value: new THREE.Vector4(COV.minX, COV.minZ, COV.sizeX, COV.sizeZ) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vW; varying vec2 vL; varying float vH;
    void main() {
      vH = position.y; vL = position.xz;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uOpacity; uniform sampler2D uCov; uniform vec4 uCovRect;
    varying vec3 vW; varying vec2 vL; varying float vH;
    float contour(float v) {
      float fw = fwidth(v);
      float d = abs(fract(v - 0.5) - 0.5);
      return 1.0 - smoothstep(0.0, fw * 1.4, d);
    }
    void main() {
      vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
      if (n.y < 0.0) n = -n;
      float shade = 0.35 + 0.65 * max(dot(n, normalize(vec3(-0.5, 0.8, 0.35))), 0.0);
      float minor = contour(vH / 0.5);
      float major = contour(vH / 2.5);

      vec2 cuv = (vL - uCovRect.xy) / uCovRect.zw;
      float inside = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
      float cov = texture2D(uCov, cuv).r * inside;
      float mapped = smoothstep(0.02, 0.2, cov);

      vec3 cyan = vec3(0.31, 0.82, 1.0);
      vec3 unmapped = vec3(0.04, 0.055, 0.07) * shade * 1.5 + cyan * (minor * 0.28 + major * 0.55);

      float t = clamp((vH + 4.0) / 9.0, 0.0, 1.0);
      vec3 hyp = mix(vec3(0.10, 0.19, 0.13), vec3(0.42, 0.36, 0.24), smoothstep(0.2, 0.7, t));
      hyp = mix(hyp, vec3(0.74, 0.71, 0.62), smoothstep(0.78, 1.0, t));
      vec3 mappedCol = hyp * shade * (0.75 + 0.45 * min(cov, 1.0)) + vec3(1.0) * (minor * 0.06 + major * 0.14);

      vec3 col = mix(unmapped, mappedCol, mapped);
      float edge = 1.0 - smoothstep(26.0, 44.0, length(vL));
      float a = uOpacity * edge * (0.5 + 0.5 * max(max(minor * 0.6, major), mapped));
      gl_FragColor = vec4(col, a);
    }`,
});
{
  const g = new THREE.PlaneGeometry(90, 90, 200, 200);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  survey.add(new THREE.Mesh(g, terrainMat));
}

// lawnmower path, flown at a constant height above the ground, sampled finely so it draws smoothly
const FLY_ALT = 3.5, SAMPLE = 0.4, TRIGGER = 1.0, TICK = 2.0;
const FOOT = { along: 1.7, across: 3.0 }; // half-extents of one photo's ground footprint
const pathPts = [];   // {x, z, d, row}
{
  const W = 18, rows = 8, gap = 4;
  const corners = [];
  for (let r = 0; r < rows; r++) {
    const z = -((rows - 1) * gap) / 2 + r * gap;
    const [a, b] = r % 2 ? [W, -W] : [-W, W];
    corners.push([a, z, true], [b, z, false]); // leg from a→b is a survey row; b→next a is a turn
  }
  let d = 0;
  for (let c = 0; c < corners.length - 1; c++) {
    const [x0, z0, isRow] = corners[c], [x1, z1] = corners[c + 1];
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / SAMPLE));
    for (let s = c === 0 ? 0 : 1; s <= n; s++) {
      const f = s / n;
      pathPts.push({ x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, d: d + len * f, row: isRow });
    }
    d += len;
  }
}
const pathLen = pathPts[pathPts.length - 1].d;
const flyY = (x, z) => terrainHeight(x, z) + FLY_ALT;

const pathMat = new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 });
const pathGeo = new THREE.BufferGeometry().setFromPoints(pathPts.map((q) => new THREE.Vector3(q.x, flyY(q.x, q.z), q.z)));
pathGeo.setDrawRange(0, 0);
survey.add(new THREE.Line(pathGeo, pathMat));

// drop lines from the path to the ground, to show the terrain-following height
const ticks = [];
for (let t = TICK / 2; t < pathLen; t += TICK) ticks.push(t);
const tickMat = new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 });
const tickGeo = new THREE.BufferGeometry();
tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(ticks.flatMap((t) => {
  const q = pointAt(t);
  return [q.x, flyY(q.x, q.z), q.z, q.x, terrainHeight(q.x, q.z) + 0.05, q.z];
}), 3));
tickGeo.setDrawRange(0, 0);
survey.add(new THREE.LineSegments(tickGeo, tickMat));

// photo trigger points: evenly spaced along the survey rows only
const triggers = [];
{
  let next = 0;
  for (let i = 1; i < pathPts.length; i++) {
    const a = pathPts[i - 1], b = pathPts[i];
    if (!a.row || b.d - a.d > SAMPLE * 1.5) { continue; }
    while (next <= b.d) {
      if (next >= a.d) triggers.push({ d: next, x: a.x + (b.x - a.x) * ((next - a.d) / (b.d - a.d)), z: a.z });
      next += TRIGGER;
    }
  }
}

function pointAt(d) {
  let lo = 0, hi = pathPts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pathPts[mid].d <= d) lo = mid; else hi = mid; }
  const a = pathPts[lo], b = pathPts[hi], f = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, i: lo, row: a.row };
}

// the moving camera: footprint outline draped on the ground, plus the view cone up to the aircraft
const FOOT_N = 8;
const footMat = new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 });
const footGeo = new THREE.BufferGeometry();
footGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(FOOT_N * 4 * 3), 3));
const footLine = new THREE.LineLoop(footGeo, footMat);
footLine.frustumCulled = false;
survey.add(footLine);
const coneGeo = new THREE.BufferGeometry();
coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3));
const coneMat = new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 });
const cone = new THREE.LineSegments(coneGeo, coneMat);
cone.frustumCulled = false;
survey.add(cone);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0 }));
survey.add(head);

let stampedCount = -1;
function drawCoverage(count) {
  covCtx.globalCompositeOperation = 'source-over';
  covCtx.fillStyle = '#000';
  covCtx.fillRect(0, 0, COV.px, COV.px);
  covCtx.globalCompositeOperation = 'lighter';
  covCtx.fillStyle = 'rgba(255,255,255,0.16)';
  const sx = COV.px / COV.sizeX, sz = COV.px / COV.sizeZ;
  for (let i = 0; i < count; i++) {
    const t = triggers[i];
    covCtx.fillRect((t.x - FOOT.along - COV.minX) * sx, (t.z - FOOT.across - COV.minZ) * sz, FOOT.along * 2 * sx, FOOT.across * 2 * sz);
  }
  covTex.needsUpdate = true;
}

function updateSurvey(progress, opacity) {
  terrainMat.uniforms.uOpacity.value = opacity;
  pathMat.opacity = footMat.opacity = coneMat.opacity = head.material.opacity = opacity;
  tickMat.opacity = 0.35 * opacity;
  const d = progress * pathLen;
  const q = pointAt(d);
  pathGeo.setDrawRange(0, progress > 0 ? q.i + 2 : 0);
  let tc = 0; while (tc < ticks.length && ticks[tc] <= d) tc++;
  tickGeo.setDrawRange(0, tc * 2);
  let n = 0; while (n < triggers.length && triggers[n].d <= d) n++;
  if (n !== stampedCount) { stampedCount = n; drawCoverage(n); }

  // aircraft marker, footprint and view cone
  const hy = flyY(q.x, q.z);
  head.position.set(q.x, hy, q.z);
  const show = progress > 0 && progress < 1;
  head.visible = footLine.visible = cone.visible = show;
  const fp = footGeo.attributes.position, cp = coneGeo.attributes.position;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  let k = 0;
  for (let c = 0; c < 4; c++) {
    const [ax, az] = corners[c], [bx, bz] = corners[(c + 1) % 4];
    for (let s = 0; s < FOOT_N; s++) {
      const f = s / FOOT_N;
      const x = q.x + (ax + (bx - ax) * f) * FOOT.along, z = q.z + (az + (bz - az) * f) * FOOT.across;
      fp.setXYZ(k++, x, terrainHeight(x, z) + 0.08, z);
    }
    const x = q.x + ax * FOOT.along, z = q.z + az * FOOT.across;
    cp.setXYZ(c * 2, q.x, hy, q.z);
    cp.setXYZ(c * 2 + 1, x, terrainHeight(x, z) + 0.08, z);
  }
  fp.needsUpdate = cp.needsUpdate = true;
}

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
  { id: 'motor',   section: 'frame', label: '2807 1300KV · 7×4.5 prop' },
  { id: 'arm',     section: 'frame', label: '6 mm carbon deadcat arm' },
  { id: 'stack',   section: 'fc',    label: 'Kakute H7 + Tekko32 65A' },
  { id: 'lipo',    section: 'fc',    label: 'CNHL 5000 mAh 6S' },
  { id: 'gps',     section: 'pi',    label: 'Holybro M10 GPS + compass' },
  { id: 'pi',      section: 'pi',    label: 'Pi 4B + Camera Module 3' },
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

const cur = { look: new THREE.Vector3(), shift: 0.2, fade: 1 };
const tgt = { look: new THREE.Vector3(), shift: 0, fade: 1 };
const sphA = new THREE.Spherical(), sphB = new THREE.Spherical(), tgtS = new THREE.Spherical(), viewS = new THREE.Spherical();
const curS = new THREE.Spherical().setFromVector3(new THREE.Vector3(...KEYS.hero.pos));
const _la = new THREE.Vector3();
// signed shortest turn from angle a to angle b, in (-π, π]
const angleDelta = (a, b) => ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
// ---------- interaction: drag to spin, pointer parallax ----------
const user = { yaw: 0, pitch: 0, vyaw: 0 };
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
let dragging = null;
addEventListener('pointerdown', (e) => {
  if (e.target.closest('.card:not(.card--bare), a, nav, footer')) return;
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
  if (!w || !h) return;
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
const navLinks = [...document.querySelectorAll('.section-link')];
let activeId = null;

// ---------- frame loop ----------
const clock = new THREE.Clock();
let spin = 0;
let lastScroll = scrollY;
const flight = { pitch: 0, lift: 0, drift: 0 };
const tmp = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

function tick() {
  // A zero-size window (hidden tab, collapsed iframe) would divide by zero and poison
  // every smoothed value with NaN for good, so just wait until it has a size again.
  if (!innerWidth || !innerHeight) { clock.getDelta(); requestAnimationFrame(tick); return; }
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const s = scrollState();
  const W = s.weights;

  // Target camera between the two neighbouring keyframes. Positions are interpolated as an
  // orbit around the look point (angle, elevation, distance) rather than a straight line,
  // so the camera swings around the drone instead of cutting through it.
  tgt.look.copy(_a.fromArray(s.a.look)).lerp(_b.fromArray(s.b.look), s.t);
  sphA.setFromVector3(_a.fromArray(s.a.pos).sub(_la.fromArray(s.a.look)));
  sphB.setFromVector3(_b.fromArray(s.b.pos).sub(_la.fromArray(s.b.look)));
  const dolly = 1 + 0.12 * Math.sin(Math.PI * s.t); // ease out a little mid-move, then back in
  const fit = Math.min(3.2, Math.max(1, 1.7 / camera.aspect)); // back off on narrow screens
  tgtS.radius = lerp(sphA.radius, sphB.radius, s.t) * dolly * fit;
  tgtS.phi = lerp(sphA.phi, sphB.phi, s.t);
  tgtS.theta = sphA.theta + angleDelta(sphA.theta, sphB.theta) * s.t;
  tgt.shift = lerp(s.a.shift, s.b.shift, s.t);
  tgt.fade = lerp(s.a.fade, s.b.fade, s.t);
  if (narrow) tgt.shift = 0;

  const k = 1 - Math.exp(-dt * 3.2);
  curS.radius = lerp(curS.radius, tgtS.radius, k);
  curS.phi = lerp(curS.phi, tgtS.phi, k);
  curS.theta += angleDelta(curS.theta, tgtS.theta) * k;
  cur.look.lerp(tgt.look, k);
  cur.shift = lerp(cur.shift, tgt.shift, k);
  cur.fade = lerp(cur.fade, tgt.fade, k);

  // gentle parallax: nudge the orbit toward the pointer
  pointer.sx = lerp(pointer.sx, pointer.x, 0.05);
  pointer.sy = lerp(pointer.sy, pointer.y, 0.05);
  viewS.copy(curS);
  viewS.theta += pointer.sx * 0.035;
  viewS.phi -= pointer.sy * 0.025;
  viewS.makeSafe();
  camera.position.setFromSpherical(viewS).add(cur.look);
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
  for (const k in flight) if (!Number.isFinite(flight[k])) flight[k] = 0;

  pivot.rotation.set(
    user.pitch + pointer.sy * 0.12 * motion,
    spin + user.yaw + flight.drift * 0.9 * motion + pointer.sx * 0.25 * motion,
    flight.pitch + Math.sin(time * 0.9) * 0.025 * motion
  );
  pivot.position.y = (Math.sin(time * 1.3) * 0.12 + flight.lift) * motion
    + 3 * smooth(W.mission); // climb clear of the survey terrain

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

  // survey terrain + path: the whole grid flies while the mission section is on screen
  const m = W.mission;
  survey.visible = m > 0.01;
  if (survey.visible) updateSurvey(clamp01((s.missionP - 0.18) / 0.62), m);
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

  // highlight the nav link for whichever section is centred
  let best = null, bestW = 0.5;
  for (const sec of sections) if (W[sec.dataset.cam] > bestW) { bestW = W[sec.dataset.cam]; best = sec.id; }
  if (best !== activeId) {
    activeId = best;
    navLinks.forEach((a) => a.classList.toggle('active', a.hash === `#${best}`));
  }

  bar.style.transform =`scaleX(${clamp01(scrollY / (document.documentElement.scrollHeight - innerHeight))})`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
