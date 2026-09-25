# Portfolio

A personal portfolio built around a photogrammetry scan of my 7" ArduPilot mapping drone. As you scroll, the camera moves around the drone and labels its parts. The scan sweeps into a wireframe, and a survey path draws itself underneath.

Plain static files (three.js via CDN, no build step). Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## Run locally

```bash
python -m http.server 5180
```

Then open http://localhost:5180. Add `?cam=fc` (or `hero`, `frame`, `pi`, `scan`, `mission`, `hangar`) to lock the camera on one section while tuning. For `scan` and `mission`, `&p=0.3` sets how far through the animation it is.

## Editing

- **Text / projects / contact** → `index.html`
- **Camera angles per section** → `KEYS` at the top of `main.js`
- **3D labels** → `HOTSPOTS` and `findAnchors()` in `main.js`

## Model pipeline

`MappingDrone1.glb` from RealityScan (69 photos, 4.2M triangles, 171 MB with texture) → `models/drone.glb` (118k triangles, 1.1 MB):

```bash
npx @gltf-transform/cli weld MappingDrone1.glb welded.glb
npx @gltf-transform/cli simplify welded.glb simp.glb --ratio 0.05 --error 0.001
npx @gltf-transform/cli resize simp.glb r.glb --width 2048 --height 2048
npx @gltf-transform/cli webp r.glb w.glb --quality 85
node tools/crop-scan.mjs w.glb models/drone.glb 1.0 0.45 0.5 400
```

`crop-scan.mjs` removes the paper the drone was scanned on (low + bright/red triangles), drops floating scan fragments, converts Z-up to Y-up, and applies meshopt compression. It needs `npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer`.
