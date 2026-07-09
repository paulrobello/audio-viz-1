// @ts-nocheck — Transitional monolith: this file is the un-refactored original app
// script, relocated verbatim from index.html. checkJs stays ON in jsconfig.json so the
// modules split out in later tasks (audio/playback/gl/render/camera/ui/controls) ARE
// type-checked; this per-file opt-out exists only until the code below is decomposed.
// Removed by Task 10, when main.js is a small, fully-typed boot + frame-loop file.
import './styles.css';
import { state, on } from './state.js';
import { audio, analyze } from './audio.js';
import * as pb from './playback.js';
import { resize, setQuality } from './gl.js';
import { initRender, renderFrame, requestScreenshot, compileUserShader } from './render.js';
import { cam, initCamera } from './camera.js';
const errEl = document.getElementById('err');
function fatal(msg){ errEl.style.display='block'; errEl.textContent = '⚠ '+msg; console.error(msg); }
window.addEventListener('error', e => fatal((e.message||'error')+(e.filename?('\n'+e.filename+':'+e.lineno):'')));

const canvas = document.getElementById('gl');
window.addEventListener('resize', resize);   // gl.js performs the initial resize() at module load

// build the uniform-location caches (U/UC/UB/UBL) + recompile any saved user shader
initRender();
// wire orbit/pinch-zoom camera gestures onto the canvas (mutates cam.* in place)
initCamera(canvas);

// ---------- transport bus: playback.js → view (UI updates that used to be inline) ----------
on('transport', (e) => {
  if (e.type === 'playState') updatePlayBtn();
  else if (e.type === 'trackName') document.getElementById('sub').textContent = e.name;
  else if (e.type === 'seekVisibility') showSeek(e.on);
  else if (e.type === 'trackCount') updateTrackCounter();
  else if (e.type === 'toast') toast(e.msg);
  else if (e.type === 'fatal') fatal(e.msg);
});
// persist the queue position (playback owns the data; main.js owns the app lifecycle)
setInterval(() => pb.saveQueuePos(), 5000);   // checkpoint playback position periodically
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pb.saveQueuePos(); });
window.addEventListener('beforeunload', pb.saveQueuePos);

// ---------- RENDER ----------
// accessibility: respect OS reduced-motion (calm swirl, trails, and beat flashes).
// state.reducedMotion is the source of truth read by render.js each frame; keep it live.
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e=> state.reducedMotion=e.matches);
let t0=performance.now(), lastUI=0, lastFrame=0, fpsEMA=0;
let bpm=0, paletteShift=0, prevBeat=0, shockStart=-10; const beatTimes=[];   // beat-aware palette shift + shockwave origin
let beatPulse=false;   // one-frame true when a new kick onset is detected (drives beat-synced auto-mix)
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
function frame(now){
  const time=(now-t0)/1000;
  const dt = lastFrame? now-lastFrame : 0; lastFrame=now;
  if(dt>0){ const inst=1000/dt; fpsEMA = fpsEMA? fpsEMA*0.9+inst*0.1 : inst; }
  analyze(); resize();
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

  // render: spectrum upload + scene + bloom + composite + (optional) screenshot + ping-pong swap
  renderFrame({ time, modeA, modeB, blend, paletteShift: state.beatShiftOn ? paletteShift : 0, shock: shockStart, camYaw: cam.yaw, camPitch: cam.pitch, camZoom: cam.zoom, orbitActive: cam.active });

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
document.getElementById('file').addEventListener('change', e=>{ if(e.target.files.length) pb.loadFiles(e.target.files); });
document.getElementById('demo').addEventListener('click', pb.startDemo);
document.getElementById('urlLoad').addEventListener('click', ()=>{ const u=document.getElementById('urlIn').value.trim(); if(u) pb.playUrl(u); });
document.getElementById('urlIn').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('urlLoad').click(); } });
const playBtn=document.getElementById('play');
function updatePlayBtn(){ playBtn.textContent = pb.isPlaying()?'⏸ Pause':'▶ Play'; }
playBtn.addEventListener('click', () => pb.togglePlay());
// ---------- transport: seek bar (file playback only) ----------
const seekRow=document.getElementById('seekRow'), seekEl=document.getElementById('seek'),
      curTimeEl=document.getElementById('curTime'), totTimeEl=document.getElementById('totTime');
let seeking=false;
function fmtTime(s){ s=Math.max(0,Math.floor(s||0)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return (h>0? h+':'+String(m).padStart(2,'0') : String(m))+':'+String(sec).padStart(2,'0'); }
function showSeek(on){ seekRow.style.display = on?'flex':'none'; if(on) totTimeEl.textContent=fmtTime(pb.getTrackDur()); }
function updateSeek(){
  if(!pb.hasBuffer()||!audio.ctx||seeking) return;
  const el=pb.currentElapsed(), dur=pb.getTrackDur();
  seekEl.value=String(Math.round(el/dur*1000));
  curTimeEl.textContent=fmtTime(el);
}
seekEl.addEventListener('input', ()=>{ seeking=true; if(pb.hasBuffer()) curTimeEl.textContent=fmtTime(parseFloat(seekEl.value)/1000*pb.getTrackDur()); });
seekEl.addEventListener('change', ()=>{ if(pb.hasBuffer()) pb.seekTo(parseFloat(seekEl.value)/1000); seeking=false; });
// prev / next + track counter
const prevBtn=document.getElementById('prev'), nextBtn=document.getElementById('next'), trackCountEl=document.getElementById('trackCount'),
      shufBtn=document.getElementById('shuf'), repBtn=document.getElementById('rep');
prevBtn.addEventListener('click', pb.prevTrack);
nextBtn.addEventListener('click', pb.nextTrack);
function updateTrackCounter(){ const pl=pb.getPlaylist(), ci=pb.getCurIdx(); const multi=pl.length>1; trackCountEl.textContent = multi ? (ci+1)+' / '+pl.length : ''; prevBtn.disabled=nextBtn.disabled=shufBtn.disabled=repBtn.disabled=!multi; }
function applyShufUI(){ shufBtn.classList.toggle('on', state.shuffleOn); }
function applyRepUI(){ repBtn.classList.toggle('on', state.repeatMode!==0); repBtn.textContent = state.repeatMode===2 ? '↻1' : '↻'; }
shufBtn.addEventListener('click', ()=>{ state.shuffleOn=!state.shuffleOn; localStorage.setItem('resomance_shuffle', state.shuffleOn?'1':'0'); applyShufUI(); toast(state.shuffleOn?'shuffle on':'shuffle off'); });
repBtn.addEventListener('click', ()=>{ state.repeatMode=(state.repeatMode+1)%3; pb.applyLoop(); localStorage.setItem('resomance_repeat', String(state.repeatMode)); applyRepUI(); toast(['repeat off','repeat all','repeat one'][state.repeatMode]); });
applyShufUI(); applyRepUI();
// scene segmented buttons
const modeSeg=document.getElementById('modeSeg');
function applyModeUI(){ [...modeSeg.children].forEach(x=>x.classList.toggle('on', parseInt(x.dataset.mode,10)===curMode)); }
function setMode(m){ curMode=m; modeA=modeB=m; blend=0; mixTrans=null; mixArmedAt=null; applyModeUI(); applyScenePalette(m); localStorage.setItem('resomance_scene', String(m)); if(autoMixOn) autoMixNext=clockSec()+AUTO_MIX_INTERVAL; }
modeSeg.addEventListener('click', e=>{ const b=e.target.closest('button[data-mode]'); if(b) setMode(parseInt(b.dataset.mode,10)); });
// palette
const styleSel=document.getElementById('style');
function applyScenePalette(m){ curStyle=scenePalette[m]||0; state.curStyle=curStyle; styleSel.value=String(curStyle); syncPalEditor(); }   // recall a scene's remembered palette into the active uniform + UI
function setStyle(s){ curStyle=s; state.curStyle=curStyle; scenePalette[curMode]=s; styleSel.value=String(s); localStorage.setItem('resomance_scene_palette', JSON.stringify(scenePalette)); syncPalEditor(); }
styleSel.addEventListener('change', e=> setStyle(parseFloat(e.target.value)));
// custom palette editor: a/b/c/d color pickers
[['cpA','a'],['cpB','b'],['cpC','c'],['cpD','d']].forEach(([id,k])=> document.getElementById(id).addEventListener('input', e=>{ customPal[k]=h2v(e.target.value); localStorage.setItem('resomance_custompal', JSON.stringify(customPal)); }));
// ring toggle
const ringChk=document.getElementById('ring');
function setRing(on){ ringOn=on; state.ringOn=on; ringChk.checked=on; localStorage.setItem('resomance_ring', on?'1':'0'); }
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
shaderCompile.addEventListener('click', () => {
  const r = compileUserShader(shaderCode.value);
  if(r.ok){ shaderMsg.textContent='compiled ✓'; shaderMsg.style.color='#7fd0a0'; shaderCode.title=''; }
  else { shaderMsg.textContent='compile error (see tooltip/console)'; shaderMsg.style.color='#ff7a8a'; shaderCode.title=r.error; }
});
shaderCode.value = localStorage.getItem('resomance_usershader') || 'return palette(u_time*0.1 + u_bass + length(uv)*0.3) * (0.3 + u_bass);';
// initRender() (called at boot) recompiles the saved user shader, if any
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
qualSeg.addEventListener('click', e=>{ const b=e.target.closest('button[data-q]'); if(b){ setQuality(parseInt(b.dataset.q,10));
  [...qualSeg.children].forEach(x=>x.classList.toggle('on', parseInt(x.dataset.q,10)===state.qualIdx)); } });
[...qualSeg.children].forEach(b=>b.classList.toggle('on', parseInt(b.dataset.q,10)===state.qualIdx));
const fpsChk=document.getElementById('fpsChk'), fpsVal=document.getElementById('fpsVal');
let showFps = state.showFps;
fpsChk.checked=showFps; if(!showFps) fpsVal.textContent='';
fpsChk.addEventListener('change', e=>{ showFps=e.target.checked; localStorage.setItem('resomance_fps', showFps?'1':'0'); if(!showFps) fpsVal.textContent='--'; });
// beat-aware palette shift toggle (BPM estimate drives palette rotation)
const beatShiftChk=document.getElementById('beatShift'), bpmVal=document.getElementById('bpmVal');
let beatShiftOn = state.beatShiftOn;
beatShiftChk.checked=beatShiftOn; if(!beatShiftOn) bpmVal.textContent='--';
beatShiftChk.addEventListener('change', e=>{ beatShiftOn=e.target.checked; state.beatShiftOn=beatShiftOn; localStorage.setItem('resomance_beatshift', beatShiftOn?'1':'0'); if(!beatShiftOn) bpmVal.textContent='--'; });
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
  if(e.key==='s'||e.key==='S') requestScreenshot();
  if(e.key==='f'||e.key==='F') toggleFullscreen();
  if((e.key==='ArrowRight'||e.key==='ArrowLeft') && document.activeElement!==seekEl){ e.preventDefault(); e.key==='ArrowRight'?pb.nextTrack():pb.prevTrack(); }
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
    if(entries.length){ pb.collectEntries(entries).then(pb.loadFiles); return; }
  }
  if(dt.files && dt.files.length) pb.loadFiles(dt.files);
});

// auto-start demo after first gesture (browsers require a user gesture for audio)
function firstGesture(){
  pb.onFirstGesture();   // restore the queue at the saved position, else start the demo
  window.removeEventListener('pointerdown',firstGesture); window.removeEventListener('keydown',firstGesture);
}
window.addEventListener('pointerdown', firstGesture);
window.addEventListener('keydown', firstGesture);

// PWA: register service worker for installable + offline support
if('serviceWorker' in navigator) window.addEventListener('load', ()=> navigator.serviceWorker.register('./sw.js').catch(()=>{}));
