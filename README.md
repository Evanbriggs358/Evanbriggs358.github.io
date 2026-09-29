# Mapping Drone

A one-project site about my 7" ArduPilot mapping drone, built around a photogrammetry scan of it. As you scroll, the camera moves around the drone and labels its parts. The scan sweeps into a wireframe, and a survey path draws itself underneath.

Plain static files (three.js via CDN, no build step). Live at https://evanbriggs358.github.io, served by GitHub Pages straight from the `main` branch, so every push to `main` redeploys it.

## Run locally

```bash
python -m http.server 5180
```

Then open http://localhost:5180. Add `?cam=fc` (or `hero`, `frame`, `pi`, `scan`, `mission`, `hangar`) to lock the camera on one section while tuning. For `scan` and `mission`, `&p=0.3` sets how far through the animation it is.

## Editing

- **Text / contact** → `index.html` (bump the `?v=` on `style.css` and `main.js` there whenever you change those files, so visitors don't get a stale cached copy)
- **Camera angles per section** → `KEYS` at the top of `main.js`
- **3D labels** → `HOTSPOTS` and `findAnchors()` in `main.js`

## Model pipeline

`MappingDrone1.glb` from RealityScan (69 photos, 4.2M triangles, 8K texture, 171 MB) becomes three tiers. The page shows the preview immediately, then streams in `drone-hq.glb` on desktops or `drone-mid.glb` on phones and low-memory devices.

| file | triangles | texture | size |
|---|---|---|---|
| `models/drone.glb` (preview) | 118k | 2K | 1.1 MB |
| `models/drone-mid.glb` | 675k | 4K | 5.3 MB |
| `models/drone-hq.glb` | 1.77M (full scan resolution) | 8K | 15.6 MB |

```bash
npx @gltf-transform/cli weld MappingDrone1.glb welded.glb

# full resolution
npx @gltf-transform/cli webp welded.glb full_w.glb --quality 98
node tools/crop-scan.mjs full_w.glb models/drone-hq.glb 1.0 0.45 0.5 3000

# mid
npx @gltf-transform/cli simplify welded.glb mid_s.glb --ratio 0.3 --error 0.0005
npx @gltf-transform/cli resize mid_s.glb mid_r.glb --width 4096 --height 4096
npx @gltf-transform/cli webp mid_r.glb mid_w.glb --quality 95
node tools/crop-scan.mjs mid_w.glb models/drone-mid.glb 1.0 0.45 0.5 1000

# preview
npx @gltf-transform/cli simplify welded.glb simp.glb --ratio 0.05 --error 0.001
npx @gltf-transform/cli resize simp.glb r.glb --width 2048 --height 2048
npx @gltf-transform/cli webp r.glb w.glb --quality 85
node tools/crop-scan.mjs w.glb models/drone.glb 1.0 0.45 0.5 400
```

The full-resolution crop needs `NODE_OPTIONS=--max-old-space-size=12000`.

`crop-scan.mjs` removes the paper the drone was scanned on (low + bright/red triangles), drops floating scan fragments, converts Z-up to Y-up, and applies meshopt compression. It needs `npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer`.
