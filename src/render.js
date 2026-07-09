// Render pipeline: the scene uniform-location cache, the per-frame draw (spectrum upload
// → scene pass → bright-pass → separable blur → composite → ping-pong swap), the in-frame
// screenshot capture, and the user-shader compiler. Lifted verbatim from the former
// monolith's frame() draw block + buildSceneU + compileUserShader; uniform uploads, the
// reactivity-router modulation clamps (feedback 0..0.97, swirl 0..0.02, glow 0..0.3), bloom
// thresholds/amounts, post-FX (vignette/chroma/grain), reduced-motion scaling, the
// ping-pong swap, and the screenshot PNG download are unchanged. main.js keeps the frame
// orchestration (timing, auto-mix, BPM, paletteShift, shock) and passes the per-frame
// dynamic values into renderFrame(); config (look/router/customPal/curStyle/reducedMotion/
// ringOn) and the live audio namespace are read here each frame.
import { gl, vao, targets, programs, specTex, specData, NBINS, getQual, rebuildSceneProgram, fsScene } from './gl.js';
import { audio } from './audio.js';
import { state, emit } from './state.js';

function uni(p, n) { return gl.getUniformLocation(p, n); }
function buildSceneU(p) {
  return {
    res: uni(p, 'u_res'), time: uni(p, 'u_time'),
    bass: uni(p, 'u_bass'), mid: uni(p, 'u_mid'),
    treble: uni(p, 'u_treble'), level: uni(p, 'u_level'),
    centroid: uni(p, 'u_centroid'), beat: uni(p, 'u_beat'), shock: uni(p, 'u_shock'),
    beatPhase: uni(p, 'u_beatPhase'),
    snare: uni(p, 'u_snare'), hat: uni(p, 'u_hat'),
    style: uni(p, 'u_style'), modeA: uni(p, 'u_modeA'), modeB: uni(p, 'u_modeB'), blend: uni(p, 'u_blend'),
    camYaw: uni(p, 'u_camYaw'), camPitch: uni(p, 'u_camPitch'), orbit: uni(p, 'u_orbit'), zoom: uni(p, 'u_zoom'),
    specOn: uni(p, 'u_specOn'), prev: uni(p, 'u_prev'), spec: uni(p, 'u_spec'),
    reducedMotion: uni(p, 'u_reducedMotion'),
    feedback: uni(p, 'u_feedback'), swirl: uni(p, 'u_swirl'), glow: uni(p, 'u_glow'),
    rmSteps: uni(p, 'u_rmSteps'),
    pa: uni(p, 'u_pa'), pb: uni(p, 'u_pb'), pc: uni(p, 'u_pc'), pd: uni(p, 'u_pd'),
    paletteShift: uni(p, 'u_paletteShift'),
  };
}

// Uniform-location caches. Populated by initRender() (and U rebuilt by compileUserShader).
// Declared `let x = null` so they typecheck loosely under checkJs; accessed only after
// initRender() has run (main.js calls it at boot before the first frame).
let U = null;             // scene pass uniforms (rebuilt whenever programs.scene is recompiled)
let UC = null;            // copy / composite pass uniforms
let UB = null;            // bright-pass uniforms
let UBL = null;           // separable blur uniforms

let pendingShot = false;  // screenshot queued by requestScreenshot(), captured at end of the next renderFrame

/**
 * Build the uniform-location caches for the scene/copy/bright/blur programs, then recompile
 * a saved user shader (localStorage 'resomance_usershader') if one exists so the saved
 * shader is active on load (matches the original). Must be called once at boot after gl.js.
 */
export function initRender() {
  U = buildSceneU(programs.scene);
  UC = { tex: uni(programs.copy, 'u_tex'), bloom: uni(programs.copy, 'u_bloom'), res: uni(programs.copy, 'u_res'), bloomAmt: uni(programs.copy, 'u_bloomAmt'), vig: uni(programs.copy, 'u_vig'), ca: uni(programs.copy, 'u_ca'), grain: uni(programs.copy, 'u_grain'), beat: uni(programs.copy, 'u_beat'), time: uni(programs.copy, 'u_time') };
  UB = { tex: uni(programs.bright, 'u_tex'), res: uni(programs.bright, 'u_res'), thresh: uni(programs.bright, 'u_thresh') };
  UBL = { tex: uni(programs.blur, 'u_tex'), res: uni(programs.blur, 'u_res'), dir: uni(programs.blur, 'u_dir') };
  const saved = localStorage.getItem('resomance_usershader');
  if (saved) compileUserShader(saved);
}

/**
 * @typedef {Object} RenderParams
 * @property {number} time - seconds since boot (t0)
 * @property {number} beatPhase - bar-length beat-grid phase [0..1) locked to BPM (downbeat at 0)
 * @property {number} modeA - source scene index of the crossfade
 * @property {number} modeB - destination scene index of the crossfade
 * @property {number} blend - crossfade amount [0..1]
 * @property {number} paletteShift - beat-aware palette phase (0 when beat-shift is off)
 * @property {number} shock - shockwave origin timestamp (shockStart); the envelope is computed here
 * @property {number} camYaw - orbit camera yaw
 * @property {number} camPitch - orbit camera pitch
 * @property {number} camZoom - orbit camera zoom
 * @property {boolean} orbitActive - whether the user is orbiting (else auto camera)
 */

/**
 * Run one render frame in the original order: spectrum upload → scene pass into fboB →
 * bright-pass into bloomFboA → two-pass separable blur between bloomFboA/bloomFboB →
 * composite to screen → optional screenshot capture → ping-pong swap. Audio comes from the
 * `audio` namespace, config from `state`, per-frame dynamics from `params`.
 * @param {RenderParams} params
 */
export function renderFrame(params) {
  const time = params.time;
  const reducedMotion = state.reducedMotion;
  const look = state.look;
  const router = state.router;
  const customPal = state.customPal;

  // upload spectrum (first NBINS of the FFT — copy used to live in main.js right after analyze)
  if (audio.freq) { for (let i = 0; i < NBINS; i++) specData[i] = audio.freq[i]; }
  gl.bindTexture(gl.TEXTURE_2D, specTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NBINS, 1, gl.RED, gl.UNSIGNED_BYTE, specData);

  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fboB);
  gl.viewport(0, 0, targets.W, targets.H);
  gl.useProgram(programs.scene); gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.texA);
  gl.uniform1i(U.prev, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, specTex);
  gl.uniform1i(U.spec, 1);
  gl.uniform2f(U.res, targets.W, targets.H); gl.uniform1f(U.time, time);
  gl.uniform1f(U.bass, audio.bands.bass); gl.uniform1f(U.mid, audio.bands.mid);
  gl.uniform1f(U.treble, audio.bands.treble); gl.uniform1f(U.level, audio.bands.level);
  gl.uniform1f(U.centroid, audio.bands.centroid); gl.uniform1f(U.beat, reducedMotion ? audio.beat * 0.2 : audio.beat);
  gl.uniform1f(U.beatPhase, params.beatPhase);
  gl.uniform1f(U.shock, reducedMotion ? Math.min(1, (time - params.shock) / 0.6) * 0.15 : Math.min(1, (time - params.shock) / 0.6));
  gl.uniform1f(U.snare, reducedMotion ? audio.snare * 0.2 : audio.snare); gl.uniform1f(U.hat, reducedMotion ? audio.hat * 0.2 : audio.hat);
  gl.uniform1f(U.paletteShift, params.paletteShift);
  gl.uniform1f(U.style, state.curStyle); gl.uniform1f(U.modeA, params.modeA); gl.uniform1f(U.modeB, params.modeB); gl.uniform1f(U.blend, params.blend);
  gl.uniform1f(U.camYaw, params.camYaw); gl.uniform1f(U.camPitch, params.camPitch); gl.uniform1f(U.orbit, params.orbitActive ? 1 : 0); gl.uniform1f(U.zoom, params.camZoom);
  gl.uniform1f(U.specOn, state.ringOn ? 1 : 0);
  gl.uniform1f(U.reducedMotion, reducedMotion ? 1 : 0);
  // reactivity router: add onset-driven modulation to the look params (clamped to each slider's range)
  let rSw = 0, rGl = 0, rFb = 0; const rv = { kick: audio.beat, snare: audio.snare, hat: audio.hat, bass: audio.bands.bass };
  for (const s in router) { const v = rv[s] || 0; if (router[s] === 'swirl') rSw += v; else if (router[s] === 'glow') rGl += v; else if (router[s] === 'feedback') rFb += v; }
  gl.uniform1f(U.feedback, Math.max(0, Math.min(0.97, look.feedback + rFb * 0.04))); gl.uniform1f(U.swirl, Math.max(0, Math.min(0.02, look.swirl + rSw * 0.008))); gl.uniform1f(U.glow, Math.max(0, Math.min(0.3, look.glow + rGl * 0.12)));
  gl.uniform1i(U.rmSteps, getQual().rmSteps);
  gl.uniform3f(U.pa, customPal.a[0], customPal.a[1], customPal.a[2]); gl.uniform3f(U.pb, customPal.b[0], customPal.b[1], customPal.b[2]);
  gl.uniform3f(U.pc, customPal.c[0], customPal.c[1], customPal.c[2]); gl.uniform3f(U.pd, customPal.d[0], customPal.d[1], customPal.d[2]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- bloom: bright-pass into a half-res buffer ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFboA);
  gl.viewport(0, 0, targets.BW, targets.BH);
  gl.useProgram(programs.bright);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.texB);
  gl.uniform1i(UB.tex, 0); gl.uniform2f(UB.res, targets.W, targets.H); gl.uniform1f(UB.thresh, 0.6);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // --- bloom: separable 9-tap Gaussian, two horizontal/vertical rounds ---
  gl.useProgram(programs.blur);
  for (let pass = 0; pass < 2; pass++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFboB);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.bloomTexA);
    gl.uniform1i(UBL.tex, 0); gl.uniform2f(UBL.res, targets.BW, targets.BH); gl.uniform2f(UBL.dir, 1.0 / Math.max(1, targets.BW), 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFboA);
    gl.bindTexture(gl.TEXTURE_2D, targets.bloomTexB);
    gl.uniform2f(UBL.dir, 0.0, 1.0 / Math.max(1, targets.BH));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // --- composite: scene + blurred bloom, tonemapped to screen (intensified on beats) ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, targets.W, targets.H);
  gl.useProgram(programs.copy);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.texB);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, targets.bloomTexA);
  gl.uniform1i(UC.tex, 0); gl.uniform1i(UC.bloom, 1); gl.uniform2f(UC.res, targets.W, targets.H);
  gl.uniform1f(UC.bloomAmt, 0.45 + (reducedMotion ? audio.beat * 0.2 : audio.beat * 1.1));
  gl.uniform1f(UC.vig, look.vig); gl.uniform1f(UC.ca, look.ca); gl.uniform1f(UC.grain, look.grain); gl.uniform1f(UC.beat, reducedMotion ? audio.beat * 0.2 : audio.beat); gl.uniform1f(UC.time, time);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (pendingShot) {
    pendingShot = false;   // capture right after the copy pass so the buffer is valid
    const cv = /** @type {HTMLCanvasElement} */ (document.getElementById('gl'));
    cv.toBlob(b => { if (!b) return; const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = 'resomance-' + Date.now() + '.png';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
    emit('transport', { type: 'toast', msg: 'screenshot saved' });
  }

  // ping-pong swap
  const t2 = targets.texA; targets.texA = targets.texB; targets.texB = t2; const f2 = targets.fboA; targets.fboA = targets.fboB; targets.fboB = f2;
}

/** Queue a screenshot capture at the end of the next renderFrame (after the composite pass, while the drawing buffer is still valid — the context is preserveDrawingBuffer:false). */
export function requestScreenshot() { pendingShot = true; }

/**
 * Compile a user-supplied scene body into the scene program. On success the scene program is
 * rebuilt, the scene uniform cache U is rebuilt, and the code is persisted to localStorage;
 * on failure the error is logged and returned. The caller (main.js) renders the {ok,error}
 * result into the shader-panel UI. The program is built BEFORE the old one is deleted, so a
 * compile failure leaves the previous scene program intact and rendering (rebuildSceneProgram).
 * @param {string} code
 * @returns {{ ok: boolean, error?: string }}
 */
export function compileUserShader(code) {
  const src = fsScene.replace(/\/\/ USER_SHADER_BEGIN[\s\S]*?\/\/ USER_SHADER_END/, '// USER_SHADER_BEGIN\n' + code + '\n  // USER_SHADER_END');
  try {
    rebuildSceneProgram(src); U = buildSceneU(programs.scene);
    localStorage.setItem('resomance_usershader', code);
    return { ok: true };
  } catch (e) {
    console.error('user shader error:\n' + e.message);
    return { ok: false, error: e.message };
  }
}
