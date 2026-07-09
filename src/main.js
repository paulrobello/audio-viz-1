// @ts-nocheck — Transitional monolith: this file is the un-refactored original app
// script, relocated verbatim from index.html. checkJs stays ON in jsconfig.json so the
// modules split out in later tasks (audio/playback/gl/render/camera/ui/controls) ARE
// type-checked; this per-file opt-out exists only until the code below is decomposed.
// Removed by Task 10, when main.js is a small, fully-typed boot + frame-loop file.
import './styles.css';
import vsSrc from './shaders/quad.vert';
import fsScene from './shaders/scene.frag';
import fsCopy from './shaders/copy.frag';
import fsBright from './shaders/bright.frag';
import fsBlur from './shaders/blur.frag';
import { state } from './state.js';
import { audio, ensureCtx, analyze } from './audio.js';
import { idbGetQueue, idbSaveQueue, idbSavePos, idbGetPos, idbGetAudio } from './storage.js';
const errEl = document.getElementById('err');
function fatal(msg){ errEl.style.display='block'; errEl.textContent = '⚠ '+msg; console.error(msg); }
window.addEventListener('error', e => fatal((e.message||'error')+(e.filename?('\n'+e.filename+':'+e.lineno):'')));

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias:false, alpha:false });
if(!gl){ fatal('WebGL2 is not available. Try Safari or Chrome on Apple Silicon.'); throw new Error('no webgl2'); }

function compile(type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src.trim()); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile error:\n'+gl.getShaderInfoLog(s));
  return s;
}
function program(vsSrc, fsSrc){
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error:\n'+gl.getProgramInfoLog(p));
  return p;
}
let progScene, progCopy, progBright, progBlur;
try {
  progScene = program(vsSrc, fsScene);
  progCopy  = program(vsSrc, fsCopy);
  progBright = program(vsSrc, fsBright);
  progBlur   = program(vsSrc, fsBlur);
} catch(e){ fatal(e.message); throw e; }

const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

// ping-pong framebuffers (scene feedback + half-res bloom buffers)
let texA, texB, fboA, fboB, bloomTexA, bloomTexB, bloomFboA, bloomFboB, BW=0, BH=0;
function makeTarget(w,h){
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
let W=0, H=0;
// quality presets: DPR cap + raymarch step count (Low / Med / High)
const QUAL=[ {dpr:1.0, rmSteps:48}, {dpr:1.5, rmSteps:80}, {dpr:2.0, rmSteps:120} ];
let qualIdx = state.qualIdx;
let qual = QUAL[qualIdx];
function resize(){
  const dpr = Math.min(window.devicePixelRatio || 1, qual.dpr);
  const w = Math.floor(window.innerWidth*dpr), h = Math.floor(window.innerHeight*dpr);
  if(w===W && h===H) return;
  W=w; H=h; canvas.width=w; canvas.height=h;
  const a=makeTarget(w,h), b=makeTarget(w,h);
  texA=a.tex; fboA=a.fbo; texB=b.tex; fboB=b.fbo;
  BW=Math.max(1,Math.floor(w/2)); BH=Math.max(1,Math.floor(h/2));   // bloom at half resolution
  const ba=makeTarget(BW,BH), bb=makeTarget(BW,BH);
  bloomTexA=ba.tex; bloomFboA=ba.fbo; bloomTexB=bb.tex; bloomFboB=bb.fbo;
  for(const f of [fboA,fboB,bloomFboA,bloomFboB]){ gl.bindFramebuffer(gl.FRAMEBUFFER,f); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
}
window.addEventListener('resize', resize); resize();

// FFT spectrum texture (256 bins, R8)
const NBINS = 256;
const specTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, specTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, NBINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(NBINS));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
let specData = new Uint8Array(NBINS);

function uni(p,n){ return gl.getUniformLocation(p,n); }
function buildSceneU(p){
  return {
    res:uni(p,'u_res'), time:uni(p,'u_time'),
    bass:uni(p,'u_bass'), mid:uni(p,'u_mid'),
    treble:uni(p,'u_treble'), level:uni(p,'u_level'),
    centroid:uni(p,'u_centroid'), beat:uni(p,'u_beat'), shock:uni(p,'u_shock'),
    snare:uni(p,'u_snare'), hat:uni(p,'u_hat'),
    style:uni(p,'u_style'), modeA:uni(p,'u_modeA'), modeB:uni(p,'u_modeB'), blend:uni(p,'u_blend'),
    camYaw:uni(p,'u_camYaw'), camPitch:uni(p,'u_camPitch'), orbit:uni(p,'u_orbit'), zoom:uni(p,'u_zoom'),
    specOn:uni(p,'u_specOn'), prev:uni(p,'u_prev'), spec:uni(p,'u_spec'),
    reducedMotion:uni(p,'u_reducedMotion'),
    feedback:uni(p,'u_feedback'), swirl:uni(p,'u_swirl'), glow:uni(p,'u_glow'),
    rmSteps:uni(p,'u_rmSteps'),
    pa:uni(p,'u_pa'), pb:uni(p,'u_pb'), pc:uni(p,'u_pc'), pd:uni(p,'u_pd'),
    paletteShift:uni(p,'u_paletteShift'),
  };
}
let U = buildSceneU(progScene);   // rebuilt (buildSceneU) whenever the scene program is recompiled for a user shader
const UC = { tex:uni(progCopy,'u_tex'), bloom:uni(progCopy,'u_bloom'), res:uni(progCopy,'u_res'), bloomAmt:uni(progCopy,'u_bloomAmt'), vig:uni(progCopy,'u_vig'), ca:uni(progCopy,'u_ca'), grain:uni(progCopy,'u_grain'), beat:uni(progCopy,'u_beat'), time:uni(progCopy,'u_time') };
const UB = { tex:uni(progBright,'u_tex'), res:uni(progBright,'u_res'), thresh:uni(progBright,'u_thresh') };
const UBL = { tex:uni(progBlur,'u_tex'), res:uni(progBlur,'u_res'), dir:uni(progBlur,'u_dir') };

// ---------- AUDIO ----------
let srcNode=null, demoNodes=null, playing=true, isDemo=false;
let urlAudio=null, urlMes=null;   // <audio> + MediaElementSource for URL / live-stream playback
let curBuffer=null, startCtxTime=0, trackDur=0, seeking=false;   // file transport / seek state
let playlist=[], curIdx=-1, loadToken=0, decodeFails=0;   // queue for multi-file / folder loads
let repeatMode = state.repeatMode;   // 0=off, 1=all (default preserves the looping queue), 2=one
let shuffleOn = state.shuffleOn;

// ---- persist the full playlist queue + position across reloads (IndexedDB impls live in storage.js) ----
let pendingRestore=null;   // {files, idx, pos} restored on first gesture
function setTrackName(name){ document.getElementById('sub').textContent=name; }
function currentElapsed(){ if(!curBuffer||!audio.ctx) return 0; return Math.max(0,(audio.ctx.currentTime-startCtxTime)%trackDur); }
function saveQueuePos(pos){ if(playlist.length<1||curIdx<0) return; idbSavePos({idx:curIdx, pos:(pos!=null?pos:currentElapsed())}); }
// restore on load (no autoplay — browsers block audio without a gesture; resumes on first click)
(async function(){
  const q=await idbGetQueue();
  if(q&&q.length){ const p=await idbGetPos(); const idx=(p&&p.idx>=0&&p.idx<q.length)?p.idx:0; pendingRestore={files:q, idx, pos:(p&&p.pos)||0}; setTrackName((q[idx].name||'track')+'  ·  click to resume'); return; }
  const rec=await idbGetAudio();   // legacy single-track cache
  if(rec&&rec.blob){ const f=new File([rec.blob], rec.name||'track', {type:rec.type||'audio/*'}); pendingRestore={files:[f], idx:0, pos:0}; setTrackName(f.name+'  ·  click to resume'); }
})();
setInterval(()=>saveQueuePos(), 5000);   // checkpoint playback position periodically
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') saveQueuePos(); });
window.addEventListener('beforeunload', saveQueuePos);

function stopSources(){
  if(srcNode){ srcNode.onended=null; try{srcNode.stop();}catch(e){} try{srcNode.disconnect();}catch(e){} srcNode=null; }
  if(demoNodes){ demoNodes.forEach(n=>{ try{n.stop&&n.stop();}catch(e){} try{n.disconnect();}catch(e){} }); demoNodes=null; }
  if(urlAudio){ try{urlAudio.pause();}catch(e){} try{urlMes.disconnect();}catch(e){} urlAudio=null; urlMes=null; }
  isDemo=false;
}

function playFile(file, offset){
  ensureCtx(); stopSources();
  const tok=++loadToken;   // guard against out-of-order decode completion during rapid skips
  const reader = new FileReader();
  reader.onload = () => {
    audio.ctx.decodeAudioData(reader.result.slice(0)).then(buf=>{
      if(tok!==loadToken) return;   // a newer load superseded this one
      decodeFails=0;
      curBuffer=buf; trackDur=buf.duration;
      const off=Math.max(0,Math.min(offset||0, trackDur*0.999));   // resume offset (clamped) for queue restore / seek
      startCtxTime=audio.ctx.currentTime-off;
      srcNode = audio.ctx.createBufferSource();
      srcNode.buffer = buf; srcNode.loop = playlist.length<=1 || repeatMode===2;   // single file or repeat-one loops the buffer; a queue auto-advances
      srcNode.connect(audio.analyser);
      srcNode.onended = ()=>{ if(playlist.length>1) onTrackEnd(); };   // natural end only — manual stops null the handler first (loop=true suppresses it)
      srcNode.start(0, off); playing=true; isDemo=false; updatePlayBtn();
      setTrackName(file.name);
      showSeek(true);
    }).catch(e=>{
      if(tok!==loadToken) return;
      toast('could not read '+file.name);
      if(playlist.length>1 && ++decodeFails<playlist.length) nextTrack();   // skip a bad file within a queue (bounded)
      else fatal('Could not decode audio: '+e.message);
    });
  };
  reader.readAsArrayBuffer(file);
}
// ---------- URL / stream source (<audio> + MediaElementSource into the analyser) ----------
function playUrl(url){
  ensureCtx(); stopSources();
  try{
    const audioEl=new Audio();
    audioEl.crossOrigin='anonymous';   // required so the analyser can read the stream (CORS-enabled sources only)
    audioEl.src=url; audioEl.loop=true;   // loop finite URLs; live streams ignore loop
    urlMes=audio.ctx.createMediaElementSource(audioEl); urlMes.connect(audio.analyser);
    urlAudio=audioEl; playlist=[]; curIdx=-1; curBuffer=null; trackDur=0;
    audioEl.play().then(()=>{ playing=true; isDemo=false; updatePlayBtn(); setTrackName(url.length>52?url.slice(0,52)+'…':url); showSeek(false); updateTrackCounter(); })
      .catch(()=>{ toast('could not play URL'); stopSources(); });
  }catch(e){ toast('could not play URL'); }
}
// ---------- playlist queue (multi-file / folder) ----------
function isAudio(f){ return f && (f.type.startsWith('audio') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|aif[f]?)$/i.test(f.name)); }
function loadFiles(files, idx, offset, skipSave){
  const aud=[...files].filter(isAudio);
  if(!aud.length) return;
  playlist=aud;
  if(!skipSave) idbSaveQueue(aud);   // persist the full queue so a dropped folder survives a refresh
  playIndex(idx||0, offset||0);
}
function playIndex(i, offset){
  if(!playlist.length) return;
  curIdx=(i+playlist.length)%playlist.length;
  playFile(playlist[curIdx], offset||0); updateTrackCounter();
  saveQueuePos(offset||0);   // checkpoint the new track + its resume offset
}
function randIdx(){ let r; do{ r=Math.floor(Math.random()*playlist.length); }while(r===curIdx && playlist.length>1); return r; }   // shuffle: a different track than the current one
function nextTrack(){ if(playlist.length>1) playIndex(shuffleOn ? randIdx() : curIdx+1); }
function prevTrack(){ if(playlist.length>1) playIndex(curIdx-1); }
// natural end of a queue track: repeat-one loops via srcNode.loop, repeat-all advances, repeat-off stops after the last linear track
function onTrackEnd(){ if(playlist.length<=1) return;
  if(repeatMode===0 && !shuffleOn && curIdx===playlist.length-1){ stopSources(); playing=false; updatePlayBtn(); }
  else nextTrack(); }
// folder-drop traversal (webkitGetAsEntry) — flatten a directory tree into audio Files
function readDirEntries(dir){ return new Promise(res=>{ const rd=dir.createReader(); const all=[]; (function read(){ rd.readEntries(ents=>{ if(!ents.length) return res(all); all.push(...ents); read(); }, ()=>res(all)); })(); }); }
function entryToFile(entry){ return new Promise(res=>entry.file(f=>res(f),()=>res(null))); }
async function collectEntries(entries){ const out=[];
  async function walk(en){ if(en.isFile){ const f=await entryToFile(en); if(f) out.push(f); } else if(en.isDirectory){ for(const k of await readDirEntries(en)) await walk(k); } }
  for(const en of entries) await walk(en);
  return out.filter(isAudio); }

function startDemo(){
  ensureCtx(); stopSources();
  const mix = audio.ctx.createGain(); mix.gain.value = 0.0;
  mix.connect(audio.analyser);
  const oscs=[]; const roots=[55,82.4,110,164.8];
  roots.forEach((f,i)=>{
    const o=audio.ctx.createOscillator(); o.type=i%2?'sawtooth':'triangle';
    o.frequency.value=f; o.detune.value=(i-1.5)*8;
    const g=audio.ctx.createGain(); g.gain.value=0.18/(i+1);
    o.connect(g); g.connect(mix); o.start(); oscs.push(o);
  });
  const nb=audio.ctx.createBuffer(1,audio.ctx.sampleRate*2,audio.ctx.sampleRate);
  const nd=nb.getChannelData(0); for(let i=0;i<nd.length;i++) nd[i]=(Math.random()*2-1)*0.5;
  const noise=audio.ctx.createBufferSource(); noise.buffer=nb; noise.loop=true;
  const hp=audio.ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=6000;
  const ng=audio.ctx.createGain(); ng.gain.value=0.05;
  noise.connect(hp); hp.connect(ng); ng.connect(mix); noise.start();
  const lfo=audio.ctx.createOscillator(); lfo.frequency.value=2.0;
  const lfoG=audio.ctx.createGain(); lfoG.gain.value=0.5;
  const baseG=audio.ctx.createConstantSource(); baseG.offset.value=0.5;
  baseG.connect(mix.gain); lfo.connect(lfoG); lfoG.connect(mix.gain); lfo.start(); baseG.start();
  const arp=audio.ctx.createOscillator(); arp.type='square'; arp.frequency.value=440;
  const arpG=audio.ctx.createGain(); arpG.gain.value=0.0;
  arp.connect(arpG); arpG.connect(mix); arp.start();
  const scale=[220,277,330,440,554,659,880]; let step=0;
  const arpTimer=setInterval(()=>{
    if(!audio.ctx) return;
    arp.frequency.setTargetAtTime(scale[step%scale.length], audio.ctx.currentTime, 0.01);
    arpG.gain.setTargetAtTime(0.06, audio.ctx.currentTime, 0.01);
    arpG.gain.setTargetAtTime(0.0, audio.ctx.currentTime+0.12, 0.05);
    step++;
  },250);
  const sweep=audio.ctx.createBiquadFilter(); sweep.type='lowpass'; sweep.frequency.value=800;
  mix.disconnect(); mix.connect(sweep); sweep.connect(audio.analyser);
  const sweepLfo=audio.ctx.createOscillator(); sweepLfo.frequency.value=0.08;
  const sweepG=audio.ctx.createGain(); sweepG.gain.value=900;
  sweepLfo.connect(sweepG); sweepG.connect(sweep.frequency); sweepLfo.start();
  mix.gain.setTargetAtTime(0.9, audio.ctx.currentTime, 0.5);
  const timerKiller={ stop(){ clearInterval(arpTimer); }, disconnect(){} };
  demoNodes=[...oscs, noise, lfo, baseG, arp, sweepLfo, timerKiller];
  isDemo=true; playing=true; updatePlayBtn();
  curBuffer=null; showSeek(false);   // demo has no finite timeline
}

// ---------- RENDER ----------
// accessibility: respect OS reduced-motion (calm swirl, trails, and beat flashes)
let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e=> reducedMotion=e.matches);
let t0=performance.now(), lastUI=0, lastFrame=0, fpsEMA=0;
let bpm=0, paletteShift=0, prevBeat=0, shockStart=-10; const beatTimes=[];   // beat-aware palette shift + shockwave origin
let beatPulse=false;   // one-frame true when a new kick onset is detected (drives beat-synced auto-mix)
let pendingShot=false;   // screenshot queued by the S hotkey, captured at end of the next frame
// look controls (persisted): feedback trails, swirl, glow — defaults reproduce the original hardcoded look
let look = state.look;
// reactivity router: map onset sources (kick/snare/hat/bass) onto look params (swirl/glow/feedback)
let router = state.router;
// custom cosine-palette editor (a/b/c/d vectors), persisted
let customPal = state.customPal;
function v2h(v){ return '#'+v.map(x=>Math.max(0,Math.min(255,Math.round(x*255))).toString(16).padStart(2,'0')).join(''); }
function h2v(h){ return (h.replace('#','').match(/.{2}/g)||[]).map(x=>parseInt(x,16)/255); }
function syncColorInputs(){ const map={cpA:'a',cpB:'b',cpC:'c',cpD:'d'}; for(const id in map){ const el=document.getElementById(id); if(el) el.value=v2h(customPal[map[id]]); } }
function syncPalEditor(){ const w=document.getElementById('palEdit'); if(!w) return; w.style.display = curStyle===4?'flex':'none'; if(curStyle===4) syncColorInputs(); }
// persisted look settings (volume is persisted separately in its own handler)
let curMode = state.curMode;
// per-scene palette memory: each scene remembers its own palette index (0..4)
let scenePalette = state.scenePalette;
localStorage.setItem('resomance_scene_palette', JSON.stringify(scenePalette));   // normalize on-disk (pad to len 6), as before
let curStyle = scenePalette[curMode]||0;
let ringOn = state.ringOn;
let autoHide = state.autoHide;
// scene crossfade + auto-mix state (declared after curMode to avoid a TDZ on the modeA initializer)
const AUTO_MIX_INTERVAL=14, AUTO_MIX_DUR=0.7;
let modeA=curMode, modeB=curMode, blend=0;
let autoMixOn = state.autoMixOn;
let autoMixNext = autoMixOn ? AUTO_MIX_INTERVAL : 0, mixTrans=null, mixArmedAt=null;
function clockSec(){ return (performance.now()-t0)/1000; }
// orbit camera (drag) state for the raymarch scenes
let camYaw=0, camPitch=0, camZoom=1, orbitActive=false, dragging=false, lastDX=0, lastDY=0; const pointers=new Map(); let pinchDist0=0;
function frame(now){
  const time=(now-t0)/1000;
  const dt = lastFrame? now-lastFrame : 0; lastFrame=now;
  if(dt>0){ const inst=1000/dt; fpsEMA = fpsEMA? fpsEMA*0.9+inst*0.1 : inst; }
  analyze(); resize();
  if(audio.freq){ for(let i=0;i<NBINS;i++){ specData[i]=audio.freq[i]; } }   // first NBINS of spectrum for the ring (moved out of analyze with freq)
  beatPulse=false;
  // beat-aware palette rotation: estimate BPM from kick onsets, advance the phase shift with tempo + energy
  if(audio.beat>prevBeat+0.5){ beatPulse=true; beatTimes.push(time); shockStart=time; if(beatTimes.length>12) beatTimes.shift();
    if(beatTimes.length>=4){ const iv=[]; for(let i=1;i<beatTimes.length;i++) iv.push(beatTimes[i]-beatTimes[i-1]); iv.sort((a,b)=>a-b); const med=iv[Math.floor(iv.length/2)]; if(med>0.3&&med<2.0) bpm=Math.round(60/med); } }
  prevBeat=audio.beat;
  if(beatShiftOn) paletteShift += dt*0.001*((bpm||100)/60*0.10 + audio.bands.level*0.16);
  // auto-mix: arm at the interval, then fire the crossfade on the next beat (downbeat) so transitions feel musical
  if(autoMixOn){
    if(!mixTrans && mixArmedAt===null && time>=autoMixNext) mixArmedAt=time;   // arm: hold for the next beat
    if(!mixTrans && mixArmedAt!==null){
      const armWait = (bpm>=40&&bpm<=200) ? Math.min(3.0, 2.2*60/bpm) : 3.0;   // fire on a beat, or fall back after ~2 beats (3s if no BPM)
      if(beatPulse || time-mixArmedAt>=armWait){ const to=(curMode+1)%6; mixTrans={from:curMode,to,start:time}; modeA=curMode; modeB=to; mixArmedAt=null; } }
    if(mixTrans){ const k=Math.max(0,Math.min(1,(time-mixTrans.start)/AUTO_MIX_DUR)); blend=k;
      if(!mixTrans.palDone && k>=0.5){ mixTrans.palDone=true; applyScenePalette(mixTrans.to); }   // swap to the destination scene's palette at the crossfade midpoint
      if(k>=1){ curMode=mixTrans.to; modeA=modeB=curMode; blend=0; mixTrans=null; autoMixNext=time+AUTO_MIX_INTERVAL; applyModeUI(); } }
  }

  // upload spectrum
  gl.bindTexture(gl.TEXTURE_2D, specTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NBINS, 1, gl.RED, gl.UNSIGNED_BYTE, specData);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
  gl.viewport(0,0,W,H);
  gl.useProgram(progScene); gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.uniform1i(U.prev,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, specTex);
  gl.uniform1i(U.spec,1);
  gl.uniform2f(U.res,W,H); gl.uniform1f(U.time,time);
  gl.uniform1f(U.bass,audio.bands.bass); gl.uniform1f(U.mid,audio.bands.mid);
  gl.uniform1f(U.treble,audio.bands.treble); gl.uniform1f(U.level,audio.bands.level);
  gl.uniform1f(U.centroid,audio.bands.centroid); gl.uniform1f(U.beat, reducedMotion?audio.beat*0.2:audio.beat);
  gl.uniform1f(U.shock, reducedMotion?Math.min(1,(time-shockStart)/0.6)*0.15:Math.min(1,(time-shockStart)/0.6));
  gl.uniform1f(U.snare, reducedMotion?audio.snare*0.2:audio.snare); gl.uniform1f(U.hat, reducedMotion?audio.hat*0.2:audio.hat);
  gl.uniform1f(U.paletteShift, beatShiftOn?paletteShift:0);
  gl.uniform1f(U.style,curStyle); gl.uniform1f(U.modeA,modeA); gl.uniform1f(U.modeB,modeB); gl.uniform1f(U.blend,blend);
  gl.uniform1f(U.camYaw, camYaw); gl.uniform1f(U.camPitch, camPitch); gl.uniform1f(U.orbit, orbitActive?1:0); gl.uniform1f(U.zoom, camZoom);
  gl.uniform1f(U.specOn, ringOn?1:0);
  gl.uniform1f(U.reducedMotion, reducedMotion?1:0);
  // reactivity router: add onset-driven modulation to the look params (clamped to each slider's range)
  let rSw=0,rGl=0,rFb=0; const rv={kick:audio.beat,snare:audio.snare,hat:audio.hat,bass:audio.bands.bass};
  for(const s in router){ const v=rv[s]||0; if(router[s]==='swirl') rSw+=v; else if(router[s]==='glow') rGl+=v; else if(router[s]==='feedback') rFb+=v; }
  gl.uniform1f(U.feedback, Math.max(0,Math.min(0.97,look.feedback+rFb*0.04))); gl.uniform1f(U.swirl, Math.max(0,Math.min(0.02,look.swirl+rSw*0.008))); gl.uniform1f(U.glow, Math.max(0,Math.min(0.3,look.glow+rGl*0.12)));
  gl.uniform1i(U.rmSteps, qual.rmSteps);
  gl.uniform3f(U.pa, customPal.a[0],customPal.a[1],customPal.a[2]); gl.uniform3f(U.pb, customPal.b[0],customPal.b[1],customPal.b[2]);
  gl.uniform3f(U.pc, customPal.c[0],customPal.c[1],customPal.c[2]); gl.uniform3f(U.pd, customPal.d[0],customPal.d[1],customPal.d[2]);
  gl.drawArrays(gl.TRIANGLES,0,3);

  // --- bloom: bright-pass into a half-res buffer ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFboA);
  gl.viewport(0,0,BW,BH);
  gl.useProgram(progBright);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.uniform1i(UB.tex,0); gl.uniform2f(UB.res,W,H); gl.uniform1f(UB.thresh, 0.6);
  gl.drawArrays(gl.TRIANGLES,0,3);
  // --- bloom: separable 9-tap Gaussian, two horizontal/vertical rounds ---
  gl.useProgram(progBlur);
  for(let pass=0; pass<2; pass++){
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFboB);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bloomTexA);
    gl.uniform1i(UBL.tex,0); gl.uniform2f(UBL.res,BW,BH); gl.uniform2f(UBL.dir, 1.0/Math.max(1,BW), 0.0);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFboA);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexB);
    gl.uniform2f(UBL.dir, 0.0, 1.0/Math.max(1,BH));
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  // --- composite: scene + blurred bloom, tonemapped to screen (intensified on beats) ---
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,W,H);
  gl.useProgram(progCopy);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloomTexA);
  gl.uniform1i(UC.tex,0); gl.uniform1i(UC.bloom,1); gl.uniform2f(UC.res,W,H);
  gl.uniform1f(UC.bloomAmt, 0.45 + (reducedMotion?audio.beat*0.2:audio.beat*1.1));
  gl.uniform1f(UC.vig, look.vig); gl.uniform1f(UC.ca, look.ca); gl.uniform1f(UC.grain, look.grain); gl.uniform1f(UC.beat, reducedMotion?audio.beat*0.2:audio.beat); gl.uniform1f(UC.time, time);
  gl.drawArrays(gl.TRIANGLES,0,3);
  if(pendingShot){ pendingShot=false;   // capture right after the copy pass so the buffer is valid
    canvas.toBlob(b=>{ if(!b) return; const a=document.createElement('a');
      a.href=URL.createObjectURL(b); a.download='resomance-'+Date.now()+'.png';
      a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }, 'image/png');
    toast('screenshot saved'); }

  let t2=texA; texA=texB; texB=t2; let f2=fboA; fboA=fboB; fboB=f2;
  if(now-lastUI>50){ lastUI=now; updateMeters(); updateSeek(); if(showFps) fpsVal.textContent=Math.round(fpsEMA)+' fps'; if(beatShiftOn&&bpm) bpmVal.textContent=bpm+' bpm'; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- HUD ----------
function buildMeters(el,n){ for(let i=0;i<n;i++) el.appendChild(document.createElement('i')); }
buildMeters(document.getElementById('mBass'),14);
buildMeters(document.getElementById('mMid'),14);
buildMeters(document.getElementById('mTreble'),14);
function paintMeter(el,val){ const b=el.children, lit=Math.round(val*14);
  for(let i=0;i<b.length;i++){ b[i].style.height=(i<lit?(3+(i/b.length)*23):2)+'px'; b[i].style.opacity=i<lit?1:0.25; } }
function updateMeters(){
  paintMeter(document.getElementById('mBass'),audio.bands.bass);
  paintMeter(document.getElementById('mMid'),audio.bands.mid);
  paintMeter(document.getElementById('mTreble'),audio.bands.treble);
}

// ---------- CONTROLS ----------
const ui=document.getElementById('ui'), hintEl=document.getElementById('hint'), toastEl=document.getElementById('toast');
let toastTimer=null;
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1400); }
function toggleFullscreen(){
  // @ts-expect-error document.webkitFullscreenElement is a legacy Safari-prefixed API absent from the TS DOM lib
  const isFs=document.fullscreenElement||document.webkitFullscreenElement;
  // @ts-expect-error webkitRequestFullscreen is a legacy Safari-prefixed API absent from the TS DOM lib
  if(!isFs){ const rq=document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen;
    if(rq){ try{ const p=rq.call(document.documentElement); if(p&&p.catch) p.catch(()=>{}); toast('fullscreen'); }catch(e){} } }
  // @ts-expect-error webkitExitFullscreen is a legacy Safari-prefixed API absent from the TS DOM lib
  else { const ex=document.exitFullscreen||document.webkitExitFullscreen; if(ex){ try{ ex.call(document); toast('windowed'); }catch(e){} } }
}
const helpEl=document.getElementById('help');
function toggleHelp(force){ helpEl.classList.toggle('show', force!==undefined?force:!helpEl.classList.contains('show')); }
helpEl.addEventListener('click', e=>{ if(e.target===helpEl) toggleHelp(false); });   // backdrop click closes
// idle fade: hide the HUD after 10s of inactivity, reveal on any input
const IDLE_MS=10000;
let idleTimer=null;
function showUI(){ ui.classList.add('show'); hintEl.classList.add('show'); }
function hideUI(){ ui.classList.remove('show'); hintEl.classList.remove('show'); }
function poke(){ showUI(); clearTimeout(idleTimer); if(autoHide) idleTimer=setTimeout(hideUI, IDLE_MS); }
['pointermove','pointerdown','wheel','touchstart'].forEach(ev=> window.addEventListener(ev, poke, {passive:true}));
poke();
document.getElementById('file').addEventListener('change', e=>{ if(e.target.files.length) loadFiles(e.target.files); });
document.getElementById('demo').addEventListener('click', startDemo);
document.getElementById('urlLoad').addEventListener('click', ()=>{ const u=document.getElementById('urlIn').value.trim(); if(u) playUrl(u); });
document.getElementById('urlIn').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('urlLoad').click(); } });
const playBtn=document.getElementById('play');
function updatePlayBtn(){ playBtn.textContent = playing?'⏸ Pause':'▶ Play'; }
playBtn.addEventListener('click', ()=>{
  if(!audio.ctx){ startDemo(); return; }
  if(playing){ if(urlAudio) urlAudio.pause(); else audio.ctx.suspend(); playing=false; }
  else { if(urlAudio) urlAudio.play(); else if(!srcNode && playlist.length) playIndex(curIdx); else audio.ctx.resume(); playing=true; }   // URL: toggle the element; else restart the track if playback stopped at queue end (repeat off)
  updatePlayBtn();
});
// ---------- transport: seek bar (file playback only) ----------
const seekRow=document.getElementById('seekRow'), seekEl=document.getElementById('seek'),
      curTimeEl=document.getElementById('curTime'), totTimeEl=document.getElementById('totTime');
function fmtTime(s){ s=Math.max(0,Math.floor(s||0)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return (h>0? h+':'+String(m).padStart(2,'0') : String(m))+':'+String(sec).padStart(2,'0'); }
function showSeek(on){ seekRow.style.display = on?'flex':'none'; if(on) totTimeEl.textContent=fmtTime(trackDur); }
// jump to frac (0..1) of the buffer by recreating the source at that offset
function seekTo(frac){
  if(!curBuffer||!audio.ctx) return;
  const off=Math.max(0,Math.min(frac,0.999))*trackDur;
  try{ if(srcNode){ srcNode.onended=null; srcNode.stop(); srcNode.disconnect(); } }catch(e){}
  srcNode=audio.ctx.createBufferSource(); srcNode.buffer=curBuffer; srcNode.loop = playlist.length<=1 || repeatMode===2; srcNode.connect(audio.analyser);
  srcNode.onended = ()=>{ if(playlist.length>1) onTrackEnd(); };
  startCtxTime=audio.ctx.currentTime-off;   // currentTime is frozen while suspended, so this works paused too
  srcNode.start(0, off);
}
function updateSeek(){
  if(!curBuffer||!audio.ctx||seeking) return;
  const el=(audio.ctx.currentTime-startCtxTime)%trackDur;
  seekEl.value=String(Math.round(el/trackDur*1000));
  curTimeEl.textContent=fmtTime(el);
}
seekEl.addEventListener('input', ()=>{ seeking=true; if(curBuffer) curTimeEl.textContent=fmtTime(parseFloat(seekEl.value)/1000*trackDur); });
seekEl.addEventListener('change', ()=>{ if(curBuffer) seekTo(parseFloat(seekEl.value)/1000); seeking=false; });
// prev / next + track counter
const prevBtn=document.getElementById('prev'), nextBtn=document.getElementById('next'), trackCountEl=document.getElementById('trackCount'),
      shufBtn=document.getElementById('shuf'), repBtn=document.getElementById('rep');
prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);
function updateTrackCounter(){ const multi=playlist.length>1; trackCountEl.textContent = multi ? (curIdx+1)+' / '+playlist.length : ''; prevBtn.disabled=nextBtn.disabled=shufBtn.disabled=repBtn.disabled=!multi; }
function applyShufUI(){ shufBtn.classList.toggle('on', shuffleOn); }
function applyRepUI(){ repBtn.classList.toggle('on', repeatMode!==0); repBtn.textContent = repeatMode===2 ? '↻1' : '↻'; }
shufBtn.addEventListener('click', ()=>{ shuffleOn=!shuffleOn; localStorage.setItem('resomance_shuffle', shuffleOn?'1':'0'); applyShufUI(); toast(shuffleOn?'shuffle on':'shuffle off'); });
repBtn.addEventListener('click', ()=>{ repeatMode=(repeatMode+1)%3; if(srcNode) srcNode.loop = playlist.length<=1 || repeatMode===2; localStorage.setItem('resomance_repeat', String(repeatMode)); applyRepUI(); toast(['repeat off','repeat all','repeat one'][repeatMode]); });
applyShufUI(); applyRepUI();
// scene segmented buttons
const modeSeg=document.getElementById('modeSeg');
function applyModeUI(){ [...modeSeg.children].forEach(x=>x.classList.toggle('on', parseInt(x.dataset.mode,10)===curMode)); }
function setMode(m){ curMode=m; modeA=modeB=m; blend=0; mixTrans=null; mixArmedAt=null; applyModeUI(); applyScenePalette(m); localStorage.setItem('resomance_scene', String(m)); if(autoMixOn) autoMixNext=clockSec()+AUTO_MIX_INTERVAL; }
modeSeg.addEventListener('click', e=>{ const b=e.target.closest('button[data-mode]'); if(b) setMode(parseInt(b.dataset.mode,10)); });
// palette
const styleSel=document.getElementById('style');
function applyScenePalette(m){ curStyle=scenePalette[m]||0; styleSel.value=String(curStyle); syncPalEditor(); }   // recall a scene's remembered palette into the active uniform + UI
function setStyle(s){ curStyle=s; scenePalette[curMode]=s; styleSel.value=String(s); localStorage.setItem('resomance_scene_palette', JSON.stringify(scenePalette)); syncPalEditor(); }
styleSel.addEventListener('change', e=> setStyle(parseFloat(e.target.value)));
// custom palette editor: a/b/c/d color pickers
[['cpA','a'],['cpB','b'],['cpC','c'],['cpD','d']].forEach(([id,k])=> document.getElementById(id).addEventListener('input', e=>{ customPal[k]=h2v(e.target.value); localStorage.setItem('resomance_custompal', JSON.stringify(customPal)); }));
// ring toggle
const ringChk=document.getElementById('ring');
function setRing(on){ ringOn=on; ringChk.checked=on; localStorage.setItem('resomance_ring', on?'1':'0'); }
ringChk.addEventListener('change', e=> setRing(e.target.checked));
// auto-hide HUD toggle
const autohideChk=document.getElementById('autohide');
autohideChk.addEventListener('change', e=>{ autoHide=e.target.checked; localStorage.setItem('resomance_autohide', autoHide?'1':'0'); if(!autoHide) showUI(); });
// auto-mix scene cycling (crossfade to next scene on a timer)
const autoMixChk=document.getElementById('autoMix');
autoMixChk.checked=autoMixOn;
autoMixChk.addEventListener('change', e=>{ autoMixOn=e.target.checked; localStorage.setItem('resomance_automix', autoMixOn?'1':'0');
  if(autoMixOn){ mixTrans=null; mixArmedAt=null; autoMixNext=clockSec()+AUTO_MIX_INTERVAL; } else { modeA=modeB=curMode; blend=0; mixTrans=null; mixArmedAt=null; } });
// sync UI to persisted look on load
applyModeUI();
styleSel.value=String(curStyle); ringChk.checked=ringOn; autohideChk.checked=autoHide; syncPalEditor();
// volume
const volSlider=document.getElementById('vol'), volLbl=document.getElementById('volLbl');
const savedVol=state.volume;
if(!isNaN(savedVol)){ volSlider.value=savedVol; volLbl.textContent=Math.round(savedVol*100)+'%'; }
volSlider.addEventListener('input', e=>{
  const v=parseFloat(e.target.value);
  if(audio.master) audio.master.gain.setTargetAtTime(v, audio.ctx.currentTime, 0.02);
  volLbl.textContent=Math.round(v*100)+'%';
  localStorage.setItem('resomance_vol', String(v));
});
// look panel: feedback / swirl / glow sliders, persisted like volume
const lookToggle=document.getElementById('lookToggle'), lookPanel=document.getElementById('lookPanel');
lookToggle.addEventListener('click', ()=> lookPanel.style.display = lookPanel.style.display==='none'?'flex':'none');
function bindLook(id,key){ const el=document.getElementById(id); el.value=look[key];
  el.addEventListener('input', e=>{ look[key]=parseFloat(e.target.value); localStorage.setItem('resomance_look', JSON.stringify(look)); }); }
bindLook('lkFeedback','feedback'); bindLook('lkSwirl','swirl'); bindLook('lkGlow','glow'); bindLook('lkVig','vig'); bindLook('lkCa','ca'); bindLook('lkGrain','grain');
// user shader: paste a vec3 scene body, compiled into the scene program at runtime (compile errors reported)
const shaderToggle=document.getElementById('shaderToggle'), shaderPanel=document.getElementById('shaderPanel');
shaderToggle.addEventListener('click', ()=> shaderPanel.style.display = shaderPanel.style.display==='none'?'flex':'none');
const shaderCode=document.getElementById('shaderCode'), shaderCompile=document.getElementById('shaderCompile'), shaderMsg=document.getElementById('shaderMsg');
function compileUserShader(){
  const code=shaderCode.value;
  const src=fsScene.replace(/\/\/ USER_SHADER_BEGIN[\s\S]*?\/\/ USER_SHADER_END/, '// USER_SHADER_BEGIN\n'+code+'\n  // USER_SHADER_END');
  try{
    const p=program(vsSrc, src);
    gl.deleteProgram(progScene); progScene=p; U=buildSceneU(p);
    localStorage.setItem('resomance_usershader', code);
    shaderMsg.textContent='compiled ✓'; shaderMsg.style.color='#7fd0a0'; shaderCode.title='';
  }catch(e){
    shaderMsg.textContent='compile error (see tooltip/console)'; shaderMsg.style.color='#ff7a8a';
    shaderCode.title=e.message; console.error('user shader error:\n'+e.message);
  }
}
shaderCompile.addEventListener('click', compileUserShader);
shaderCode.value = localStorage.getItem('resomance_usershader') || 'return palette(u_time*0.1 + u_bass + length(uv)*0.3) * (0.3 + u_bass);';
if(localStorage.getItem('resomance_usershader')) compileUserShader();   // recompile the saved shader on load
// reactivity router: source -> target selects (kick/snare/hat/bass -> none/swirl/glow/feedback), persisted
const RT_OPTS=['none','swirl','glow','feedback'];
[['rtKick','kick'],['rtSnare','snare'],['rtHat','hat'],['rtBass','bass']].forEach(([id,src])=>{
  const sel=document.getElementById(id);
  RT_OPTS.forEach(o=>{ const op=document.createElement('option'); op.value=o; op.textContent=o; sel.appendChild(op); });
  sel.value=router[src];
  sel.addEventListener('change', e=>{ router[src]=e.target.value; localStorage.setItem('resomance_router', JSON.stringify(router)); });
});
// quality preset (DPR cap + raymarch steps) + FPS meter
const qualSeg=document.getElementById('qualSeg');
function setQuality(i){ qualIdx=i; qual=QUAL[i]; localStorage.setItem('resomance_quality', String(i));
  [...qualSeg.children].forEach(b=>b.classList.toggle('on', parseInt(b.dataset.q,10)===i));
  W=H=0; resize(); }   // force re-alloc of render targets at the new DPR
qualSeg.addEventListener('click', e=>{ const b=e.target.closest('button[data-q]'); if(b) setQuality(parseInt(b.dataset.q,10)); });
[...qualSeg.children].forEach(b=>b.classList.toggle('on', parseInt(b.dataset.q,10)===qualIdx));
const fpsChk=document.getElementById('fpsChk'), fpsVal=document.getElementById('fpsVal');
let showFps = state.showFps;
fpsChk.checked=showFps; if(!showFps) fpsVal.textContent='';
fpsChk.addEventListener('change', e=>{ showFps=e.target.checked; localStorage.setItem('resomance_fps', showFps?'1':'0'); if(!showFps) fpsVal.textContent='--'; });
// beat-aware palette shift toggle (BPM estimate drives palette rotation)
const beatShiftChk=document.getElementById('beatShift'), bpmVal=document.getElementById('bpmVal');
let beatShiftOn = state.beatShiftOn;
beatShiftChk.checked=beatShiftOn; if(!beatShiftOn) bpmVal.textContent='--';
beatShiftChk.addEventListener('change', e=>{ beatShiftOn=e.target.checked; localStorage.setItem('resomance_beatshift', beatShiftOn?'1':'0'); if(!beatShiftOn) bpmVal.textContent='--'; });
// auto-gain toggle: normalize band levels against rolling loudness (default on; ~1x for normal-level tracks)
const agcChk=document.getElementById('agc');
agcChk.checked=state.autoGainOn;
agcChk.addEventListener('change', e=>{ state.autoGainOn=e.target.checked; localStorage.setItem('resomance_autogain', state.autoGainOn?'1':'0'); });
// keyboard
// ---------- named look presets (snapshot slots), recalled with Shift+1..8 ----------
let presets = state.presets;
while(presets.length<8) presets.push(null);
function syncLookSliders(){ for(const k of ['feedback','swirl','glow','vig','ca','grain']){ const el=document.getElementById('lk'+k.charAt(0).toUpperCase()+k.slice(1)); if(el) el.value=look[k]; } }
function syncRouterUI(){ for(const [id,src] of [['rtKick','kick'],['rtSnare','snare'],['rtHat','hat'],['rtBass','bass']]){ const s=document.getElementById(id); if(s) s.value=router[src]; } }
function captureLook(){ return { mode:curMode, style:scenePalette[curMode], look:{...look}, router:{...router}, customPal:JSON.parse(JSON.stringify(customPal)), ring:ringOn, autoHide, autoMix:autoMixOn, beatShift:beatShiftOn, autoGain:state.autoGainOn }; }
function applyLook(p){
  scenePalette[p.mode]=p.style; setMode(p.mode); localStorage.setItem('resomance_scene_palette', JSON.stringify(scenePalette));
  Object.assign(look, p.look); localStorage.setItem('resomance_look', JSON.stringify(look)); syncLookSliders();
  Object.assign(router, p.router); localStorage.setItem('resomance_router', JSON.stringify(router)); syncRouterUI();
  Object.assign(customPal, p.customPal); localStorage.setItem('resomance_custompal', JSON.stringify(customPal)); syncColorInputs(); syncPalEditor();
  ringChk.checked=p.ring; ringChk.dispatchEvent(new Event('change'));
  autohideChk.checked=p.autoHide; autohideChk.dispatchEvent(new Event('change'));
  autoMixChk.checked=p.autoMix; autoMixChk.dispatchEvent(new Event('change'));
  beatShiftChk.checked=p.beatShift; beatShiftChk.dispatchEvent(new Event('change'));
  agcChk.checked=p.autoGain; agcChk.dispatchEvent(new Event('change'));
}
function savePreset(i){ presets[i]=captureLook(); localStorage.setItem('resomance_presets', JSON.stringify(presets)); updatePresetUI(); toast('saved preset '+(i+1)); }
function recallPreset(i){ if(!presets[i]){ toast('preset '+(i+1)+' empty'); return; } applyLook(presets[i]); toast('recalled preset '+(i+1)); }
function updatePresetUI(){ document.querySelectorAll('.ps').forEach(b=> b.classList.toggle('filled', !!presets[+b.dataset.s-1])); }
const psSave=document.getElementById('psSave');
document.querySelectorAll('.ps').forEach(b=> b.addEventListener('click', ()=>{ const i=+b.dataset.s-1; if(psSave.checked) savePreset(i); else recallPreset(i); }));
updatePresetUI();

window.addEventListener('keydown', e=>{
  if(e.key==='?'){ toggleHelp(); return; }
  if(e.key==='Escape' && helpEl.classList.contains('show')){ toggleHelp(false); return; }
  if(helpEl.classList.contains('show')) return;   // modal: swallow other keys while the cheat sheet is open
  if(e.code==='Space'){ e.preventDefault(); playBtn.click(); }
  if(e.key==='h'||e.key==='H'){
    // manual toggle: hide now and stay hidden until the next pointer/key activity
    if(ui.classList.contains('show')){ hideUI(); clearTimeout(idleTimer); }
    else { poke(); }
    return;
  }
  if(e.shiftKey && e.code.startsWith('Digit')){ const n=parseInt(e.code.slice(5),10); if(n>=1&&n<=8){ e.preventDefault(); if(e.ctrlKey||e.metaKey) savePreset(n-1); else recallPreset(n-1); return; } }
  if(e.key>='1'&&e.key<='6') setMode(parseInt(e.key,10)-1);
  if(e.key==='r'||e.key==='R') setRing(!ringOn);
  if(e.key==='s'||e.key==='S') pendingShot=true;
  if(e.key==='f'||e.key==='F') toggleFullscreen();
  if((e.key==='ArrowRight'||e.key==='ArrowLeft') && document.activeElement!==seekEl){ e.preventDefault(); e.key==='ArrowRight'?nextTrack():prevTrack(); }
  poke();   // any other key counts as activity
});

// drag & drop
const drop=document.getElementById('drop');
window.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('on'); });
window.addEventListener('dragleave', e=>{ if(e.relatedTarget===null) drop.classList.remove('on'); });
window.addEventListener('drop', e=>{ e.preventDefault(); drop.classList.remove('on');
  const dt=e.dataTransfer;
  if(dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry==='function'){
    const entries=[]; for(const it of dt.items){ const en=it.webkitGetAsEntry(); if(en) entries.push(en); }
    if(entries.length){ collectEntries(entries).then(loadFiles); return; }
  }
  if(dt.files && dt.files.length) loadFiles(dt.files);
});
// orbit camera: drag on the canvas to look around the Fractal/Tunnel field (double-click resets to auto)
// multi-pointer camera: one finger orbits, two fingers orbit + pinch-zoom
function updateGesture(isMove){
  const ps=[...pointers.values()];
  if(ps.length<1){ dragging=false; pinchDist0=0; return; }
  orbitActive=true; dragging=true;
  if(ps.length>=2){ const a=ps[0],b=ps[1]; const dist=Math.hypot(b.x-a.x,b.y-a.y); const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    if(isMove && pinchDist0>0) camZoom=Math.max(0.4,Math.min(3.5, camZoom*(dist/pinchDist0)));
    if(isMove){ camYaw-=(mx-lastDX)*0.006; camPitch=Math.max(-1.2,Math.min(1.2, camPitch-(my-lastDY)*0.006)); }
    pinchDist0=dist; lastDX=mx; lastDY=my; }
  else { const p=ps[0]; if(isMove){ camYaw-=(p.x-lastDX)*0.008; camPitch=Math.max(-1.2,Math.min(1.2, camPitch-(p.y-lastDY)*0.008)); } lastDX=p.x; lastDY=p.y; pinchDist0=0; }
}
canvas.addEventListener('pointerdown', e=>{ if(e.button!==0 && e.pointerType==='mouse') return; pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); try{canvas.setPointerCapture(e.pointerId);}catch(_){} updateGesture(false); });
canvas.addEventListener('pointermove', e=>{ if(!pointers.has(e.pointerId)) return; pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); updateGesture(true); });
const endDrag=e=>{ pointers.delete(e.pointerId); try{canvas.releasePointerCapture(e.pointerId);}catch(_){} updateGesture(false); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', ()=>{ orbitActive=false; camYaw=camPitch=0; camZoom=1; toast('auto camera'); });

// auto-start demo after first gesture (browsers require a user gesture for audio)
function firstGesture(){
  if(pendingRestore){ const r=pendingRestore; pendingRestore=null; loadFiles(r.files, r.idx, r.pos, true); }   // restore the queue at the saved position (skipSave: just read it)
  else startDemo();
  window.removeEventListener('pointerdown',firstGesture); window.removeEventListener('keydown',firstGesture);
}
window.addEventListener('pointerdown', firstGesture);
window.addEventListener('keydown', firstGesture);

// PWA: register service worker for installable + offline support
if('serviceWorker' in navigator) window.addEventListener('load', ()=> navigator.serviceWorker.register('./sw.js').catch(()=>{}));
