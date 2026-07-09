// Single source of truth for persisted app state + localStorage pref helper + event bus.
// Reads each key in its CURRENT on-disk format (mixed: bare number-strings, '1'/'0'
// boolean tokens, JSON objects/arrays). Writes still happen inline in main.js today;
// they migrate to ui.js/controls.js in tasks 8-9. Do not reformat anything on disk.
const LS = (k, def, validate) => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null');
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
    try { a = JSON.parse(localStorage.getItem('resomance_scene_palette') ?? 'null'); } catch (_) {}
    if (!Array.isArray(a) || !a.length) {   // empty/absent array → re-seed from the legacy global palette (matches the original seeding IIFE)
      const lg = parseFloat(localStorage.getItem('resomance_palette'));
      const v = lg >= 0 && lg <= 4 ? lg : 0;
      a = [v, v, v, v];
    }
    while (a.length < 6) a.push(0);
    return a.map(Number);
  })(),
  look: Object.assign(
    { feedback: 0.9, swirl: 0.004, glow: 0.06, vig: 0, ca: 0, grain: 0 },
    (() => { try { return JSON.parse(localStorage.getItem('resomance_look') ?? 'null') || {}; } catch (_) { return {}; } })(),
  ),
  router: Object.assign(
    { kick: 'feedback', snare: 'swirl', hat: 'glow', bass: 'none' },
    (() => { try { return JSON.parse(localStorage.getItem('resomance_router') ?? 'null') || {}; } catch (_) { return {}; } })(),
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
  presets: (() => { try { const p = JSON.parse(localStorage.getItem('resomance_presets') ?? 'null'); return Array.isArray(p) ? p : []; } catch (_) { return []; } })(),
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  // --- non-persisted runtime fields: the auto-mix crossfade state machine. Shared
  // between main.js's frame() (advances the crossfade each tick) and controls.js's
  // setMode()/autoMix toggle (reset it). Not snapshotted, not persisted. ---
  autoMixInterval: 14,
  autoMixDur: 0.7,
  modeA: 0, modeB: 0, blend: 0,
  mixTrans: null, mixArmedAt: null, autoMixNext: 0,
};
state.curStyle = state.scenePalette[state.curMode] || 0;
state.modeA = state.modeB = state.curMode;                 // both layers start on the current scene
state.autoMixNext = state.autoMixOn ? state.autoMixInterval : 0;   // first auto-mix fires one interval after boot

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
