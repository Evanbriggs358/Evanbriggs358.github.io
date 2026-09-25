// Remove the paper the drone was scanned on; recenter so the drone sits at the origin, Y-up.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, weld, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [,, input, output, lowArg, hardArg, brightArg] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute('POSITION'), col = prim.getAttribute('COLOR_0'), idx = prim.getIndices();

let minZ = Infinity; for (let i = 0; i < pos.getCount(); i++) minZ = Math.min(minZ, pos.getElement(i, [])[2]);
const LOW = minZ + parseFloat(lowArg), HARD = minZ + parseFloat(hardArg), BRIGHT = parseFloat(brightArg);
console.log('minZ', minZ, 'col', !!col, col && col.getElement(0, []));

const keep = [], p = [], c = [];
let dropped = 0;
for (let t = 0; t < idx.getCount(); t += 3) {
  const v = [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)];
  let maxZ = -Infinity, br = 0, red = 0;
  for (const i of v) {
    maxZ = Math.max(maxZ, pos.getElement(i, p)[2]);
    if (col) { col.getElement(i, c); br += (c[0] + c[1] + c[2]) / 9; red += (c[0] > 0.4 && c[0] > 1.6 * c[1]) ? 1 : 0; }
  }
  const paper = maxZ < HARD || (maxZ < LOW && (br > BRIGHT || red >= 2));
  if (paper) dropped++; else keep.push(...v);
}
console.log('dropped', dropped, 'of', idx.getCount() / 3);

// drop small floating islands (scan noise) — union-find over shared vertices
// UV seams split vertices, so first map every vertex to a canonical one by position
const canon = new Int32Array(pos.getCount()), seen = new Map();
for (let i = 0; i < pos.getCount(); i++) {
  pos.getElement(i, p);
  const k = p.map((n) => Math.round(n * 1e4)).join(',');
  if (!seen.has(k)) seen.set(k, i);
  canon[i] = seen.get(k);
}
const parent = new Int32Array(pos.getCount()).map((_, i) => i);
const find = (i) => { i = canon[i]; while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
for (let t = 0; t < keep.length; t += 3) {
  const a = find(keep[t]), b = find(keep[t + 1]), c2 = find(keep[t + 2]);
  parent[b] = a; parent[find(c2)] = a;
}
const size = new Map();
for (let t = 0; t < keep.length; t += 3) { const r = find(keep[t]); size.set(r, (size.get(r) || 0) + 1); }
const MIN = parseInt(process.argv[7] ?? '400');
const kept2 = [];
for (let t = 0; t < keep.length; t += 3) if (size.get(find(keep[t])) >= MIN) kept2.push(keep[t], keep[t + 1], keep[t + 2]);
console.log('islands', size.size, 'kept', [...size.values()].filter((n) => n >= MIN).length, 'tris', kept2.length / 3);
keep.length = 0; for (const i of kept2) keep.push(i);
idx.setArray(new Uint32Array(keep));
if (col) { prim.setAttribute('COLOR_0', null); col.dispose(); }

// ---------- Taubin smoothing: removes scan lumpiness without shrinking the model ----------
// Works on canonical (position-welded) vertices so UV seams move together and never crack.
const ITER = parseInt(process.argv[8] ?? '0');
const N = pos.getCount();
if (ITER > 0) {
  const deg = new Int32Array(N);
  const edgeUse = new Map(); // undirected edge -> number of triangles using it (1 = open boundary)
  const edge = (a, b) => (a < b ? a * N + b : b * N + a);
  for (let t = 0; t < keep.length; t += 3) {
    const v = [canon[keep[t]], canon[keep[t + 1]], canon[keep[t + 2]]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = edge(a, b);
      const n = edgeUse.get(k) || 0;
      edgeUse.set(k, n + 1);
      if (!n) { deg[a]++; deg[b]++; }
    }
  }
  const start = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i];
  const nbr = new Int32Array(start[N]), fill = start.slice(0, N);
  const pinned = new Uint8Array(N);
  for (const [k, n] of edgeUse) {
    const a = Math.floor(k / N), b = k - a * N;
    nbr[fill[a]++] = b; nbr[fill[b]++] = a;
    if (n === 1) pinned[a] = pinned[b] = 1; // keep the cut edges where they are
  }
  const P = new Float64Array(N * 3), Q = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) if (canon[i] === i) { pos.getElement(i, p); P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2]; }
  const step = (factor) => {
    for (let i = 0; i < N; i++) {
      const d = start[i + 1] - start[i];
      if (!d || pinned[i]) { Q[i * 3] = P[i * 3]; Q[i * 3 + 1] = P[i * 3 + 1]; Q[i * 3 + 2] = P[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let j = start[i]; j < start[i + 1]; j++) { const n = nbr[j] * 3; x += P[n]; y += P[n + 1]; z += P[n + 2]; }
      Q[i * 3] = P[i * 3] + factor * (x / d - P[i * 3]);
      Q[i * 3 + 1] = P[i * 3 + 1] + factor * (y / d - P[i * 3 + 1]);
      Q[i * 3 + 2] = P[i * 3 + 2] + factor * (z / d - P[i * 3 + 2]);
    }
    P.set(Q);
  };
  for (let it = 0; it < ITER; it++) { step(0.5); step(-0.53); }
  for (let i = 0; i < N; i++) { const c0 = canon[i] * 3; pos.setElement(i, [P[c0], P[c0 + 1], P[c0 + 2]]); }
  console.log('taubin iterations', ITER, 'pinned', pinned.reduce((a, b) => a + b, 0));
}

// Z-up scan -> Y-up, centered on the drone
const node = doc.getRoot().listNodes()[0];
await doc.transform(prune());
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
const used = new Set(keep);
for (const i of used) { pos.getElement(i, p); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); } }
const ctr = mn.map((v, k) => (v + mx[k]) / 2);
const s = 1 / Math.max(mx[0] - mn[0], mx[1] - mn[1]) * 10; // longest horizontal span = 10 units
for (let i = 0; i < pos.getCount(); i++) {
  pos.getElement(i, p);
  const x = (p[0] - ctr[0]) * s, y = (p[1] - ctr[1]) * s, z = (p[2] - ctr[2]) * s;
  pos.setElement(i, [x, z, -y]);
}
node.setMatrix([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
console.log('size', mx.map((v, k) => ((v - mn[k]) * s).toFixed(2)));

// Seamless normals: accumulate area-weighted face normals per welded position, so shading
// doesn't crease along UV seams (three.js would compute them per split vertex).
{
  const acc = new Float64Array(N * 3), a = [], b = [], c3 = [];
  for (let t = 0; t < keep.length; t += 3) {
    pos.getElement(keep[t], a); pos.getElement(keep[t + 1], b); pos.getElement(keep[t + 2], c3);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c3[0] - a[0], vy = c3[1] - a[1], vz = c3[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) { const o = canon[keep[t + k]] * 3; acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; }
  }
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = canon[i] * 3, l = Math.hypot(acc[o], acc[o + 1], acc[o + 2]) || 1;
    out[i * 3] = acc[o] / l; out[i * 3 + 1] = acc[o + 1] / l; out[i * 3 + 2] = acc[o + 2] / l;
  }
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out).setBuffer(pos.getBuffer()));
}

await doc.transform(prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeTexcoord: 16, quantizeNormal: 12 }));
await io.write(output, doc);
