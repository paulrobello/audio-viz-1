# RESOMANCE

A mind-bending, audio-reactive visualizer that runs entirely in the browser via
WebGL2. It analyzes a local audio file (or a built-in synthetic demo) and drives
GPU-rendered scenes — a kaleidoscopic fractal field, an epic hyperspace-warp
tunnel, liquid plasma, and a spiral vortex — with phosphor-style feedback trails,
a circular FFT spectrum ring, beat detection, and a master volume control.

The **Tunnel** scene raymarches a coiling, serpentine bore: ribbed neon walls
twist down the tube, light-speed streaks tear past, fresnel rims blaze on the
silhouettes, volumetric god-rays pour down the bore, and a shockwave ring blasts
outward from the camera on every beat.

## Run

Open `index.html` in a Chromium browser (Chrome / Edge / Brave) on Apple Silicon
for full GPU acceleration:

- Double-click `index.html`, **or**
- Serve locally: `python3 -m http.server 8766` → http://localhost:8766/

> WebGL2 is required. On macOS, Chrome/Edge give the best GPU performance.

## Use

- **Load audio** — click *Load audio*, or drag an audio file anywhere onto the
  window. Your last track is remembered across reloads and resumes on first click.
- **Demo synth** — built-in generative audio so it animates with no file loaded.
- **Scene** — `1` Fractal · `2` Tunnel · `3` Plasma · `4` Vortex
- **Palette** — Aether / Plasma Tomb / Cold Circuit / Ember Bloom
- **Spectrum ring** — `R` toggles the circular FFT overlay
- **Volume** — slider (persists across reloads); the visualizer reads the
  pre-volume signal so it stays full-strength at any listening level
- **Space** play/pause · **H** hide UI

## How it works

A single fullscreen fragment shader raymarches / synthesizes the active scene each
frame. Audio is captured with the Web Audio `AnalyserNode` (FFT 2048); bass / mid /
treble bands, spectral centroid, and a bass-energy-flux beat detector feed shader
uniforms. A GPU ping-pong framebuffer provides feedback trails, and a 256-bin R8
texture drives the spectrum ring. The whole thing is one self-contained
`index.html` with no build step and no dependencies.

## License

MIT — see [LICENSE](./LICENSE).
