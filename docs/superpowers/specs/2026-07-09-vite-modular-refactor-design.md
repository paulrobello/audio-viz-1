# RESOMANCE — Vite Modular Refactor (Design Spec)

- **Date:** 2026-07-09
- **Status:** Approved-in-principle (pending user spec review)
- **Scope:** Refactor the single-file `index.html` app (1,418 lines: ~110 CSS, ~145 HUD markup, ~380 GLSL, ~750 JS) into a modular Vite project, while keeping all runtime behavior pixel-identical.

## 1. Goal

Turn RESOMANCE from one 84 KB `index.html` into a proper multi-module app with a build system, so further feature work (see `ideas.md` Batch 3: mic input, video recording, projection window, chromagram, etc.) is maintainable. The user experience does not change.

## 2. Settled decisions

| Decision | Choice |
|---|---|
| Build system | **Vite** + `vite-plugin-glsl` + `vite-plugin-singlefile` |
| Prod artifact | Single self-contained `index.html` (JS+CSS inlined) |
| Refactor depth | **Split + light restructure** — module seams + one `state.js` seam; behavior identical |
| PWA | **Kept** — service worker, manifest, installable/offline all preserved |
| UI module | **Split** into `ui.js` (player chrome + display) and `controls.js` (look/source panels + input) |
| "No build / zero-dep / double-click" identity | **Dropped** (explicitly accepted) |

The single-file prod output is chosen on its own merits (atomic offline cache, trivial deploy, nothing meaningful to code-split in a ~750-line vanilla app) — not as a constraint-preservation move.

## 3. Non-goals (out of scope)

- No new features. No Batch 3 work.
- No framework (React/Vue/etc.). Stays vanilla JS + WebGL2.
- No re-architecting of the render pipeline, audio math, or beat/auto-mix logic beyond relocating it.
- No test framework added (no tests exist today; `make test` is a documented no-op).
- HUD markup stays static HTML — not templated into JS.

## 4. Target file layout

```
audio-viz-1/
├─ index.html              # thin shell: <head>, canvas, HUD markup; loads /src/main.js
├─ package.json
├─ vite.config.js
├─ jsconfig.json           # checkJs for `make typecheck`
├─ Makefile                # build/dev/preview/lint/fmt/typecheck/checkall/test
├─ .eslintrc.cjs
├─ .prettierrc.json
├─ .pre-commit-config.yaml # unchanged
├─ .gitignore              # unchanged (already ignores node_modules/ dist/)
├─ public/                 # served verbatim at root, copied as-is into dist
│  ├─ sw.js
│  ├─ manifest.webmanifest
│  ├─ icon-192.png
│  ├─ icon-512.png
│  └─ og.jpg
└─ src/
   ├─ main.js              # entry, rAF loop, orchestration
   ├─ state.js             # ★ persisted state + pref() + tiny event bus
   ├─ storage.js           # IndexedDB queue/position
   ├─ audio.js             # AudioContext/Analyser, FFT analysis, onsets, auto-gain
   ├─ playback.js          # sources, queue, transport, seek
   ├─ gl.js                # WebGL2 context, programs, targets, resize, quality
   ├─ render.js            # uniform caches, renderFrame(), screenshot
   ├─ camera.js            # orbit + pinch-zoom gesture state
   ├─ ui.js                # player chrome + display
   ├─ controls.js          # look/source panels + all input (keys, drag-drop)
   ├─ styles.css           # extracted <style>
   └─ shaders/
      ├─ quad.vert
      ├─ scene.frag
      ├─ copy.frag
      ├─ bright.frag
      └─ blur.frag
```

## 5. Module contracts

Each module has one purpose, a defined export surface, and a one-directional dependency graph (no cycles). Where a lower-level module must notify the view, it goes through the event bus in `state.js`.

Dependency direction: `state` ← `storage/audio/camera/gl` ← `playback/render` ← `ui/controls` ← `main`.

### 5.1 `state.js` — the seam (shared, no deps)
- `export const state` — single object holding every persisted/runtime flag:
  `curMode, curStyle, scenePalette[], look{feedback,swirl,glow,vig,ca,grain}, router{kick,snare,hat,bass}, customPal{a,b,c,d}, ringOn, autoHide, autoMixOn, beatShiftOn, autoGainOn, showFps, shuffleOn, repeatMode, qualIdx, volume, presets[], reducedMotion`.
- `pref(key, def, validate?)` — read a JSON localStorage value with default + optional validator (replaces every scattered `parseInt(localStorage.getItem(...))` block).
- `savePref(key, value)` — JSON `setItem`.
- Tiny event bus: `on(event, cb)`, `emit(event, data)`, used so `playback` can notify `ui` without importing it. Event: `'transport'` (play state / track name / seek visibility / track count changes). (`main.js` imports `ui.fatal()` directly for error display — no bus event needed.)
- Preset snapshot (data only, no DOM): `snapshotLook()` returns the plain object currently produced by `captureLook()`; `applySnapshot(p)` writes `state.*` then calls `controls.syncAllUI()`.

### 5.2 `storage.js` — IndexedDB (deps: none)
Async queue + position persistence, lifted verbatim from current `idb*` functions:
`idbGetQueue(): Promise<File[]|null>`, `idbSaveQueue(files)`, `idbSavePos({idx,pos})`, `idbGetPos()`, `idbGetAudio()` (legacy single-track fallback).

### 5.3 `audio.js` — analysis engine (deps: state)
- `ensureCtx()` — creates (once) and resumes `AudioContext` + `AnalyserNode` (fftSize 2048) + `masterVol`; analyser taps pre-volume signal.
- Exposes `audioCtx`, `analyser`, `masterVol` (so `playback` connects sources, `controls` wires the volume slider).
- `analyze()` — per-frame: fills `bands{bass,mid,treble,level,centroid}`, runs spectral-flux onset detection → `beat/snare/hat`, auto-gain normalization. Readings exposed via `getBands()`, `getOnsets()`.
- `reducedMotion` is read from `state`.

### 5.4 `playback.js` — sources + transport (deps: audio, storage, state)
- `loadFiles(files, idx?, offset?, skipSave?)`, `playIndex(i, offset?)`, `nextTrack()`, `prevTrack()`, `onTrackEnd()`, `randIdx()`.
- `playUrl(url)`, `startDemo()`, `stopSources()`.
- `seekTo(frac)`, `currentElapsed()`, `saveQueuePos(pos?)`.
- Folder traversal: `isAudio()`, `readDirEntries()`, `entryToFile()`, `collectEntries()`.
- Exposes transport getters: `getPlaylist()`, `getCurIdx()`, `isPlaying()`, `isDemoSource()`.
- Notifies the view via `emit('transport', {...})` (play-button label, seek visibility, track name, track counter) — `ui.js` listens.

### 5.5 `gl.js` — low-level GL (deps: state)
- Acquires the WebGL2 context; `fatal()` on failure.
- `makeProgram(vs, fs)` (the current `compile`+`program`), `makeTarget(w,h)`.
- Owns the fullscreen-quad VAO + buffer.
- Ping-pong + bloom targets, `resize()` (re-allocates at current `state.qualIdx` DPR cap), `setQuality(i)`.
- Spectrum ring texture (`specTex`, `specData`, `NBINS`).
- Exposes targets/`W/H/BW/BH`/`qual` for `render.js`.

### 5.6 `shaders/*` — GLSL sources (no deps)
Extracted verbatim from the current `<script type="x-shader">` tags. Imported by `render.js` via `vite-plugin-glsl` (`import sceneFrag from './shaders/scene.frag'`).

> **User-shader note:** today `compileUserShader()` reads `document.getElementById('fsScene').textContent` and regex-replaces the `// USER_SHADER_BEGIN…END` block. After extraction it operates on the imported `sceneFrag` string instead — identical logic, different source. The `// USER_SHADER_BEGIN/END` markers stay in `scene.frag`.

### 5.7 `render.js` — draw pipeline (deps: gl, shaders, state, audio, camera)
- `initRender()` — builds the 4 programs from imported shaders, caches uniform locations (`U`, `UC`, `UB`, `UBL`).
- `renderFrame({ time, modeA, modeB, blend, paletteShift, shock })` — the GL passes: scene → bright-pass → separable blur → composite → ping-pong swap. Reads `bands/onsets` from `audio`, camera from `camera`, look/router/palette/scene/quality from `state`, applies reduced-motion scaling, runs the reactivity-router modulation.
- `screenshot()` — captures the canvas to PNG (the `S` hotkey / `pendingShot` path).
- `compileUserShader(code)` — recompiles the scene program with the user body, returns `{ok, error?}` (called directly by `controls.js`, which renders the success/error message into the shader panel — no bus event).

### 5.8 `camera.js` — gestures (deps: none)
- `cam = { yaw, pitch, zoom, active }`.
- `initCamera(canvas)` — wires pointer-down/move/up/cancel + dblclick → updates `cam` (orbit + pinch-zoom). Replaces the current `pointers` map / `updateGesture()` block.

### 5.9 `ui.js` — player chrome + display (deps: state, playback, audio)
The always-visible player and its readouts:
- Meters (`mBass/mMid/mTreble`): `buildMeters`, `paintMeter`, `updateMeters()`.
- `toast(msg)`, `toggleHelp(force?)`, `toggleFullscreen()`.
- Idle show/hide: `poke()`, `showUI()`, `hideUI()`, `autohide` checkbox.
- Play/pause button: `updatePlayBtn()` (wired to `playback` via the bus).
- Seek bar: `showSeek(on)`, `updateSeek()`, `seekTo` (delegates to `playback`), `fmtTime()`.
- Transport buttons (prev/next/shuffle/repeat), `updateTrackCounter()`, `setTrackName(name)`.
- Listens to `'transport'` events from `playback` to refresh button label / seek / counters.

### 5.10 `controls.js` — look/source panels + all input (deps: state, playback, render, audio)
Everything configuration and input:
- Scene segmented control: `setMode(m)`, `applyModeUI()`.
- Palette select + per-scene memory: `setStyle(s)`, `applyScenePalette(m)`.
- Custom palette editor (`a/b/c/d` pickers), `syncColorInputs()`, `syncPalEditor()`.
- Look panel sliders (`bindLook`), reactivity router selects, user-shader panel (delegates `render.compileUserShader`), quality segmented control, FPS/beat-shift/auto-gain checkboxes, volume slider.
- Preset slots: `savePreset(i)`, `recallPreset(i)`, `updatePresetUI()`.
- File input, URL load, **drag-and-drop** (folder traversal → `playback.loadFiles`).
- **The single `keydown` handler** lives here and delegates player keys (`Space`, `←/→`) to `playback`, display keys (`H`, `?`, `Esc`, `F`) to `ui`, and look keys (`1–6`, `Shift+1–8`, `R`, `S`) locally.
- `syncAllUI()` — re-renders every widget from `state` (called by `state.applySnapshot`).

### 5.11 `main.js` — orchestrator (deps: all)
- Global `fatal()` error handler + `window.onerror`.
- The `frame(now)` rAF loop, owning the cross-cutting orchestration currently inline in `frame()`:
  - timing (`t0`, `dt`, `fpsEMA`),
  - beat→BPM estimate + `beatPulse` + `shockStart`,
  - beat-aware `paletteShift`,
  - **auto-mix state machine** (`mixTrans`, `modeA/modeB/blend`, `autoMixNext`, `mixArmedAt`), calling `controls.applyModeUI()`/`applyScenePalette()` on transitions,
  - throttle UI updates (meters/seek/fps/bpm) at the 50 ms cadence.
  - calls `audio.analyze()`, `gl.resize()`, `render.renderFrame({...})`.
- `firstGesture()` — restores the queued playlist at saved position or starts the demo on first user input (browser audio-gesture rule).
- Service-worker registration.
- Boot order: `initRender()`, `initCamera(canvas)`, `initUI()`, `initControls()`, then start the rAF loop.

## 6. Build & tooling config

### `package.json` (devDeps only — no runtime deps)
- `vite`, `vite-plugin-glsl`, `vite-plugin-singlefile`
- `eslint`, `prettier`, `typescript` (for `tsc --checkJs`)

### `vite.config.js` (sketch)
```js
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  plugins: [glsl(), viteSingleFile()],
  build: { target: 'es2020' },
});
```

### `jsconfig.json`
`{ "compilerOptions": { "checkJs": true, "noEmit": true, "target": "ES2020", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }`

### `Makefile` (required by repo conventions)
```
build:     vite build
dev:       vite
preview:   vite preview
lint:      eslint src
fmt:       prettier --write "src/**/*.{js,css}"
typecheck: tsc --noEmit -p jsconfig.json
checkall:  lint typecheck build
test:      @echo "no test suite"
```

## 7. PWA / service-worker notes

- `public/sw.js`, manifest, and icons are copied verbatim into `dist/`.
- With `vite-plugin-singlefile`, the JS+CSS are inlined into `index.html`, so the SW asset list stays essentially unchanged (`./`, `./index.html`, manifest, `og.jpg`, icons) — there are **no separate JS/CSS chunks to cache**. The SW cache-version bump convention (`CACHE = 'resomance-v14'`) continues to apply on any build change.
- SW/manifest/`icon-*`/`og.jpg` are referenced by relative URL and remain separate files (singlefile does not inline binary assets).

## 8. Behavior-parity checklist (must not regress)

Implementation is verified against these after every phase:
- All 6 scenes render identically (incl. user-shader scene + runtime compile-error reporting).
- Audio analysis: bass/mid/treble meters, spectral-flux kick/snare/hat onsets, auto-gain normalization behave the same.
- Feedback ping-pong, bloom (bright-pass + separable blur), copy/tonemap, vignette/chroma/grain post-FX.
- Playlist: file/folder/URL/demo sources, queue + shuffle/repeat, IndexedDB queue + position persistence + resume on first gesture, seek bar.
- Per-scene palette memory, custom palette editor, reactivity router, 8 named presets (Shift recall / Ctrl+Shift save).
- Auto-mix beat-synced crossfades, beat-shift palette rotation, BPM readout, quality presets, FPS meter, reduced-motion, orbit + pinch-zoom camera, screenshot, fullscreen, idle hide, hotkeys, installable/offline PWA.

## 9. Migration phasing (high level)

Detailed task breakdown is produced by the `writing-plans` step. The app stays runnable after every phase:
1. **Build scaffold** — add `package.json`/`vite.config.js`/`Makefile`, move `index.html` to root, extract `styles.css` + 5 shaders, replace inline script with `<script type="module" src="/src/main.js">`. At this point `main.js` can be the *entire current JS unchanged* (one big file) — get `vite build` (singlefile) producing output that runs identically. **Parity verified before any code is split.**
2. **Introduce the seam** — create `state.js` (+ bus) and `storage.js`; migrate localStorage reads/writes and the IDB calls.
3. **Extract modules** one domain at a time — `audio` → `playback` → `gl` → `render` → `camera` → `ui` → `controls` — running the app after each extraction.
4. **Final pass** — update `README.md` (new run/build instructions), bump SW cache version, confirm `make checkall` is clean.

## 10. Risks

- **`vite-plugin-singlefile` + GLSL imports interaction** — both transform the bundle; verify early in Phase 1 that the single-file output actually runs (this is the first parity gate).
- **User-shader regex** — must operate on the imported string, not a DOM node (noted in 5.6).
- **Event-bus wiring** — transport/render notifications must reproduce the current inline call ordering (e.g. `updatePlayBtn` after decode, seek visibility after source change).
- **Module-load / WebGL init timing** — `gl.makeProgram` runs at import/`initRender` time; ensure the GL context exists before shader compile (same ordering as today).
- **Cycle risk** — kept one-directional via the bus; any ui↔playback or ui↔render direct import is a smell to reject in review.
