# RESOMANCE

A mind-bending, audio-reactive visualizer that runs entirely in the browser via
WebGL2. It analyzes a local audio file, a pasted URL/stream, or a built-in synthetic
demo and drives GPU-rendered scenes — a kaleidoscopic fractal field, an epic
hyperspace-warp tunnel, liquid plasma, a spiral vortex, an audio-reactive
terrain, and a user-pasted shader — with phosphor-style feedback trails, a
circular FFT spectrum ring, beat detection, and a master volume control.

The **Tunnel** scene raymarches a coiling, serpentine bore: ribbed neon walls
twist down the tube, light-speed streaks tear past, fresnel rims blaze on the
silhouettes, volumetric god-rays pour down the bore, and a shockwave ring blasts
outward from the camera on every beat.

## Run

Requires a Chromium browser (Chrome / Edge / Brave) on Apple Silicon for full GPU
acceleration. WebGL2 is required.

- **Dev** — `npm install && make dev` → http://localhost:5173/
- **Build single-file PWA** — `make build` → `dist/index.html` (self-contained,
  installable, offline)
- **Preview the build** — `make preview` → http://localhost:4173/
- **Quality gate** — `make checkall` (lint + typecheck + build)

The app is now built by Vite from modular ES-module source under `src/` into a
single self-contained `dist/index.html`. The old "double-click the raw file /
zero dependencies" workflow is gone — there is a one-time `npm install` and a
build step — but runtime behavior is unchanged.

## Use

- **Load audio** — click *Load audio*, drag a file/folder onto the window, or
  paste a URL/stream. The full queue and your position are remembered across
  reloads and resume on first click.
- **Demo synth** — built-in generative audio so it animates with no file loaded.
- **Scene** — `1` Fractal · `2` Tunnel · `3` Plasma · `4` Vortex · `5` Terrain · `6` User
- **Palette** — Aether / Plasma Tomb / Cold Circuit / Ember Bloom / Custom; each
  scene remembers its own.
- **Transport** — shuffle + repeat (off / all / one); `←`/`→` skip.
- **Look panel** — feedback / swirl / glow + vignette / chroma / grain post-FX,
  a reactivity router (kick/snare/hat/bass → swirl/glow/feedback), and 8 named
  look presets (`Shift+1`–`8` recall, `Ctrl+Shift+1`–`8` save).
- **User shader** — paste your own `vec3` GLSL body (`uv`, `u_bass`, `u_mid`,
  `u_treble`, `u_beat`, `u_snare`, `u_hat`, `palette()`, `fbm()`, `u_time`) for a
  custom scene; compile errors are reported.
- **Auto-mix / auto-gain / beat-shift** — beat-synced scene crossfades,
  loudness-normalized reactivity, and tempo-driven palette rotation.
- **Spectrum ring** — `R` toggles the circular FFT overlay
- **Camera** — drag to orbit; pinch-zoom / two-finger orbit on touch.
- **Volume** — slider (persists); the visualizer reads the pre-volume signal so it
  stays full-strength at any listening level.
- **Space** play/pause · **H** hide UI · **?** shortcuts

## How it works

A single fullscreen fragment shader raymarches / synthesizes one of six scenes each
frame (the 6th is a user-pasted shader compiled at runtime). Audio is captured with
the Web Audio `AnalyserNode` (FFT 2048); bass / mid / treble bands, spectral
centroid, and a bass-energy-flux beat detector feed shader uniforms. A GPU
ping-pong framebuffer provides feedback trails, and a 256-bin R8 texture drives the
spectrum ring. The whole thing is built by Vite from modular source under `src/` into a single
self-contained `index.html` PWA — one file at runtime, no external network
dependencies.

## License

MIT — see [LICENSE](./LICENSE).
