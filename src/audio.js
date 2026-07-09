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
 * }}
 */
export const audio = {
  ctx: null,        // AudioContext (set by ensureCtx)
  analyser: null,   // AnalyserNode (set by ensureCtx)
  master: null,     // GainNode master volume (set by ensureCtx)
  freq: null,       // Uint8Array(frequencyBinCount) — raw FFT, read by main.js for the spectrum ring texture
  bands: { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0 },  // mutated by analyze()
  beat: 0, snare: 0, hat: 0,   // onset impulses, mutated by analyze()
};

// internal-only analysis state (not exported)
/** @type {Uint8Array | null} */
let freqPrev = null;
let kickFlux = 0.0001, snareFlux = 0.0001, hatFlux = 0.0001;   // adaptive onset thresholds
let loudEMA = 0.1;   // rolling loudness estimate for auto-gain

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
  const bassEnd = Math.floor(n * 0.06), midEnd = Math.floor(n * 0.30);
  if (!freqPrev || freqPrev.length !== n) freqPrev = new Uint8Array(n);
  let b = 0, m = 0, tr = 0, sum = 0, wsum = 0, total = 0;
  let kickF = 0, snareF = 0, hatF = 0;   // spectral flux per band (positive bin deltas)
  for (let i = 0; i < n; i++) {
    const v = freq[i] / 255; sum += v; total += v; wsum += v * i;
    const d = freq[i] - freqPrev[i];
    if (i < bassEnd) { b += v; if (d > 0) kickF += d; }
    else if (i < midEnd) { m += v; if (d > 0) snareF += d; }
    else { tr += v; if (d > 0) hatF += d; }
  }
  audio.bands.bass = b / Math.max(1, bassEnd);
  audio.bands.mid = m / Math.max(1, midEnd - bassEnd);
  audio.bands.treble = tr / Math.max(1, n - midEnd);
  audio.bands.level = sum / n;
  audio.bands.centroid = total > 0 ? (wsum / total) / n : 0.5;
  // NOTE: the spectrum-texture copy (specData[i]=freq[i]) now lives in main.js's frame
  // loop, right after analyze() — specData/NBINS are render-layer state that stays here.
  freqPrev.set(freq);

  // spectral-flux onset detection per band (kick/snare/hat) with adaptive thresholds
  kickF /= 255 * Math.max(1, bassEnd); snareF /= 255 * Math.max(1, midEnd - bassEnd); hatF /= 255 * Math.max(1, n - midEnd);
  // auto-gain: normalize bass/mid/treble (and onset flux) against a rolling loudness estimate so quiet and loud tracks react at full range
  loudEMA = loudEMA * 0.99 + audio.bands.level * 0.01;
  const ag = state.autoGainOn ? Math.max(0.6, Math.min(5, 0.4 / (loudEMA + 0.03))) : 1;
  audio.bands.bass = Math.min(1.5, audio.bands.bass * ag); audio.bands.mid = Math.min(1.5, audio.bands.mid * ag); audio.bands.treble = Math.min(1.5, audio.bands.treble * ag); audio.bands.level = Math.min(1.5, audio.bands.level * ag);
  kickF *= ag; snareF *= ag; hatF *= ag;
  kickFlux = kickFlux * 0.94 + kickF * 0.06; snareFlux = snareFlux * 0.94 + snareF * 0.06; hatFlux = hatFlux * 0.94 + hatF * 0.06;
  if (kickF > kickFlux * 1.6 && kickF > 0.020) audio.beat = 1.0;   // kick drives the existing u_beat
  if (snareF > snareFlux * 1.6 && snareF > 0.015) audio.snare = 1.0;
  if (hatF > hatFlux * 1.7 && hatF > 0.010) audio.hat = 1.0;
  audio.beat *= 0.90; audio.snare *= 0.88; audio.hat *= 0.84;
}
