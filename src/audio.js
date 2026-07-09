// Audio engine: AudioContext/Analyser/master-volume lifecycle + per-frame analysis
// (band extraction, spectral-flux onset detection, auto-gain). Lifted verbatim from
// the former monolith; the analysis math, onset thresholds, auto-gain formula, FFT
// size, smoothing, and signal routing (analyser → master → destination) are unchanged.
// main.js reads the live `audio` namespace each frame.
import { state } from './state.js';

/**
 * Live audio namespace — mutated in place by ensureCtx (ctx/analyser/master/freq) and by
 * analyze() (bands + beat/snare/hat). main.js reads these fields each frame.
 * `freq` is the raw FFT buffer; main.js copies its first NBINS bins into the spectrum
 * texture each frame (that copy used to live inside analyze() but depends on render state).
 * @type {{
 *   ctx: AudioContext | null,
 *   analyser: AnalyserNode | null,
 *   master: GainNode | null,
 *   freq: Uint8Array<ArrayBuffer> | null,
 *   bands: { bass: number, mid: number, treble: number, level: number, centroid: number },
 *   beat: number, snare: number, hat: number,
 *   chroma: Float32Array,
 *   key: { pc: number, mode: string, name: string },
 * }}
 */
export const audio = {
  ctx: null,        // AudioContext (set by ensureCtx)
  analyser: null,   // AnalyserNode (set by ensureCtx)
  master: null,     // GainNode master volume (set by ensureCtx)
  freq: null,       // Uint8Array(frequencyBinCount) — raw FFT, read by main.js for the spectrum ring texture
  bands: { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0 },  // mutated by analyze()
  beat: 0, snare: 0, hat: 0,   // onset impulses, mutated by analyze()
  chroma: new Float32Array(12),        // 12-bin pitch-class chroma vector (mean-subtracted, smoothed)
  key: { pc: 0, mode: 'major', name: '–' },   // estimated key (Krumhansl–Schmuckler)
};

// internal-only analysis state (not exported)
/** @type {Uint8Array | null} */
let freqPrev = null;
let kickFlux = 0.0001, snareFlux = 0.0001, hatFlux = 0.0001;   // adaptive onset thresholds
let loudEMA = 0.1;   // rolling loudness estimate for auto-gain
let bassEMA = 0.05, midEMA = 0.05, trebleEMA = 0.05;            // per-band rolling level (perceptual edges + per-band auto-gain)
const chromaAcc = new Float32Array(12);                          // per-frame chroma accumulator (pitch-class energy)
const keyVotes = new Float32Array(24);                           // 12 major + 12 minor key votes (slow decay → stable key)
let _edges = null, _edgesN = 0;                                  // cached mel/log bin edges, keyed by bin count

// Krumhansl–Schmuckler key profiles (C reference) + pitch-class names
const KEY_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KEY_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KEY_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// perceptual (mel/log) bin edges for the bass/mid/treble split + the chroma pitch range
function melEdges(n) {
  const sr = audio.ctx ? audio.ctx.sampleRate : 44100;
  const binHz = sr / 2048;
  const bin = (hz) => Math.max(1, Math.min(n - 1, Math.round(hz / binHz)));
  return { bassEnd: bin(250), midEnd: bin(2000), chromaLo: bin(55), chromaHi: bin(2000) };
}

export function ensureCtx() {
  let c = audio.ctx;
  if (!c) {
    // @ts-expect-error window.webkitAudioContext is a legacy Safari-prefixed API absent from the TS DOM lib
    c = new (window.AudioContext || window.webkitAudioContext)();
    const an = c.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.82;
    audio.freq = new Uint8Array(an.frequencyBinCount);
    const mv = c.createGain();
    mv.gain.value = state.volume;
    // analyser taps the FULL pre-volume signal so the viz stays full at any listening level
    an.connect(mv);
    mv.connect(c.destination);
    audio.ctx = c;
    audio.analyser = an;
    audio.master = mv;
  }
  if (c.state === 'suspended') c.resume();
}

export function analyze() {
  if (!audio.analyser) return;
  const freq = audio.freq;
  if (!freq) return;   // freq is allocated alongside the analyser in ensureCtx; never null when analyser exists
  audio.analyser.getByteFrequencyData(freq);
  const n = freq.length;
  if (!freqPrev || freqPrev.length !== n) freqPrev = new Uint8Array(n);
  if (!_edges || _edgesN !== n) { _edges = melEdges(n); _edgesN = n; }
  const E = _edges;
  const binHz = (audio.ctx ? audio.ctx.sampleRate : 44100) / 2048;
  let b = 0, m = 0, tr = 0, sum = 0, wsum = 0, total = 0;
  let kickF = 0, snareF = 0, hatF = 0;   // spectral flux per band (positive bin deltas)
  chromaAcc.fill(0);
  for (let i = 0; i < n; i++) {
    const v = freq[i] / 255; sum += v; total += v; wsum += v * i;
    const d = freq[i] - freqPrev[i];
    if (i < E.bassEnd) { b += v; if (d > 0) kickF += d; }
    else if (i < E.midEnd) { m += v; if (d > 0) snareF += d; }
    else { tr += v; if (d > 0) hatF += d; }
    if (i >= E.chromaLo && i < E.chromaHi) {                  // log-frequency → pitch class for the chroma vector
      const hz = i * binHz;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chromaAcc[pc] += v;
    }
  }
  audio.bands.bass = b / Math.max(1, E.bassEnd);
  audio.bands.mid = m / Math.max(1, E.midEnd - E.bassEnd);
  audio.bands.treble = tr / Math.max(1, n - E.midEnd);
  audio.bands.level = sum / n;
  audio.bands.centroid = total > 0 ? (wsum / total) / n : 0.5;
  // NOTE: the spectrum-texture copy (specData[i]=freq[i]) now lives in render.js's
  // renderFrame — specData/NBINS are render-layer state (gl.js), outside analyze().
  freqPrev.set(freq);

  // spectral-flux onset detection per band (kick/snare/hat) with adaptive thresholds
  kickF /= 255 * Math.max(1, E.bassEnd); snareF /= 255 * Math.max(1, E.midEnd - E.bassEnd); hatF /= 255 * Math.max(1, n - E.midEnd);
  // auto-gain: per-band normalization against each band's rolling level, so the perceptual (mel/log)
  // edges give truer bands while quiet AND loud tracks still react at full range per band.
  loudEMA = loudEMA * 0.99 + audio.bands.level * 0.01;
  bassEMA = bassEMA * 0.97 + audio.bands.bass * 0.03;
  midEMA = midEMA * 0.97 + audio.bands.mid * 0.03;
  trebleEMA = trebleEMA * 0.97 + audio.bands.treble * 0.03;
  const ng = (ema) => (state.autoGainOn ? Math.max(0.6, Math.min(5, 0.4 / (ema + 0.03))) : 1);
  const gab = ng(bassEMA), gam = ng(midEMA), gat = ng(trebleEMA), gal = ng(loudEMA);
  audio.bands.bass = Math.min(1.5, audio.bands.bass * gab); audio.bands.mid = Math.min(1.5, audio.bands.mid * gam); audio.bands.treble = Math.min(1.5, audio.bands.treble * gat); audio.bands.level = Math.min(1.5, audio.bands.level * gal);
  kickF *= gab; snareF *= gam; hatF *= gat;
  kickFlux = kickFlux * 0.94 + kickF * 0.06; snareFlux = snareFlux * 0.94 + snareF * 0.06; hatFlux = hatFlux * 0.94 + hatF * 0.06;
  if (kickF > kickFlux * 1.6 && kickF > 0.020) audio.beat = 1.0;   // kick drives the existing u_beat
  if (snareF > snareFlux * 1.6 && snareF > 0.015) audio.snare = 1.0;
  if (hatF > hatFlux * 1.7 && hatF > 0.010) audio.hat = 1.0;
  audio.beat *= 0.90; audio.snare *= 0.88; audio.hat *= 0.84;

  // chroma vector (mean-subtracted + EMA-smoothed) → key estimate (Krumhansl–Schmuckler)
  let cmean = 0; for (let k = 0; k < 12; k++) cmean += chromaAcc[k]; cmean /= 12;
  for (let k = 0; k < 12; k++) audio.chroma[k] = audio.chroma[k] * 0.90 + Math.max(0, chromaAcc[k] - cmean) * 0.10;
  estimateKey();
}

// correlate the (rotated) chroma against each key profile, accumulate votes, pick the long-run winner
function estimateKey() {
  const corr = (r, p) => {
    let sx=0, sy=0, sxx=0, syy=0, sxy=0;
    for (let k = 0; k < 12; k++) { const x = audio.chroma[(k + r) % 12]; const y = p[k]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const num = 12 * sxy - sx * sy; const den = Math.sqrt(Math.max(0, (12 * sxx - sx * sx)) * (12 * syy - sy * sy));
    return den ? num / den : 0;
  };
  let best = -2, bk = 0, bm = 0;
  for (let r = 0; r < 12; r++) { const mj = corr(r, KEY_MAJ); if (mj > best) { best = mj; bk = r; bm = 0; } const mn = corr(r, KEY_MIN); if (mn > best) { best = mn; bk = r; bm = 1; } }
  for (let k = 0; k < 24; k++) keyVotes[k] *= 0.985;          // slow decay → a stable long-run key
  if (best > 0) keyVotes[bk + (bm ? 12 : 0)] += best;
  let mv = -1, mi = 0; for (let k = 0; k < 24; k++) if (keyVotes[k] > mv) mv = keyVotes[mi = k];
  if (mv > 1.0) { audio.key.pc = mi % 12; audio.key.mode = mi >= 12 ? 'minor' : 'major'; audio.key.name = KEY_NAMES[audio.key.pc] + (audio.key.mode === 'minor' ? 'm' : ''); }
}
