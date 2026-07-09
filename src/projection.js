// Second-window / projection output. The controller window (normal mode) opens a clean,
// UI-free copy of the canvas in a separate window and broadcasts its per-frame render inputs
// (spectrum + audio bands + scene/look state + camera) over a BroadcastChannel; the projection
// window re-renders the viz from that stream, so a VJ controls the look while projecting the
// pristine output. One-way sync (controller → projection); the projection plays no audio itself.
import { state } from './state.js';
import { audio } from './audio.js';
import { resize, setQuality, NBINS } from './gl.js';
import { initRender, renderFrame } from './render.js';

const CH = 'resomance';
let bc = null;
let projecting = false;        // controller side: are we broadcasting to a projection window?
let projectionWin = null;      // the opened window (to detect close + focus)

// ---------------- controller side ----------------
export function openProjection() {
  if (projecting) { try { projectionWin && projectionWin.focus(); } catch (_) {} return; }
  projecting = true;
  if (!bc) { try { bc = new BroadcastChannel(CH); } catch (_) { projecting = false; return; } }
  const url = location.origin + location.pathname + '?projection=1';
  projectionWin = window.open(url, 'resomance_projection', 'width=960,height=540');
  if (!projectionWin) projecting = false;   // popup blocked
}

// mirror the frame's render inputs to the projection (no-op when no projection is open)
export function postFrame(p) {
  if (!projecting || !bc) return;
  if (projectionWin && projectionWin.closed) { projecting = false; return; }
  const freq = audio.freq ? audio.freq.subarray(0, NBINS) : null;   // structured-clone copies just these 256 bins
  bc.postMessage({
    t: 'f', time: p.time, beatPhase: p.beatPhase, modeA: p.modeA, modeB: p.modeB, blend: p.blend, paletteShift: p.paletteShift, shock: p.shock,
    camYaw: p.camYaw, camPitch: p.camPitch, camZoom: p.camZoom, orbit: p.orbitActive,
    bass: audio.bands.bass, mid: audio.bands.mid, treble: audio.bands.treble, level: audio.bands.level, centroid: audio.bands.centroid,
    beat: audio.beat, snare: audio.snare, hat: audio.hat, freq,
    style: state.curStyle, look: state.look, router: state.router, customPal: state.customPal, ring: state.ringOn, reducedMotion: state.reducedMotion, qualIdx: state.qualIdx,
  });
}

// ---------------- projection (receiver) side ----------------
export function runProjection() {
  // pristine output: strip every piece of UI chrome
  for (const id of ['ui', 'hint', 'toast', 'err', 'drop', 'help']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  initRender();
  resize();
  window.addEventListener('resize', resize);
  audio.freq = new Uint8Array(NBINS);   // spectrum-upload source, filled from the broadcast frame (no AudioContext here)
  let last = null;
  try { bc = new BroadcastChannel(CH); } catch (_) { bc = null; }
  if (bc) bc.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.t !== 'f') return;
    last = m;
    state.curStyle = m.style; state.look = m.look; state.router = m.router; state.customPal = m.customPal;
    state.ringOn = m.ring; state.reducedMotion = m.reducedMotion;
    if (m.qualIdx !== state.qualIdx) setQuality(m.qualIdx);   // update raymarch steps when the controller changes quality
  };
  function loop() {
    requestAnimationFrame(loop);
    if (!last) return;
    audio.bands.bass = last.bass; audio.bands.mid = last.mid; audio.bands.treble = last.treble;
    audio.bands.level = last.level; audio.bands.centroid = last.centroid;
    audio.beat = last.beat; audio.snare = last.snare; audio.hat = last.hat;
    if (last.freq) audio.freq.set(last.freq);
    renderFrame({ time: last.time, beatPhase: last.beatPhase, modeA: last.modeA, modeB: last.modeB, blend: last.blend, paletteShift: last.paletteShift, shock: last.shock, camYaw: last.camYaw, camPitch: last.camPitch, camZoom: last.camZoom, orbitActive: last.orbit });
  }
  requestAnimationFrame(loop);
}
