// WebGL2 rendering infrastructure: context acquisition, shader program builds, the
// fullscreen-quad VAO, ping-pong + bloom framebuffer targets, resize/quality, and the
// FFT spectrum ring texture. Lifted verbatim from the former monolith; the target
// formats (RGBA8, R8), filters (LINEAR/CLAMP_TO_EDGE, REPEAT on the spectrum S axis),
// half-res bloom, DPR-cap quality logic, and resize re-alloc path are unchanged.
//
// Self-contained: evaluates at import time and THROWS on failure (no WebGL2, or a
// shader compile/link error). The thrown Error.message propagates to main.js's
// window.onerror -> fatal() handler, which surfaces it in the #err overlay. main.js's
// gl.* / targets.* / programs.* render calls are byte-unchanged.
import vsSrc from './shaders/quad.vert';
import fsScene from './shaders/scene.frag';
import fsCopy from './shaders/copy.frag';
import fsBright from './shaders/bright.frag';
import fsBlur from './shaders/blur.frag';
import { state } from './state.js';

// Surfaces a boot-time GL failure in the #err overlay BEFORE throwing. The throws below
// fire at module-evaluation time — before main.js registers window.onerror — so without
// this the overlay never shows and the user sees only a blank page. Self-contained on
// purpose: no ui.js import (gl.js is the lower layer; #err is already in the DOM when
// this module evaluates, since the module script sits at the end of <body>).
function showFatal(msg) {
  const e = document.getElementById('err');
  if (e) { e.style.display = 'block'; e.textContent = '⚠ ' + msg; }
  console.error(msg);
}

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gl'));
export const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
if (!gl) { showFatal('WebGL2 is not available. Try Safari or Chrome on Apple Silicon.'); throw new Error('no webgl2'); }

// quality presets: DPR cap + raymarch step count (Low / Med / High)
export const QUAL = [
  { dpr: 1.0, rmSteps: 48 },
  { dpr: 1.5, rmSteps: 80 },
  { dpr: 2.0, rmSteps: 120 },
];

// FFT spectrum ring texture (256 bins, R8). specData is mutated each frame by main.js
// (specData[i] = audio.freq[i]) and uploaded into specTex.
export const NBINS = 256;
export const specData = new Uint8Array(NBINS);

let qual = QUAL[state.qualIdx]; // internal: active preset (mutated by setQuality)

// --- shader compile + link helpers ---
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src.trim());
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile error:\n' + gl.getShaderInfoLog(s));
  return s;
}

/**
 * Compile + link a vertex/fragment pair into a WebGLProgram; binds attribute 0 to
 * `a_pos`. Throws 'Shader compile error:\n...' / 'Link error:\n...' on failure (the
 * message reaches main.js's fatal() via window.onerror). Used at load and by
 * rebuildSceneProgram for the user-shader scene.
 * @param {string} vs - vertex shader source
 * @param {string} fs - fragment shader source
 * @returns {WebGLProgram}
 */
export function makeProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error:\n' + gl.getProgramInfoLog(p));
  return p;
}

// --- fullscreen-quad VAO (one oversized triangle covering clip space) ---
export const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

// --- FFT spectrum ring texture (R8, 256x1, REPEAT on S so the ring wraps seamlessly) ---
export const specTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, specTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, NBINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(NBINS));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

/**
 * The four shader programs. `scene` is replaced wholesale by rebuildSceneProgram() when
 * the user compiles a custom shader; copy/bright/blur are immutable after load.
 * @type {{ scene: WebGLProgram, copy: WebGLProgram, bright: WebGLProgram, blur: WebGLProgram }}
 */
export const programs = (() => {
  try {
    return {
      scene: makeProgram(vsSrc, fsScene),
      copy: makeProgram(vsSrc, fsCopy),
      bright: makeProgram(vsSrc, fsBright),
      blur: makeProgram(vsSrc, fsBlur),
    };
  } catch (e) { showFatal(e.message); throw e; }
})();

/**
 * Allocate an RGBA8 color render target (LINEAR / CLAMP_TO_EDGE) with a matching framebuffer.
 * @param {number} w
 * @param {number} h
 * @returns {{ tex: WebGLTexture, fbo: WebGLFramebuffer }}
 */
export function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo };
}

/**
 * Ping-pong + bloom framebuffer set + current drawing dimensions. Const object; its
 * texture/fbo fields are re-allocated by resize()/setQuality(), and W/H/BW/BH updated
 * each re-alloc. main.js reads targets.* each frame and swaps texA/texB, fboA/fboB in place.
 * @type {{
 *   texA: WebGLTexture | null, texB: WebGLTexture | null,
 *   fboA: WebGLFramebuffer | null, fboB: WebGLFramebuffer | null,
 *   bloomTexA: WebGLTexture | null, bloomTexB: WebGLTexture | null,
 *   bloomFboA: WebGLFramebuffer | null, bloomFboB: WebGLFramebuffer | null,
 *   W: number, H: number, BW: number, BH: number,
 * }}
 */
export const targets = {
  texA: null,
  texB: null,
  fboA: null,
  fboB: null,
  bloomTexA: null,
  bloomTexB: null,
  bloomFboA: null,
  bloomFboB: null,
  W: 0,
  H: 0,
  BW: 0,
  BH: 0,
};

/** Re-allocate the ping-pong + bloom targets at the current state.qualIdx DPR cap. No-op if the size is unchanged. */
export function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, qual.dpr);
  const w = Math.floor(window.innerWidth * dpr),
    h = Math.floor(window.innerHeight * dpr);
  if (w === targets.W && h === targets.H) return;
  targets.W = w;
  targets.H = h;
  canvas.width = w;
  canvas.height = h;
  const a = makeTarget(w, h),
    b = makeTarget(w, h);
  targets.texA = a.tex;
  targets.fboA = a.fbo;
  targets.texB = b.tex;
  targets.fboB = b.fbo;
  targets.BW = Math.max(1, Math.floor(w / 2));
  targets.BH = Math.max(1, Math.floor(h / 2)); // bloom at half resolution
  const ba = makeTarget(targets.BW, targets.BH),
    bb = makeTarget(targets.BW, targets.BH);
  targets.bloomTexA = ba.tex;
  targets.bloomFboA = ba.fbo;
  targets.bloomTexB = bb.tex;
  targets.bloomFboB = bb.fbo;
  for (const f of [targets.fboA, targets.fboB, targets.bloomFboA, targets.bloomFboB]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

/**
 * Switch quality preset: writes state.qualIdx, persists it, and forces a target re-alloc
 * at the new DPR cap. (The segmented-control highlight is main.js's responsibility.)
 * @param {number} i
 */
export function setQuality(i) {
  state.qualIdx = i;
  qual = QUAL[i];
  localStorage.setItem('resomance_quality', String(i));
  targets.W = 0;
  targets.H = 0; // force re-alloc of render targets at the new DPR
  resize();
}

/**
 * Replace the scene program with one built from `fsSrc` (used by main.js's user-shader
 * compiler). Builds the new program FIRST and only deletes the old one on success, so a
 * compile failure leaves the previous scene program intact and rendering (matches the
 * original compileUserShader ordering).
 * @param {string} fs - scene fragment source (with the USER_SHADER block substituted in)
 */
export function rebuildSceneProgram(fs) {
  const p = makeProgram(vsSrc, fs);
  gl.deleteProgram(programs.scene);
  programs.scene = p;
}

/** @returns {{ dpr: number, rmSteps: number }} the active quality preset (rmSteps read by main.js each frame) */
export function getQual() {
  return qual;
}

// Re-export the scene fragment source so main.js's user-shader compiler can string-replace
// the USER_SHADER block before calling rebuildSceneProgram. Only gl.js imports shaders.
export { fsScene };

// initial target allocation at the current quality / DPR cap
resize();
