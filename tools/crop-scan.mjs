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
await doc.transform(prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(output, doc);
