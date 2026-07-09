# RESOMANCE Vite Modular Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the single-file `index.html` (1,418 lines) into an 11-module Vite app whose single-file prod build is behavior-identical to today's app.

**Architecture:** Vite + `vite-plugin-glsl` + `vite-plugin-singlefile`. Code is split + lightly restructured around a `state.js` seam (consolidated localStorage) and `storage.js` (IndexedDB). Dependency graph is one-directional; a tiny event bus in `state.js` lets `playback` notify `ui` without a cycle. Migration is incremental: each task extracts one module from `main.js`, leaving the app runnable and parity-verified after every step.

**Tech Stack:** Vanilla JS (ES modules), WebGL2, Web Audio API, Vite 5, eslint, prettier, TypeScript (`tsc --checkJs` for typecheck only — no runtime dep).

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-09-vite-modular-refactor-design.md`):

- **Behavior is pixel-identical.** No new features, no logic changes to shaders, audio math, beat/auto-mix, or the render pipeline. Every changed line must trace to relocation or the `state.js` seam.
- **No runtime dependencies.** `package.json` has only `devDependencies` (vite, vite-plugin-glsl, vite-plugin-singlefile, eslint, prettier, typescript).
- **Prod artifact is a single self-contained `index.html`** (JS+CSS inlined via `vite-plugin-singlefile`).
- **PWA preserved:** `public/sw.js`, `manifest.webmanifest`, icons, `og.jpg` are served verbatim; SW cache-version bump convention continues.
- **Module dependency direction (no cycles):** `state` ← {`storage`, `audio`, `camera`, `gl`} ← {`playback`, `render`} ← {`ui`, `controls`} ← `main`. Any lower layer needing to notify the view goes through the `state.js` bus (`emit`), never a direct import upward.
- **HUD markup stays static HTML** in `index.html` — not templated.
- **Drop the "no-build / zero-dep / double-click" identity** (accepted).

## Verification Protocol (used by every task)

Every task ends with this protocol. "Focus areas" listed per task are the spec §8 items that task is most likely to affect.

**A. Automated gate — must pass clean:**
```bash
make checkall     # runs: eslint src && tsc --noEmit -p jsconfig.json && vite build
```
Expected: all three succeed, exit 0. Fix every lint/typecheck/build error before proceeding.

**B. Live parity check via agentchrome** (respects this project's known gotchas — see memory: agentchrome-testing-gotchas):
1. Serve the single-file build fresh:
   ```bash
   make build && make preview &   # serves dist/ at http://localhost:4173/
   ```
   (For rapid iteration during a task, `make dev` on http://localhost:5173/ avoids the service-worker cache entirely — use it while working, then do the final parity pass against the built `make preview` artifact.)
2. Open it in a **fresh/incognito tab** — the SW is cache-first and will serve a stale build otherwise. Confirm only one tab is attached (close stray tabs).
3. Navigate and assert no console errors:
   ```bash
   agentchrome connect --launch --headless
   agentchrome navigate http://localhost:4173/
   agentchrome console follow --until-idle   # assert: zero "error"/"Shader compile error"/"Link error" lines
   ```
4. Verify rendering with a **pixel readback, not a window screenshot** (window screenshots of the WebGL canvas come back blank in this project). Short JS only:
   ```bash
   agentchrome js "(()=>{const c=document.getElementById('gl');const g=c.getContext('webgl2');const p=new Uint8Array(4);g.readPixels(c.width/2|0,c.height/2|0,1,1,g.RGBA,g.UNSIGNED_BYTE,p);return p.join(',');})()"
   ```
   Expected: a non-`(0,0,0,0)` pixel (the scene is rendering). Repeat after switching scenes.
5. **Mute via the app's volume slider, not a `--mute-audio` flag.**
6. **Beats cannot be exercised with the built-in demo** (the synth demo produces no spectral-flux onsets). To verify beat-dependent features (auto-mix, beat-shift palette rotation, BPM readout, reactivity router, kick/shockwave), load a real percussive audio file via the Load-audio button or drag-drop. If no audio file is available in the harness, run the non-beat parity items and explicitly note the beat-dependent items as "deferred — needs audio file."

**C. Commit** with the message given in the task.

---

## Task 1: Build scaffolding + single-file parity baseline

**Goal:** Stand up the Vite build with glsl + singlefile, extract CSS and the 5 shaders, move static assets to `public/`, and put the *entire current JS* (unchanged logic) into `src/main.js` as an ES module. After this task the code is still one module, but `vite build` produces a single-file `index.html` that runs identically to today. This is the spec's highest-risk gate (singlefile × glsl interaction) — it must pass before any code is split.

**Files:**
- Create: `package.json`, `vite.config.js`, `jsconfig.json`, `.eslintrc.cjs`, `.prettierrc.json`, `Makefile`
- Create: `src/main.js` (the current inline `<script>` body, adapted per below)
- Create: `src/styles.css` (the current `<style>` body, verbatim)
- Create: `src/shaders/quad.vert`, `src/shaders/scene.frag`, `src/shaders/copy.frag`, `src/shaders/bright.frag`, `src/shaders/blur.frag` (verbatim from the current `<script type="x-shader">` tags, including the leading `#version 300 es`)
- Move (root → `public/`): `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `og.jpg`
- Modify: `index.html` (remove `<style>`, the 5 shader `<script>` tags, and the inline app `<script>`; add the module loader)

**Branch first** (work happens on a feature branch, not `main`):
- [ ] **Step 0: Create feature branch**

```bash
git checkout -b refactor/vite-modular
```

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "resomance",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "prettier": "^3.2.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vite-plugin-glsl": "^1.3.0",
    "vite-plugin-singlefile": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `vite.config.js`**

```js
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [glsl(), viteSingleFile()],
  build: { target: 'es2020' },
});
```

- [ ] **Step 3: Create `jsconfig.json`**

```json
{
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.js"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `.eslintrc.cjs`**

```cjs
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
};
```

- [ ] **Step 5: Create `.prettierrc.json`**

```json
{ "singleQuote": true, "printWidth": 120, "trailingComma": "all" }
```

- [ ] **Step 6: Create `Makefile`** (tabs, not spaces, for recipe indentation)

```makefile
.PHONY: build dev preview lint fmt typecheck checkall test

build:
	vite build
dev:
	vite
preview:
	vite preview
lint:
	eslint src
fmt:
	prettier --write "src/**/*.{js,css}"
typecheck:
	tsc --noEmit -p jsconfig.json
checkall: lint typecheck build
test:
	@echo "no test suite"
```

- [ ] **Step 7: Move static assets to `public/`**

```bash
mkdir -p public
git mv sw.js manifest.webmanifest icon-192.png icon-512.png og.jpg public/
```

- [ ] **Step 8: Extract the 5 shaders verbatim** into `src/shaders/`. Copy each `<script type="x-shader/...">` body (including `#version 300 es` and the trailing newline) into the named file:
  - `#vs` (vertex) → `src/shaders/quad.vert`
  - `#fsScene` → `src/shaders/scene.frag`
  - `#fsCopy` → `src/shaders/copy.frag`
  - `#fsBright` → `src/shaders/bright.frag`
  - `#fsBlur` → `src/shaders/blur.frag`

  Do not edit the GLSL.

- [ ] **Step 9: Extract `src/styles.css`** — copy the current `<style>…</style>` body (lines ~32–139) verbatim into `src/styles.css`.

- [ ] **Step 10: Create `src/main.js`** — copy the current inline `<script>` body (lines ~667–1415, the `"use strict";` … service-worker-register block) verbatim, then make exactly these adaptations at the top of the file:

```js
import './styles.css';
import vsSrc from './shaders/quad.vert';
import fsScene from './shaders/scene.frag';
import fsCopy from './shaders/copy.frag';
import fsBright from './shaders/bright.frag';
import fsBlur from './shaders/blur.frag';
'use strict';
```

  And in the body, replace the DOM shader reads with the imports:
  - Delete `const vsSrc = document.getElementById('vs').textContent;`
  - `program(vsSrc, document.getElementById('fsScene').textContent)` → `program(vsSrc, fsScene)`
  - `program(vsSrc, document.getElementById('fsCopy').textContent)` → `program(vsSrc, fsCopy)`
  - `program(vsSrc, document.getElementById('fsBright').textContent)` → `program(vsSrc, fsBright)`
  - `program(vsSrc, document.getElementById('fsBlur').textContent)` → `program(vsSrc, fsBlur)`
  - In `compileUserShader()`: `document.getElementById('fsScene').textContent.replace(/\/\/ USER_SHADER_BEGIN[\s\S]*?\/\/ USER_SHADER_END/, …)` → `fsScene.replace(/\/\/ USER_SHADER_BEGIN[\s\S]*?\/\/ USER_SHADER_END/, …)`

  No other logic changes.

- [ ] **Step 11: Rewire `index.html`** — delete the `<style>…</style>` block, delete all 5 `<script type="x-shader/…">…</script>` blocks, delete the inline app `<script>…</script>`. Immediately before `</body>` add:

```html
<script type="module" src="/src/main.js"></script>
```

  Keep `<head>` (meta, title, manifest link, theme color), the `<div id="err">`, `<canvas id="gl">`, and the entire `<div id="ui">` HUD markup unchanged.

- [ ] **Step 12: Install deps and run the automated gate**

```bash
npm install
make checkall
```
Expected: `eslint` clean, `tsc` clean, `vite build` produces `dist/index.html` (single file — confirm no separate `dist/assets/*.js` is required at runtime; singlefile inlines them). If singlefile leaves hashed assets, that's a config problem to fix now.

- [ ] **Step 13: Parity gate** — run the **Verification Protocol**, focus areas: page loads with no console errors; WebGL renders (pixel readback non-zero); all 6 scenes switch via `1`–`6` and the segmented control; demo plays; Load-audio / drag-drop / URL load work; screenshot (`S`) downloads a PNG; fullscreen (`F`); help (`?`); hide UI (`H`). This is the make-or-break gate — do not proceed to Task 2 until the single-file build is parity-clean.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "build: scaffold Vite + glsl + singlefile; extract css/shaders to src/

Prod build inlines JS+CSS into a single index.html (PWA preserved).
App logic unchanged — main.js is the full former inline script as an ES module.
Static assets moved to public/. First single-file parity gate passes."
```

---

## Task 2: Introduce the `state.js` seam + `storage.js`

**Goal:** Create the two foundation modules. Migrate every `localStorage` read/write and every IndexedDB call out of `main.js` into `state.js` (prefs) and `storage.js` (IDB). `main.js` still owns all logic; it just sources persistence from these modules. This is the spec's one structural change.

**Files:**
- Create: `src/state.js`, `src/storage.js`
- Modify: `src/main.js` (replace persistence calls with imports)

**Interfaces:**
- Produces (from spec §5.1, §5.2) — later tasks consume these exact names:

`state.js`:
```js
export const state = { /* all persisted/runtime fields, see Step 1 */ };
export function pref(key, def, validate);   // JSON read w/ default + optional validator
export function savePref(key, value);        // JSON write
export function on(event, cb);               // bus subscribe
export function emit(event, data);           // bus publish
export function snapshotLook();              // plain object (preset capture, no DOM)
export function applySnapshot(p);            // writes state.*, then calls controls.syncAllUI()
```
`storage.js`:
```js
export async function idbGetQueue();         // Promise<File[]|null>
export async function idbSaveQueue(files);
export async function idbSavePos({ idx, pos });
export async function idbGetPos();           // Promise<{idx,pos}|null>
export async function idbGetAudio();         // legacy single-track fallback
```

- [ ] **Step 1: Create `src/state.js`**

```js
// Single source of truth for persisted app state + localStorage pref helper + event bus.
const LS = (k, def, validate) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return validate ? (validate(v) ? v : def) : (v ?? def);
  } catch (_) {
    return def;
  }
};

// curMode/curStyle/scenePalette seeded from their current localStorage keys + validators.
export const state = {
  curMode: LS('resomance_scene', 0, (n) => Number.isInteger(n) && n >= 0 && n <= 5),
  curStyle: 0, // set below from scenePalette
  scenePalette: (() => {
    let a;
    try { a = JSON.parse(localStorage.getItem('resomance_scene_palette')); } catch (_) {}
    if (!Array.isArray(a)) {
      const lg = parseFloat(localStorage.getItem('resomance_palette'));
      const v = lg >= 0 && lg <= 4 ? lg : 0;
      a = [v, v, v, v];
    }
    while (a.length < 6) a.push(0);
    return a.map(Number);
  })(),
  look: Object.assign(
    { feedback: 0.9, swirl: 0.004, glow: 0.06, vig: 0, ca: 0, grain: 0 },
    (() => { try { return JSON.parse(localStorage.getItem('resomance_look')); } catch (_) { return {}; } })(),
  ),
  router: Object.assign(
    { kick: 'feedback', snare: 'swirl', hat: 'glow', bass: 'none' },
    (() => { try { return JSON.parse(localStorage.getItem('resomance_router')); } catch (_) { return {}; } })(),
  ),
  customPal: (() => {
    const def = { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] };
    try {
      const s = JSON.parse(localStorage.getItem('resomance_custompal') || '{}');
      const out = JSON.parse(JSON.stringify(def));
      for (const k of ['a', 'b', 'c', 'd']) if (Array.isArray(s[k]) && s[k].length === 3) out[k] = s[k].map(Number);
      return out;
    } catch (_) { return JSON.parse(JSON.stringify(def)); }
  })(),
  ringOn: localStorage.getItem('resomance_ring') !== '0',
  autoHide: localStorage.getItem('resomance_autohide') !== '0',
  autoMixOn: localStorage.getItem('resomance_automix') === '1',
  beatShiftOn: localStorage.getItem('resomance_beatshift') === '1',
  autoGainOn: localStorage.getItem('resomance_autogain') !== '0',
  showFps: localStorage.getItem('resomance_fps') === '1',
  shuffleOn: localStorage.getItem('resomance_shuffle') === '1',
  repeatMode: LS('resomance_repeat', 1, (n) => Number.isInteger(n) && n >= 0 && n <= 2),
  qualIdx: LS('resomance_quality', 1, (n) => Number.isInteger(n) && n >= 0 && n <= 2),
  volume: (() => { const v = parseFloat(localStorage.getItem('resomance_vol')); return isNaN(v) ? 0.9 : v; })(),
  presets: (() => { try { const p = JSON.parse(localStorage.getItem('resomance_presets')); return Array.isArray(p) ? p : []; } catch (_) { return []; } })(),
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};
state.curStyle = state.scenePalette[state.curMode] || 0;

export const pref = LS; // alias used by readers that only need a value
export function savePref(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// --- tiny event bus (no import cycles) ---
const _bus = new Map();
export function on(event, cb) { if (!_bus.has(event)) _bus.set(event, new Set()); _bus.get(event).add(cb); }
export function emit(event, data) { (_bus.get(event) || []).forEach((cb) => cb(data)); }

// --- preset snapshot (data only) ---
export function snapshotLook() {
  return {
    mode: state.curMode,
    style: state.scenePalette[state.curMode],
    look: { ...state.look },
    router: { ...state.router },
    customPal: JSON.parse(JSON.stringify(state.customPal)),
    ring: state.ringOn,
    autoHide: state.autoHide,
    autoMix: state.autoMixOn,
    beatShift: state.beatShiftOn,
    autoGain: state.autoGainOn,
  };
}
// applySnapshot writes state.* then refreshes UI. controls.syncAllUI is wired in Task 9;
// until then applySnapshot just writes state (controls does not exist yet).
let _syncAllUI = () => {};
export function setSyncAllUI(fn) { _syncAllUI = fn; }
export function applySnapshot(p) {
  state.scenePalette[p.mode] = p.style;
  state.curMode = p.mode;
  Object.assign(state.look, p.look);
  Object.assign(state.router, p.router);
  Object.assign(state.customPal, p.customPal);
  state.ringOn = p.ring;
  state.autoHide = p.autoHide;
  state.autoMixOn = p.autoMix;
  state.beatShiftOn = p.beatShift;
  state.autoGainOn = p.autoGain;
  _syncAllUI();
}
```

> Note: `applySnapshot` persists nothing itself — persistence happens as each widget handler writes its own `savePref` when `syncAllUI` re-dispatches. This mirrors today's `applyLook()` which fires `change` events. Keep that behavior.

- [ ] **Step 2: Create `src/storage.js`** — lift the current `idbOpen/idbGetAudio/idbSaveQueue/idbGetQueue/idbSavePos/idbGetPos` functions (index.html lines ~788–831) verbatim into `src/storage.js`, convert each to an `export` (rename `idbOpen` to a non-exported local), and `export` the five public functions with the signatures above.

- [ ] **Step 3: Migrate `main.js` persistence calls.** Add imports at the top:
```js
import { state, savePref, on, emit, snapshotLook, applySnapshot } from './state.js';
import { idbGetQueue, idbSaveQueue, idbSavePos, idbGetPos, idbGetAudio } from './storage.js';
```
  Then mechanically replace, throughout `main.js`:
  - Every module-level `let X = localStorage.getItem(...)` / `parseInt(localStorage.getItem(...))` initializer for a field now in `state` → delete the local; use `state.X`.
  - Every `localStorage.setItem('resomance_<key>', ...)` → `savePref('resomance_<key>', value)` (wrap raw strings/numbers in their natural type; `savePref` JSON-encodes — verify the read side uses `JSON.parse` or `getItem(...)==='1'` style; where today's code stores a bare `'1'`/`'0'` token, keep storing the JSON form `"1"` and update the reader, OR add a `savePrefRaw` — prefer: store JSON and adjust readers to `pref(...)`). Concretely: keys storing booleans as `'1'`/`'0'` (`shuffle`, `ring`, `autohide`, `automix`, `beatshift`, `autogain`, `fps`) — store `true`/`false` via `savePref` and read via `pref(key, def)`. Keys storing numbers (`scene`, `repeat`, `quality`, `vol`) — store the number, read via `pref(key, def, validate)`.
  - The IndexedDB IIFE restore block (lines ~836–841), `idbSaveQueue`/`idbSavePos` calls, and the legacy `idbGetAudio` call → use the imported `storage.js` functions.
  - `captureLook()` → `return snapshotLook();`. `applyLook(p)` → `applySnapshot(p)` (plus any remaining direct DOM sync it did; today it dispatches `change` events — keep equivalent behavior via `syncAllUI` once controls exists; for now replicate the dispatch calls `applyLook` currently makes, since controls/widgets still live in main.js).

  No behavioral change — same keys, same values, same validation defaults as today.

- [ ] **Step 4: Run automated gate**
```bash
make checkall
```
Expected: clean. (eslint may flag unused vars if a migrated local left an orphan — remove only orphans your change created.)

- [ ] **Step 5: Parity gate** — Verification Protocol, focus areas: **persistence**. After reload, confirm each survives: volume, current scene, per-scene palette, look sliders, router mappings, custom palette, ring/autohide/automix/beatshift/autogain/fps toggles, shuffle + repeat mode, quality preset, 8 presets (Shift recall / Ctrl+Shift save). Confirm the **queue + playback position restore on first gesture** after reload (drop a folder, reload, click → resumes at the right track + offset). Confirm legacy single-track fallback still restores.

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "refactor(state): add state.js seam + storage.js; migrate localStorage/IndexedDB

Consolidates ~20 scattered localStorage calls behind pref()/savePref() and
moves IndexedDB queue/position persistence into storage.js. Behavior unchanged."
```

---

## Task 3: Extract `audio.js`

**Goal:** Move the AudioContext/Analyser lifecycle and the per-frame analysis (band extraction, spectral-flux onset detection, auto-gain) into `src/audio.js`. `main.js` imports the readings each frame.

**Files:**
- Create: `src/audio.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `state` (for `autoGainOn`, `reducedMotion`) from `state.js`.
- Produces (spec §5.3):
```js
export function ensureCtx();              // creates+resumes AudioContext/Analyser/masterVol
export function analyze();                // per-frame; updates bands + onsets
export const audioCtx /* getter below */, analyser, masterVol; // see note
export function getBands();               // { bass, mid, treble, level, centroid }
export function getOnsets();              // { beat, snare, hat }
```
> **Note on mutable exports:** JS `export let` for frequently-updated scalars is error-prone (importers get a stale binding snapshot in some toolchains). Export `getBands()`/`getOnsets()` accessors returning the live objects, and export `analyser`/`masterVol`/`audioCtx` via accessor functions (`getAnalyser()`, `getMasterVol()`, `getAudioCtx()`) since they are null until `ensureCtx()`. `main.js`'s render loop calls `getBands()`/`getOnsets()` each frame.

- [ ] **Step 1: Create `src/audio.js`** — move, from `main.js`, the `// ---------- AUDIO ----------` declarations that are *analysis* (not source/transport): `audioCtx`, `analyser`, `freq`, `masterVol`, `bands`, `beat`, `snare`, `hat`, `freqPrev`, `kickFlux/snareFlux/hatFlux`, `loudEMA`, `ensureCtx`, and the entire `analyze()` function (lines ~774–785, 846–861, 984–1020). Do **not** move `srcNode`, `demoNodes`, `urlAudio`, `urlMes`, `curBuffer`, `playlist`, transport state — those belong to `playback.js` (Task 4). `ensureCtx` reads `state.autoGainOn`/volume from `state`; `analyze()` reads `state.autoGainOn`. Export per the interface above.

- [ ] **Step 2: Rewire `main.js`** — `import { ensureCtx, analyze, getBands, getOnsets, getAnalyser, getMasterVol } from './audio.js';`. Replace every reference to `bands`, `beat`, `snare`, `hat`, `analyser`, `masterVol`, `audioCtx` in the remaining `main.js` with the accessor calls / the objects returned by them. The render loop's `analyze()` call and uniform uploads (`bands.bass`, etc.) use `getBands()`/`getOnsets()`.

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: demo plays on first gesture; bass/mid/treble meters move; with a real audio file, kick/snare/hat onsets fire (beat flash, swirl/glow/feedback router modulation visible), auto-gain normalizes a quiet vs loud track.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(audio): extract audio.js (AudioContext/Analyser + analysis + onsets)"
```

---

## Task 4: Extract `playback.js`

**Goal:** Move all audio sources and transport — file/URL/demo playback, playlist queue, shuffle/repeat, seek, folder traversal — into `src/playback.js`. It depends on `audio` (analyser), `storage` (queue/pos persistence), and `state` (shuffle/repeat), and notifies the view (still in `main.js` until Task 8) via the `state` bus.

**Files:**
- Create: `src/playback.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `ensureCtx`, `getAnalyser` from `audio.js`; `idbSaveQueue`, `idbSavePos` from `storage.js`; `state`, `emit` from `state.js`.
- Produces (spec §5.4):
```js
export function loadFiles(files, idx?, offset?, skipSave?);
export function playIndex(i, offset?);
export function nextTrack();
export function prevTrack();
export function onTrackEnd();
export function playUrl(url);
export function startDemo();
export function stopSources();
export function seekTo(frac);
export function currentElapsed();
export function saveQueuePos(pos?);
export function isAudio(f);
export function collectEntries(entries);   // folder traversal (readDirEntries/entryToFile internal)
export function getPlaylist();
export function getCurIdx();
export function isPlaying();
export function isDemoSource();
export function setPlaying(v);              // play/pause button toggles this
```
- **Bus contract:** playback calls `emit('transport', { type, ... })` wherever today's code calls `updatePlayBtn()`, `showSeek()`, `setTrackName()`, or `updateTrackCounter()` directly. Event shapes:
  - `{ type: 'playState' }` (after play/pause/startDemo/onTrackEnd stops)
  - `{ type: 'trackName', name }`
  - `{ type: 'seekVisibility', on }`
  - `{ type: 'trackCount' }`

- [ ] **Step 1: Create `src/playback.js`** — move from `main.js`: the source/transport vars (`srcNode`, `demoNodes`, `playing`, `isDemo`, `urlAudio`, `urlMes`, `curBuffer`, `startCtxTime`, `trackDur`, `seeking`, `playlist`, `curIdx`, `loadToken`, `decodeFails`, `repeatMode`→`state.repeatMode`, `shuffleOn`→`state.shuffleOn`), and functions `playFile`, `playUrl`, `isAudio`, `loadFiles`, `playIndex`, `randIdx`, `nextTrack`, `prevTrack`, `onTrackEnd`, `readDirEntries`, `entryToFile`, `collectEntries`, `startDemo`, `stopSources`, `seekTo`, `currentElapsed`, `saveQueuePos`, `setTrackName` (move here; it emits `trackName`). Replace direct UI calls (`updatePlayBtn()`, `showSeek()`, `updateTrackCounter()`) with the corresponding `emit('transport', …)`. Wire sources to `getAnalyser()`. Persist via `idbSaveQueue`/`idbSavePos`.

- [ ] **Step 2: Rewire `main.js`** — import the playback functions it still calls directly (seek slider handlers, prev/next/shuffle/repeat buttons, file/url/drag-drop handlers, first-gesture restore, play button). Subscribe to the bus for the UI updates that used to be inline:
```js
import * as pb from './playback.js';
import { on } from './state.js';
on('transport', (e) => {
  if (e.type === 'playState') updatePlayBtn();
  else if (e.type === 'trackName') document.getElementById('sub').textContent = e.name;
  else if (e.type === 'seekVisibility') showSeek(e.on);
  else if (e.type === 'trackCount') updateTrackCounter();
});
```

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: load a single file; drop a folder (queue + track counter `n / m`); URL/stream load; demo; play/pause; seek scrub + jump; prev/next; shuffle; repeat off/all/one (including repeat-one looping a single track and repeat-off stopping after the last linear track); queue + position restore across reload.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(playback): extract playback.js (sources, queue, transport, seek)

Notifies the view via the state bus ('transport') instead of direct UI calls."
```

---

## Task 5: Extract `gl.js`

**Goal:** Move the WebGL2 context acquisition, program/compile helpers, fullscreen-quad VAO, ping-pong + bloom target management, `resize()`, quality presets, and the spectrum-ring texture into `src/gl.js`.

**Files:**
- Create: `src/gl.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `state` (`qualIdx`), the imported shader sources (`quad.vert`, `scene.frag`, `copy.frag`, `bright.frag`, `blur.frag`) — import these in `gl.js` now and pass to `makeProgram`, OR keep importing in `main.js` and pass into `gl.init()`. **Decision: import shaders in `gl.js`** (it owns program building) and export ready programs.
- Produces (spec §5.5):
```js
export const gl;                            // WebGL2RenderingContext (throws via fatal if absent)
export const vao;                           // fullscreen quad
export function makeProgram(vs, fs);        // compile+link helper (also used by render's user shader)
export function makeTarget(w, h);           // { tex, fbo }
export function resize();                   // re-alloc targets at current state.qualIdx DPR
export function setQuality(i);              // updates state.qualIdx + forces re-alloc
export const targets;                        // { texA,texB,fboA,fboB,bloomTexA,bloomTexB,bloomFboA,bloomFboB, W,H,BW,BH }
export const specTex, specData, NBINS;
export const QUAL;
export const programs;                       // { scene, copy, bright, blur } built at init
export function rebuildSceneProgram(fsSrc);  // for render.compileUserShader (delete+rebuild scene prog)
```
> `fatal()` lives in `main.js` (it touches the DOM `#err`). `gl.js` calls a fatal handler registered from main: export `let onFatal = () => {}; export function setFatal(fn){ onFatal = fn; }` and call `onFatal(msg)` + `throw` on context/compile failure. `main.js` registers `setFatal(fatal)` at boot.

- [ ] **Step 1: Create `src/gl.js`** — move from `main.js`: `gl` context acquisition (with `onFatal`), `compile`/`program` (as `makeProgram`), the 4 `program(...)` builds (now from imported shaders → `programs`), VAO/buffer setup, `makeTarget`, ping-pong/bloom target vars + `resize()`, `QUAL` + `qualIdx`(from `state`)+`qual`+`setQuality()`, spectrum texture (`specTex`, `specData`, `NBINS`), `W/H/BW/BH`. Add `setFatal`/`onFatal`.

- [ ] **Step 2: Rewire `main.js`** — import `gl`, `vao`, `targets`, `specTex`, `specData`, `NBINS`, `resize`, `setQuality`, `programs`, `makeProgram`, `rebuildSceneProgram`, `setFatal`. Call `setFatal(fatal)` before any GL work. The render loop (still in main.js) reads `targets`/`programs`/`specTex`. Remove the now-duplicated shader imports from main.js (they live in gl.js).

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: scene renders (pixel readback); window resize re-allocates targets without flicker/errors; quality Low/Med/High switch reallocates and changes sharpness/perf; spectrum ring (`R`) draws; bloom present.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(gl): extract gl.js (context, programs, targets, resize, quality)"
```

---

## Task 6: Extract `render.js`

**Goal:** Move the uniform-location caches and the per-frame draw pipeline (scene → bright-pass → separable blur → composite → ping-pong swap), the screenshot capture, and `compileUserShader` into `src/render.js`. `main.js`'s loop keeps the orchestration (timing, auto-mix, BPM, paletteShift, shock) and passes the per-frame dynamic values into `renderFrame()`.

**Files:**
- Create: `src/render.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `gl`, `vao`, `targets`, `specTex`, `specData`, `NBINS`, `programs`, `makeProgram`, `rebuildSceneProgram` from `gl.js`; `getBands`, `getOnsets` from `audio.js`; `state` from `state.js`; `cam` from `camera.js` (Task 7 — **not yet present**; until Task 7, accept camera values as params: see note).
- Produces (spec §5.7):
```js
export function initRender();   // build uniform caches U/UC/UB/UBL from gl.programs
export function renderFrame(params);
// params = { time, modeA, modeB, blend, paletteShift, shock, camYaw, camPitch, camZoom, orbitActive }
export function screenshot();
export function compileUserShader(code);   // returns { ok, error? }
```
> **Camera note:** Task 7 extracts camera. To keep tasks independent, `renderFrame` takes `camYaw/camPitch/camZoom/orbitActive` as params. Until Task 7, `main.js` passes its inline camera vars; after Task 7, it passes `camera.cam.*`. The `params` shape does not change.

- [ ] **Step 1: Create `src/render.js`** — move from `main.js`: `buildSceneU`, the uniform caches `U`/`UC`/`UB`/`UBL`, the GL draw portion of `frame()` (from `// upload spectrum` through the ping-pong swap, lines ~1085–1151), the `pendingShot` screenshot block (as `screenshot()`), and `compileUserShader` (as `compileUserShader(code)` returning `{ok,error?}` and calling `rebuildSceneProgram`). `initRender()` builds the caches. `renderFrame(params)` reads `getBands()`/`getOnsets()`, `state` (look/router/customPal/curStyle/reducedMotion/ringOn/qual), and `params` for the dynamic blend/camera/shock values, applies reduced-motion scaling + router modulation exactly as today, and performs the swap.

- [ ] **Step 2: Rewire `main.js`** — `import { initRender, renderFrame, screenshot, compileUserShader } from './render.js';`. Call `initRender()` at boot (after gl). Replace the inline draw block in `frame()` with `renderFrame({ time, modeA, modeB, blend, paletteShift: state.beatShiftOn ? paletteShift : 0, shock, camYaw, camPitch, camZoom, orbitActive })`. The `S` hotkey and `pendingShot` path call `screenshot()`. The shader Compile button calls `compileUserShader(code)` and renders the result message from the returned `{ok,error}`.

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: all 6 scenes render identically; bloom (bright-pass + blur) composite; vignette/chromatic-aberration/film-grain post-FX; reduced-motion calming; screenshot downloads a correct PNG; **user-shader scene** — paste a body, Compile shows `compiled ✓`, errors report with the message in the tooltip/console; feedback ping-pong trails.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(render): extract render.js (uniforms, renderFrame, screenshot, user shader)"
```

---

## Task 7: Extract `camera.js`

**Goal:** Move orbit + pinch-zoom gesture handling into `src/camera.js`.

**Files:**
- Create: `src/camera.js`
- Modify: `src/main.js`, `src/render.js` (only if render reads camera directly — per Task 6 it takes params, so render.js should not need changes; verify)

**Interfaces:**
- Produces (spec §5.8):
```js
export const cam = { yaw: 0, pitch: 0, zoom: 1, active: false };
export function initCamera(canvas);   // wires pointerdown/move/up/cancel + dblclick
```

- [ ] **Step 1: Create `src/camera.js`** — move from `main.js`: `camYaw`, `camPitch`, `camZoom`, `orbitActive`, `dragging`, `lastDX`, `lastDY`, `pointers`, `pinchDist0`, `updateGesture()`, and the five canvas pointer/dblclick listeners (lines ~1062, 1388–1403). Expose `cam` and `initCamera(canvas)`. `updateGesture` mutates `cam.*`.

- [ ] **Step 2: Rewire `main.js`** — `import { cam, initCamera } from './camera.js';`. Call `initCamera(document.getElementById('gl'))` at boot. In `frame()`, pass `cam.yaw, cam.pitch, cam.zoom, cam.active` into `renderFrame`. Delete the moved declarations/listeners.

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: drag orbits the Fractal/Tunnel field; two-finger pinch zooms; two-finger orbit; double-click resets to auto (`toast('auto camera')`); orbit uniform visibly changes the raymarched view.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(camera): extract camera.js (orbit + pinch-zoom gestures)"
```

---

## Task 8: Extract `ui.js` (player chrome + display)

**Goal:** Move the always-visible player and its readouts into `src/ui.js`: meters, toast, help modal, fullscreen, idle show/hide, play/pause, seek bar, transport buttons, track counter. It subscribes to the `transport` bus.

**Files:**
- Create: `src/ui.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `state`; playback (`pb.*`) for play/seek/prev/next/shuffle/repeat; `on` from `state.js`.
- Produces (spec §5.9):
```js
export function initUI();          // wire all player DOM + subscribe to 'transport'
export function fatal(msg);        // the #err handler (also used by main's window.onerror + gl.setFatal)
export function updateMeters();
export function updateSeek();
export function poke();            // idle reveal (called by main's input listeners)
```

- [ ] **Step 1: Create `src/ui.js`** — move from `main.js`: `errEl`/`fatal`, `buildMeters`/`paintMeter`/`updateMeters`, `toast`/`toastEl`, `helpEl`/`toggleHelp`, `toggleFullscreen`, idle (`IDLE_MS`, `idleTimer`, `showUI`/`hideUI`/`poke`, the `pointermove`/`pointerdown`/`wheel`/`touchstart` poke listeners), play button (`playBtn`, `updatePlayBtn`, click handler → toggles `pb.setPlaying`/`pb.playIndex` per current logic), seek (`seekRow`, `seekEl`, `curTimeEl`, `totTimeEl`, `fmtTime`, `showSeek`, `seekTo`→`pb.seekTo`, `updateSeek`, input/change handlers), prev/next/shuffle/repeat buttons + `updateTrackCounter` + `applyShufUI`/`applyRepUI`. `initUI()` wires all of it and registers the `on('transport', …)` handler (the one created in Task 4 moves here from main.js).

- [ ] **Step 2: Rewire `main.js`** — `import { initUI, fatal, updateMeters, updateSeek, poke } from './ui.js';`. Call `initUI()` and `gl.setFatal(fatal)` at boot; register `window.onerror → fatal`. The throttled UI update in `frame()` calls `updateMeters()`/`updateSeek()`. The `pointermove`/`wheel` poke listeners now live in ui.js (remove from main). Move the `on('transport')` subscription out of main.js (it is now inside `initUI`).

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean.

- [ ] **Step 4: Parity gate** — Verification Protocol, focus areas: bass/mid/treble meters animate; toasts appear (shuffle/repeat/scene/etc.); help modal opens (`?`) and closes (backdrop/Esc); fullscreen toggle (`F`); idle auto-hide after 10s + reveal on input + manual `H` toggle; play/pause label updates; seek bar scrubs + jumps (file only) and hides for demo/URL; prev/next/shuffle/repeat buttons + track counter `n / m` (disabled when single track).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(ui): extract ui.js (player chrome, meters, toast, help, seek, transport)"
```

---

## Task 9: Extract `controls.js` (look/source panels + all input)

**Goal:** Move every configuration panel and all remaining input into `src/controls.js`: scene selector, palette + custom-palette editor, look panel, reactivity router, user-shader panel, quality, FPS/beat-shift/auto-gain toggles, volume, preset slots, file/url/drag-drop loading, and the single `keydown` handler. After this, `main.js` is just the boot sequence + the `frame()` orchestration loop.

**Files:**
- Create: `src/controls.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `state` (`state`, `savePref`, `snapshotLook`, `applySnapshot`, `setSyncAllUI`); `pb.*`; `compileUserShader`, `setQuality`/`setMode` (setMode moves here); `audio.getMasterVol`/`getAudioCtx`.
- Produces (spec §5.10):
```js
export function initControls();     // wire all panels + keydown + drag-drop + register setSyncAllUI
export function setMode(m);
export function applyModeUI();
export function applyScenePalette(m);
export function syncAllUI();        // re-render every widget from state (used by applySnapshot)
```

- [ ] **Step 1: Create `src/controls.js`** — move from `main.js`: scene seg (`modeSeg`, `setMode`, `applyModeUI`, click handler); palette (`styleSel`, `applyScenePalette`, `setStyle`, change handler); custom palette (`v2h`/`h2v`/`syncColorInputs`/`syncPalEditor`, `cpA–D` input handlers); look panel (`lookToggle`, `lookPanel`, `bindLook`); router (`RT_OPTS`, `rtKick/Snare/Hat/Bass` selects); user shader (`shaderToggle`, `shaderPanel`, `shaderCode`, `shaderCompile`→`compileUserShader`, `shaderMsg`, saved-shader restore); quality (`qualSeg`, `setQuality` via gl, click handler, `fpsChk`/`fpsVal`); beat-shift (`beatShiftChk`, `bpmVal`); auto-gain (`agcChk`); volume (`volSlider`, `volLbl` → `getMasterVol()`); ring/autohide/automix checkboxes; presets (`presets`→`state.presets`, `savePreset`/`recallPreset`/`updatePresetUI`, `ps` buttons, `psSave`); file input + URL load + drag-drop (`drop`, `dragover`/`dragleave`/`drop`→`pb.collectEntries`/`pb.loadFiles`); the `keydown` handler (delegating player keys to `pb`, display keys to `ui`, look keys local). `initControls()` wires all of it and calls `setSyncAllUI(syncAllUI)` so preset apply refreshes every widget. `syncAllUI()` re-applies mode UI, palette select/custom-editor, look sliders, router selects, and all checkbox states from `state`.

- [ ] **Step 2: Rewire `main.js`** — `import { initControls, setMode, applyModeUI, applyScenePalette } from './controls.js';`. Boot sequence becomes: `gl.setFatal(fatal)` → `initRender()` → `initCamera(canvas)` → `initUI()` → `initControls()` → start rAF. The auto-mix state machine in `frame()` calls `applyModeUI()`/`applyScenePalette()` from controls. Delete everything moved.

- [ ] **Step 3: Run automated gate** — `make checkall`. Expected: clean. `main.js` should now be roughly the boot sequence + `frame()` orchestration only (~120 lines).

- [ ] **Step 4: Parity gate** — full Verification Protocol (this task touches the most surface): every panel opens/closes; scene `1`–`6` + seg; palette select + per-scene memory + custom editor (color pickers update the viz live); look sliders; router selects modulate visuals onsets (needs audio file); user shader compile + error reporting; quality Low/Med/High; FPS meter; beat-shift palette rotation + BPM readout (needs audio file); auto-gain; volume; ring/autohide/automix toggles; 8 presets save (`Ctrl+Shift+n`) + recall (`Shift+n`) + slot fill indicator; file/folder drag-drop; URL load; **every hotkey** (Space, `1–6`, `Shift+1–8`, `Ctrl+Shift+1–8`, `R`, `S`, `F`, `H`, `?`, `←`/`→`, Esc).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(controls): extract controls.js (panels, presets, input, hotkeys)

main.js is now boot sequence + frame() orchestration only."
```

---

## Task 10: Finalize — README, service-worker cache bump, full parity pass

**Goal:** Close out the refactor. Update docs for the new build/run flow, bump the SW cache so existing installs pick up the new build, remove any dead code orphaned by the extraction, and run the complete spec §8 parity checklist end-to-end on the single-file build.

**Files:**
- Modify: `README.md`, `public/sw.js` (cache version bump), possibly `src/*.js` (dead-code removal only — orphans created by this refactor)

- [ ] **Step 1: Update `README.md`** — replace the "Run" section. New instructions:
  - Dev: `npm install && make dev` → http://localhost:5173/
  - Build a single-file PWA: `make build` → `dist/index.html` (self-contained, installable, offline)
  - Preview the build: `make preview` → http://localhost:4173/
  - Quality: `make checkall` (lint + typecheck + build)
  - Note the dropped "double-click the raw file / zero deps" identity and that WebGL2 + Chromium/Apple-Silicon remains the requirement. Update "How it works" to mention the modular source under `src/` (no behavior change to describe).

- [ ] **Step 2: Bump the SW cache version** in `public/sw.js`: `const CACHE = 'resomance-v13';` → `'resomance-v14';` so cache-first serves the new build to existing installs.

- [ ] **Step 3: Dead-code sweep** — search `src/` for unused exports/imports introduced by the extraction (e.g., a helper moved but its old call site left an orphan, an `import` no longer used). Remove only orphans this refactor created. Re-run `make checkall`.

- [ ] **Step 4: Full end-to-end parity pass** — run the entire Verification Protocol against `make build && make preview` in a fresh tab, exercising **every item** in the spec §8 checklist, including beat-dependent features with a real audio file. Any deviation is a regression to fix before merge.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "docs+chore: README for Vite build flow; bump SW cache to v14; dead-code sweep

Full spec §8 parity verified against the single-file build."
```

- [ ] **Step 6: Merge** — per the user's workflow, the feature branch `refactor/vite-modular` is ready to merge to `main` once parity is confirmed. (Merge/push is an outward-facing action — confirm with the user before merging or opening a PR.)

---

## Self-Review (completed)

**1. Spec coverage** — every spec section maps to a task:
- §2 decisions (build/depth/PWA/UI-split) → Task 1 + Global Constraints ✓
- §4 file layout → Task 1 (scaffold + public/ + src/shaders + styles.css), Tasks 2–9 (each module) ✓
- §5.1–§5.11 module contracts → Task 2 (state), 2 (storage), 3 (audio), 4 (playback), 5 (gl), 6 (render), 6 (shaders via gl), 7 (camera), 8 (ui), 9 (controls), all-modules (main) ✓
- §6 build/tooling config → Task 1 (package.json/vite.config/jsconfig/Makefile/eslint/prettier) ✓
- §7 PWA/SW → Task 1 (public/ move) + Task 10 (cache bump) ✓
- §8 parity checklist → Verification Protocol + each task's focus areas + Task 10 full pass ✓
- §9 migration phasing (4 phases) → Tasks 1 (Phase 1), 2 (Phase 2), 3–9 (Phase 3 per-module), 10 (Phase 4) ✓
- §10 risks (singlefile×glsl → Task 1 gate; user-shader regex → Task 1 Step 10 + Task 6; bus ordering → Task 4; GL init timing → Task 5 setFatal; cycles → enforced via bus) ✓

**2. Placeholder scan** — none. Every code step shows the actual code or the exact relocation source (line ranges + function names). Where a step says "move these functions," it lists them by name and the export contract gives their signatures.

**3. Type/name consistency** — checked: `renderFrame` params `{time, modeA, modeB, blend, paletteShift, shock, camYaw, camPitch, camZoom, orbitActive}` match across Task 6 (defines) and Task 7 (main passes `cam.*`). `compileUserShader(code)→{ok,error?}` matches Task 6 (defines) and Task 9 (controls calls). `syncAllUI`/`setSyncAllUI` match Task 2 (state defines `setSyncAllUI`/`applySnapshot`) and Task 9 (controls registers via `setSyncAllUI`). `transport` bus event shapes match Task 4 (emits) and Task 8 (ui subscribes). `getBands`/`getOnsets` match Task 3 (defines) and Task 6 (render reads).
