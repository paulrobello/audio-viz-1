// Configuration panels + all remaining input, lifted from the former monolith (Task 9).
// Owns: scene segmented selector, palette + custom-palette editor, look panel, reactivity
// router, user-shader panel, quality seg, fps/beat-shift/auto-gain toggles, volume slider,
// ring/autohide/automix checkboxes, the 8 named look presets (snapshot slots), file/url/demo
// loaders + drag-drop folder traversal, and the single keydown handler. Also owns the
// auto-mix crossfade reset on setMode/preset-recall. Every persisted key keeps its original
// on-disk format (bare '1'/'0' tokens, String(number), JSON.stringify objects) — do not
// reformat. syncAllUI() pushes the full state object back into the DOM (and re-writes the
// same localStorage keys) so preset recall + boot both paint every widget from state; it is
// wired into state.js's applySnapshot via setSyncAllUI so a recalled preset refreshes UI.
import { state, savePref, emit, snapshotLook, applySnapshot, setSyncAllUI } from './state.js';
import { audio } from './audio.js';
import * as pb from './playback.js';
import { toggleHelp, toggleFullscreen, toggleHideKey, isHelpOpen, isSeekFocused, poke } from './ui.js';
import { compileUserShader, requestScreenshot } from './render.js';
import { setQuality } from './gl.js';

// controls' own boot clock — used by setMode/autoMix to (re)arm the auto-mix interval timer.
// Captured at module load (same app-start instant as main.js's frame clock); the sub-ms skew
// is invisible on a 14 s timer, so autoMixNext stays in lock-step with frame()'s time base.
const t0 = performance.now();
function clockSec() { return (performance.now() - t0) / 1000; }

// ---------- element refs (DOM is parsed before this module loads — same as ui.js) ----------
const modeSeg = document.getElementById('modeSeg');
const styleSel = /** @type {HTMLSelectElement} */ (document.getElementById('style'));
const lookToggle = document.getElementById('lookToggle'), lookPanel = document.getElementById('lookPanel');
const shaderToggle = document.getElementById('shaderToggle'), shaderPanel = document.getElementById('shaderPanel');
const shaderCode = /** @type {HTMLTextAreaElement} */ (document.getElementById('shaderCode')), shaderCompile = document.getElementById('shaderCompile'), shaderMsg = document.getElementById('shaderMsg');
const qualSeg = document.getElementById('qualSeg');
const ringChk = /** @type {HTMLInputElement} */ (document.getElementById('ring'));
const autohideChk = /** @type {HTMLInputElement} */ (document.getElementById('autohide'));
const autoMixChk = /** @type {HTMLInputElement} */ (document.getElementById('autoMix'));
const beatShiftChk = /** @type {HTMLInputElement} */ (document.getElementById('beatShift')), bpmVal = document.getElementById('bpmVal');
const agcChk = /** @type {HTMLInputElement} */ (document.getElementById('agc'));
const fpsChk = /** @type {HTMLInputElement} */ (document.getElementById('fpsChk')), fpsVal = document.getElementById('fpsVal');
const volSlider = /** @type {HTMLInputElement} */ (document.getElementById('vol')), volLbl = document.getElementById('volLbl');
const psSave = /** @type {HTMLInputElement} */ (document.getElementById('psSave'));
const drop = document.getElementById('drop');

// ---------- custom cosine-palette editor (a/b/c/d vectors), persisted ----------
function v2h(v) { return '#' + v.map((x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0')).join(''); }
function h2v(h) { return (h.replace('#', '').match(/.{2}/g) || []).map((x) => parseInt(x, 16) / 255); }
function syncColorInputs() { const map = { cpA: 'a', cpB: 'b', cpC: 'c', cpD: 'd' }; for (const id in map) { const el = /** @type {HTMLInputElement} */ (document.getElementById(id)); if (el) el.value = v2h(state.customPal[map[id]]); } }
function syncPalEditor() { const w = document.getElementById('palEdit'); if (!w) return; w.style.display = state.curStyle === 4 ? 'flex' : 'none'; if (state.curStyle === 4) syncColorInputs(); }

// ---------- scene segmented selector ----------
export function applyModeUI() { [...modeSeg.children].forEach((x) => x.classList.toggle('on', parseInt(/** @type {HTMLElement} */ (x).dataset.mode, 10) === state.curMode)); }
// recall a scene's remembered palette into the active uniform + UI
export function applyScenePalette(m) { const s = state.scenePalette[m] || 0; state.curStyle = s; styleSel.value = String(s); syncPalEditor(); }
export function setMode(m) {
  state.curMode = m; state.modeA = state.modeB = m; state.blend = 0; state.mixTrans = null; state.mixArmedAt = null;
  applyModeUI(); applyScenePalette(m); localStorage.setItem('resomance_scene', String(m));
  if (state.autoMixOn) state.autoMixNext = clockSec() + state.autoMixInterval;
}
function setStyle(s) { state.curStyle = s; state.scenePalette[state.curMode] = s; styleSel.value = String(s); localStorage.setItem('resomance_scene_palette', JSON.stringify(state.scenePalette)); syncPalEditor(); }
function setRing(on) { state.ringOn = on; ringChk.checked = on; localStorage.setItem('resomance_ring', on ? '1' : '0'); }

// ---------- presets (snapshot slots), recalled with Shift+1..8 ----------
while (state.presets.length < 8) state.presets.push(null);
function savePreset(i) { state.presets[i] = snapshotLook(); savePref('resomance_presets', state.presets); updatePresetUI(); emit('transport', { type: 'toast', msg: 'saved preset ' + (i + 1) }); }
function recallPreset(i) { if (!state.presets[i]) { emit('transport', { type: 'toast', msg: 'preset ' + (i + 1) + ' empty' }); return; } applySnapshot(state.presets[i]); emit('transport', { type: 'toast', msg: 'recalled preset ' + (i + 1) }); }
function updatePresetUI() { document.querySelectorAll('.ps').forEach((b) => { const btn = /** @type {HTMLElement} */ (b); b.classList.toggle('filled', !!state.presets[+btn.dataset.s - 1]); }); }

// ---------- re-render EVERY widget from state (used by applySnapshot + boot) ----------
// Replaces the former applyLook's DOM dispatchEvent('change') approach with a direct,
// state-driven refresh. Re-writes each localStorage key in its original on-disk format so a
// recalled preset persists exactly as the old applyLook did (harmless no-op at boot).
export function syncAllUI() {
  // auto-mix crossfade machine: hard-cut to the (possibly restored) current scene, mirroring
  // the old applyLook -> setMode side effect.
  state.modeA = state.modeB = state.curMode; state.blend = 0; state.mixTrans = null; state.mixArmedAt = null;
  if (state.autoMixOn) state.autoMixNext = clockSec() + state.autoMixInterval;
  // scene seg
  applyModeUI();
  localStorage.setItem('resomance_scene', String(state.curMode));
  // palette select + custom editor + color inputs
  state.curStyle = state.scenePalette[state.curMode] || 0;
  styleSel.value = String(state.curStyle);
  syncPalEditor(); syncColorInputs();
  localStorage.setItem('resomance_scene_palette', JSON.stringify(state.scenePalette));
  // look sliders (feedback/swirl/glow/vig/ca/grain)
  for (const k of ['feedback', 'swirl', 'glow', 'vig', 'ca', 'grain']) { const el = /** @type {HTMLInputElement} */ (document.getElementById('lk' + k.charAt(0).toUpperCase() + k.slice(1))); if (el) el.value = state.look[k]; }
  localStorage.setItem('resomance_look', JSON.stringify(state.look));
  // reactivity router selects
  for (const [id, src] of [['rtKick', 'kick'], ['rtSnare', 'snare'], ['rtHat', 'hat'], ['rtBass', 'bass']]) { const s = /** @type {HTMLSelectElement} */ (document.getElementById(id)); if (s) s.value = state.router[src]; }
  localStorage.setItem('resomance_router', JSON.stringify(state.router));
  // custom palette vectors
  localStorage.setItem('resomance_custompal', JSON.stringify(state.customPal));
  // checkboxes (byte-identical '1'/'0' tokens); beat-shift/fps also blank their readout when off
  ringChk.checked = state.ringOn; localStorage.setItem('resomance_ring', state.ringOn ? '1' : '0');
  autohideChk.checked = state.autoHide; localStorage.setItem('resomance_autohide', state.autoHide ? '1' : '0');
  autoMixChk.checked = state.autoMixOn; localStorage.setItem('resomance_automix', state.autoMixOn ? '1' : '0');
  beatShiftChk.checked = state.beatShiftOn; localStorage.setItem('resomance_beatshift', state.beatShiftOn ? '1' : '0'); if (!state.beatShiftOn) bpmVal.textContent = '--';
  agcChk.checked = state.autoGainOn; localStorage.setItem('resomance_autogain', state.autoGainOn ? '1' : '0');
  fpsChk.checked = state.showFps; localStorage.setItem('resomance_fps', state.showFps ? '1' : '0'); if (!state.showFps) fpsVal.textContent = '';
  // quality seg highlight
  [...qualSeg.children].forEach((b) => b.classList.toggle('on', parseInt(/** @type {HTMLElement} */ (b).dataset.q, 10) === state.qualIdx));
  // volume
  volSlider.value = String(state.volume); volLbl.textContent = Math.round(state.volume * 100) + '%';
  localStorage.setItem('resomance_vol', String(state.volume));
  // preset slot fill indicators
  updatePresetUI();
}

// ---------- wire every panel + input + hotkey (called once from boot) ----------
export function initControls() {
  // file / demo / URL sources
  const fileIn = /** @type {HTMLInputElement} */ (document.getElementById('file'));
  fileIn.addEventListener('change', () => { if (fileIn.files && fileIn.files.length) pb.loadFiles(fileIn.files); });
  document.getElementById('demo').addEventListener('click', pb.startDemo);
  const urlIn = /** @type {HTMLInputElement} */ (document.getElementById('urlIn'));
  document.getElementById('urlLoad').addEventListener('click', () => { const u = urlIn.value.trim(); if (u) pb.playUrl(u); });
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('urlLoad').click(); } });

  // scene segmented buttons
  modeSeg.addEventListener('click', (e) => { const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-mode]')); if (b) setMode(parseInt(b.dataset.mode, 10)); });

  // palette select
  styleSel.addEventListener('change', () => setStyle(parseFloat(styleSel.value)));
  // custom palette a/b/c/d color pickers
  [['cpA', 'a'], ['cpB', 'b'], ['cpC', 'c'], ['cpD', 'd']].forEach(([id, k]) => { const el = /** @type {HTMLInputElement} */ (document.getElementById(id)); el.addEventListener('input', () => { state.customPal[k] = h2v(el.value); localStorage.setItem('resomance_custompal', JSON.stringify(state.customPal)); }); });

  // ring toggle
  ringChk.addEventListener('change', () => setRing(ringChk.checked));
  // auto-hide HUD toggle
  autohideChk.addEventListener('change', () => { state.autoHide = autohideChk.checked; localStorage.setItem('resomance_autohide', state.autoHide ? '1' : '0'); if (!state.autoHide) poke(); });
  // auto-mix scene cycling (crossfade to next scene on a timer)
  autoMixChk.addEventListener('change', () => {
    state.autoMixOn = autoMixChk.checked; localStorage.setItem('resomance_automix', state.autoMixOn ? '1' : '0');
    if (state.autoMixOn) { state.mixTrans = null; state.mixArmedAt = null; state.autoMixNext = clockSec() + state.autoMixInterval; }
    else { state.modeA = state.modeB = state.curMode; state.blend = 0; state.mixTrans = null; state.mixArmedAt = null; }
  });

  // volume (master gain ramp)
  volSlider.addEventListener('input', () => {
    const v = parseFloat(volSlider.value);
    if (audio.master) audio.master.gain.setTargetAtTime(v, audio.ctx.currentTime, 0.02);
    volLbl.textContent = Math.round(v * 100) + '%';
    localStorage.setItem('resomance_vol', String(v));
  });

  // look panel: feedback / swirl / glow / vig / ca / grain sliders, persisted like volume
  lookToggle.addEventListener('click', () => (lookPanel.style.display = lookPanel.style.display === 'none' ? 'flex' : 'none'));
  const LK = [['lkFeedback', 'feedback'], ['lkSwirl', 'swirl'], ['lkGlow', 'glow'], ['lkVig', 'vig'], ['lkCa', 'ca'], ['lkGrain', 'grain']];
  LK.forEach(([id, key]) => { const el = /** @type {HTMLInputElement} */ (document.getElementById(id)); el.addEventListener('input', () => { state.look[key] = parseFloat(el.value); localStorage.setItem('resomance_look', JSON.stringify(state.look)); }); });

  // user shader: paste a vec3 scene body, compiled into the scene program at runtime (compile errors reported)
  shaderToggle.addEventListener('click', () => (shaderPanel.style.display = shaderPanel.style.display === 'none' ? 'flex' : 'none'));
  shaderCompile.addEventListener('click', () => {
    const r = compileUserShader(shaderCode.value);
    if (r.ok) { shaderMsg.textContent = 'compiled ✓'; shaderMsg.style.color = '#7fd0a0'; shaderCode.title = ''; }
    else { shaderMsg.textContent = 'compile error (see tooltip/console)'; shaderMsg.style.color = '#ff7a8a'; shaderCode.title = r.error; }
  });
  shaderCode.value = localStorage.getItem('resomance_usershader') || 'return palette(u_time*0.1 + u_bass + length(uv)*0.3) * (0.3 + u_bass);';
  // initRender() (called at boot in main.js) recompiles the saved user shader, if any.

  // reactivity router: source -> target selects (kick/snare/hat/bass -> none/swirl/glow/feedback), persisted
  const RT_OPTS = ['none', 'swirl', 'glow', 'feedback'];
  [['rtKick', 'kick'], ['rtSnare', 'snare'], ['rtHat', 'hat'], ['rtBass', 'bass']].forEach(([id, src]) => {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById(id));
    RT_OPTS.forEach((o) => { const op = document.createElement('option'); op.value = o; op.textContent = o; sel.appendChild(op); });
    sel.addEventListener('change', () => { state.router[src] = sel.value; localStorage.setItem('resomance_router', JSON.stringify(state.router)); });
  });

  // quality preset (DPR cap + raymarch steps)
  qualSeg.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-q]'));
    if (b) { setQuality(parseInt(b.dataset.q, 10)); [...qualSeg.children].forEach((x) => x.classList.toggle('on', parseInt(/** @type {HTMLElement} */ (x).dataset.q, 10) === state.qualIdx)); }
  });
  // FPS meter
  fpsChk.addEventListener('change', () => { state.showFps = fpsChk.checked; localStorage.setItem('resomance_fps', state.showFps ? '1' : '0'); if (!state.showFps) fpsVal.textContent = '--'; });
  // beat-aware palette shift (BPM estimate drives palette rotation)
  beatShiftChk.addEventListener('change', () => { state.beatShiftOn = beatShiftChk.checked; localStorage.setItem('resomance_beatshift', state.beatShiftOn ? '1' : '0'); if (!state.beatShiftOn) bpmVal.textContent = '--'; });
  // auto-gain
  agcChk.addEventListener('change', () => { state.autoGainOn = agcChk.checked; localStorage.setItem('resomance_autogain', state.autoGainOn ? '1' : '0'); });

  // preset slot buttons (save when psSave checked, else recall)
  document.querySelectorAll('.ps').forEach((b) => b.addEventListener('click', () => { const btn = /** @type {HTMLElement} */ (b); const i = +btn.dataset.s - 1; if (psSave.checked) savePreset(i); else recallPreset(i); }));

  // keyboard: player keys -> pb, display keys -> ui, scene/look keys -> local
  window.addEventListener('keydown', (e) => {
    if (e.key === '?') { toggleHelp(); return; }
    if (e.key === 'Escape' && isHelpOpen()) { toggleHelp(false); return; }
    if (isHelpOpen()) return;                       // modal: swallow other keys while the cheat sheet is open
    if (e.code === 'Space') { e.preventDefault(); pb.togglePlay(); }
    if (e.key === 'h' || e.key === 'H') { toggleHideKey(); return; }
    if (e.shiftKey && e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= 8) { e.preventDefault(); if (e.ctrlKey || e.metaKey) savePreset(n - 1); else recallPreset(n - 1); return; } }
    if (e.key >= '1' && e.key <= '6') setMode(parseInt(e.key, 10) - 1);
    if (e.key === 'r' || e.key === 'R') setRing(!state.ringOn);
    if (e.key === 's' || e.key === 'S') requestScreenshot();
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isSeekFocused()) { e.preventDefault(); e.key === 'ArrowRight' ? pb.nextTrack() : pb.prevTrack(); }
    poke();                                         // any other key counts as activity
  });

  // drag & drop (folder traversal via webkitGetAsEntry)
  window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
  window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) drop.classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('on');
    const dt = e.dataTransfer;
    if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
      const entries = []; for (const it of dt.items) { const en = it.webkitGetAsEntry(); if (en) entries.push(en); }
      if (entries.length) { pb.collectEntries(entries).then(pb.loadFiles); return; }
    }
    if (dt.files && dt.files.length) pb.loadFiles(dt.files);
  });

  // wire syncAllUI into state.js so applySnapshot (preset recall) repaints every widget,
  // then paint everything from state once for boot.
  setSyncAllUI(syncAllUI);
  syncAllUI();
}
