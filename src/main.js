// @ts-nocheck — boot sequence + frame() orchestration only. Every configuration panel,
// preset slot, input handler, and hotkey lives in controls.js (Task 9). The frame loop below
// owns timing/fpsEMA, audio.analyze, beat→BPM/shock, palette-shift, the auto-mix crossfade
// state machine (shared via state.*), and the renderFrame call. Task 10 will type-check this
// file and remove this opt-out.
import './styles.css';
import { state } from './state.js';
import { audio, analyze } from './audio.js';
import * as pb from './playback.js';
import { resize } from './gl.js';
import { initRender, renderFrame } from './render.js';
import { cam, initCamera } from './camera.js';
import { initUI, fatal, updateMeters, updateSeek } from './ui.js';
import { initControls, applyModeUI, applyScenePalette } from './controls.js';

window.addEventListener('error', (e) => fatal((e.message || 'error') + (e.filename ? '\n' + e.filename + ':' + e.lineno : '')));

const canvas = document.getElementById('gl');
window.addEventListener('resize', resize);   // gl.js performs the initial resize() at module load

// boot: uniform-location caches (+ recompile any saved user shader) -> camera gestures -> player chrome -> panels/input
initRender();
initCamera(canvas);
initUI();
initControls();

// persist the queue position (playback owns the data; main.js owns the app lifecycle)
setInterval(() => pb.saveQueuePos(), 5000);   // checkpoint playback position periodically
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pb.saveQueuePos(); });
window.addEventListener('beforeunload', pb.saveQueuePos);

// accessibility: respect OS reduced-motion (calm swirl, trails, and beat flashes).
// state.reducedMotion is the source of truth read by render.js each frame; keep it live.
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => (state.reducedMotion = e.matches));

// ---------- RENDER LOOP ----------
let t0 = performance.now(), lastUI = 0, lastFrame = 0, fpsEMA = 0;
let bpm = 0, paletteShift = 0, prevBeat = 0, shockStart = -10; const beatTimes = [];   // beat-aware palette shift + shockwave origin
let beatPulse = false;   // one-frame true when a new kick onset is detected (drives beat-synced auto-mix)
function frame(now) {
  const time = (now - t0) / 1000;
  const dt = lastFrame ? now - lastFrame : 0; lastFrame = now;
  if (dt > 0) { const inst = 1000 / dt; fpsEMA = fpsEMA ? fpsEMA * 0.9 + inst * 0.1 : inst; }
  analyze(); resize();
  beatPulse = false;
  // beat-aware palette rotation: estimate BPM from kick onsets, advance the phase shift with tempo + energy
  if (audio.beat > prevBeat + 0.5) { beatPulse = true; beatTimes.push(time); shockStart = time; if (beatTimes.length > 12) beatTimes.shift();
    if (beatTimes.length >= 4) { const iv = []; for (let i = 1; i < beatTimes.length; i++) iv.push(beatTimes[i] - beatTimes[i - 1]); iv.sort((a, b) => a - b); const med = iv[Math.floor(iv.length / 2)]; if (med > 0.3 && med < 2.0) bpm = Math.round(60 / med); } }
  prevBeat = audio.beat;
  if (state.beatShiftOn) paletteShift += dt * 0.001 * ((bpm || 100) / 60 * 0.10 + audio.bands.level * 0.16);
  // auto-mix: arm at the interval, then fire the crossfade on the next beat (downbeat) so transitions feel musical.
  // modeA/modeB/blend/mixTrans/mixArmedAt/autoMixNext live in state (shared with controls.setMode + the autoMix toggle).
  if (state.autoMixOn) {
    if (!state.mixTrans && state.mixArmedAt === null && time >= state.autoMixNext) state.mixArmedAt = time;   // arm: hold for the next beat
    if (!state.mixTrans && state.mixArmedAt !== null) {
      const armWait = (bpm >= 40 && bpm <= 200) ? Math.min(3.0, 2.2 * 60 / bpm) : 3.0;   // fire on a beat, or fall back after ~2 beats (3s if no BPM)
      if (beatPulse || time - state.mixArmedAt >= armWait) { const to = (state.curMode + 1) % 6; state.mixTrans = { from: state.curMode, to, start: time }; state.modeA = state.curMode; state.modeB = to; state.mixArmedAt = null; } }
    if (state.mixTrans) { const k = Math.max(0, Math.min(1, (time - state.mixTrans.start) / state.autoMixDur)); state.blend = k;
      if (!state.mixTrans.palDone && k >= 0.5) { state.mixTrans.palDone = true; applyScenePalette(state.mixTrans.to); }   // swap to the destination scene's palette at the crossfade midpoint
      if (k >= 1) { state.curMode = state.mixTrans.to; state.modeA = state.modeB = state.curMode; state.blend = 0; state.mixTrans = null; state.autoMixNext = time + state.autoMixInterval; applyModeUI(); } }
  }

  // render: spectrum upload + scene + bloom + composite + (optional) screenshot + ping-pong swap
  renderFrame({ time, modeA: state.modeA, modeB: state.modeB, blend: state.blend, paletteShift: state.beatShiftOn ? paletteShift : 0, shock: shockStart, camYaw: cam.yaw, camPitch: cam.pitch, camZoom: cam.zoom, orbitActive: cam.active });

  if (now - lastUI > 50) { lastUI = now; updateMeters(); updateSeek(); if (state.showFps) document.getElementById('fpsVal').textContent = Math.round(fpsEMA) + ' fps'; if (state.beatShiftOn && bpm) document.getElementById('bpmVal').textContent = bpm + ' bpm'; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// auto-start demo after first gesture (browsers require a user gesture for audio)
function firstGesture() {
  pb.onFirstGesture();   // restore the queue at the saved position, else start the demo
  window.removeEventListener('pointerdown', firstGesture); window.removeEventListener('keydown', firstGesture);
}
window.addEventListener('pointerdown', firstGesture);
window.addEventListener('keydown', firstGesture);

// PWA: register service worker for installable + offline support
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
