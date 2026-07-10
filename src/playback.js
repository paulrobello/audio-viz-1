// Playback engine: audio sources (file / URL / demo), playlist queue, transport
// (play / pause / skip / seek), shuffle / repeat, and folder-drop traversal. Lifted
// verbatim from the former monolith; the demo synth graph, decode/seek/queue/shuffle/
// repeat logic, CORS handling (audioEl.crossOrigin='anonymous'), and srcNode.loop /
// onended semantics are unchanged. The view (still in main.js until Task 8) is notified
// via the state bus ('transport') instead of direct UI calls.
import { audio, ensureCtx } from './audio.js';
import { idbGetQueue, idbSaveQueue, idbSavePos, idbGetPos, idbGetAudio } from './storage.js';
import { state, emit } from './state.js';
import { parseId3 } from './id3.js';

let srcNode = null, demoNodes = null, playing = true, isDemo = false;
let srcGain = null;     // per-source gain for the active buffer source (enables track crossfades)
let xfadeOut = null;    // { src, gain } of the outgoing source while a track crossfade is in progress
const XFADE = 4.0;      // crossfade duration in seconds
let urlAudio = null, urlMes = null;   // <audio> + MediaElementSource for URL / live-stream playback
let micStream = null, micSrc = null;   // getUserMedia stream + MediaStreamSource for live mic / line-in (not monitored to speakers — avoids feedback)
let curBuffer = null, startCtxTime = 0, trackDur = 0;   // file transport / seek state
let curWave = null;   // downsampled peak-amplitude waveform [0..1] per bucket, for the seek-bar overview scrubber
let abA = -1, abB = -1;   // A-B loop points in seconds (-1 = unset); armed when both >= 0 and abB > abA
let curTrackName = '';    // current track name (per-track cue-map key)
let curSourceKey = '';    // identity key for per-track look bindings (file name or URL)
// per-track cue markers, persisted as { trackName: [seconds...] } so cues survive a reload
const cueMap = (() => { try { const o = JSON.parse(localStorage.getItem('resomance_cues') ?? '{}'); return new Map(Array.isArray(o) ? [] : Object.entries(o)); } catch (_) { return new Map(); } })();
let curCues = [];         // sorted cue positions (seconds) for the current track
let playlist = [], curIdx = -1, loadToken = 0, decodeFails = 0;   // queue for multi-file / folder loads
let pendingRestore = null;   // {files, idx, pos} restored on first gesture
// restoreReady resolves once the async IndexedDB restore lookup below has finished. Created
// synchronously (at module load) so onFirstGesture can always wait on it — this closes a race
// where an early first gesture ran before the lookup set pendingRestore, started the demo, and
// stranded the not-yet-loaded track (leaving "click to resume" with the gesture listener gone).
let restoreReadyResolve = () => {};   // no-op default; the Promise executor below reassigns it synchronously
const restoreReady = new Promise((r) => { restoreReadyResolve = () => r(undefined); });
let firstGestureHandled = false;

// ---- bus → view (replaces former direct calls to toast/fatal/setTrackName/updatePlayBtn/showSeek/updateTrackCounter) ----
function toast(msg){ emit('transport', { type: 'toast', msg }); }
function fatal(msg){ emit('transport', { type: 'fatal', msg }); }
function setTrackName(name){ emit('transport', { type: 'trackName', name }); }
function playState(){ emit('transport', { type: 'playState' }); }
function seekVis(on){ emit('transport', { type: 'seekVisibility', on }); }
function trackCount(){ emit('transport', { type: 'trackCount' }); }

export function currentElapsed(){ if(!curBuffer||!audio.ctx) return 0; return Math.max(0,(audio.ctx.currentTime-startCtxTime)%trackDur); }
export function saveQueuePos(pos){ if(playlist.length<1||curIdx<0) return; idbSavePos({idx:curIdx, pos:(pos!=null?pos:currentElapsed())}); }

// ---- A-B loop + per-track cue points (rehearse / loop a section instead of whole-track linear playback) ----
function fmtT(s){ s=Math.max(0,Math.floor(s||0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
function persistCues(){ try { const o={}; cueMap.forEach((v,k)=>{ if(v&&v.length) o[k]=v; }); localStorage.setItem('resomance_cues', JSON.stringify(o)); } catch(_){} }
function loadCuesFor(name){ curTrackName=name; const arr=cueMap.get(name); curCues = Array.isArray(arr) ? [...arr].sort((a,b)=>a-b) : []; }
// press A: first sets A (loop start), second sets B (loop end, arms), third clears
export function setABPoint(){
  if(!curBuffer){ toast('load a track first'); return; }
  const el=currentElapsed();
  if(abA<0){ abA=el; toast('A set @ '+fmtT(el)); }
  else if(abB<0){ if(el<=abA){ toast('B must be after A'); } else { abB=el; toast('B set · A-B loop on'); } }
  else { abA=abB=-1; toast('A-B loop off'); }
  emit('transport', { type:'seekMarks' });
}
export function clearAB(){ abA=abB=-1; }
export function getAB(){ return { a:abA, b:abB }; }
// jump from B back to A when the loop is armed (called every frame from main.js)
export function checkABLoop(){ if(abA>=0 && abB>=0 && curBuffer && currentElapsed()>=abB) seekTo(abA/trackDur); }
// drop a cue marker at the current position (per-track, persisted)
export function dropCue(){
  if(!curBuffer){ toast('load a track first'); return; }
  const el=currentElapsed(), f=Math.round(el*100)/100;
  if(curCues.indexOf(f)<0){ curCues.push(f); curCues.sort((a,b)=>a-b); cueMap.set(curTrackName,[...curCues]); persistCues(); toast('cue @ '+fmtT(el)); emit('transport', { type:'seekMarks' }); }
}
export function clearCues(){ if(curCues.length){ curCues=[]; cueMap.delete(curTrackName); persistCues(); toast('cues cleared'); emit('transport', { type:'seekMarks' }); } }
export function getCues(){ return curCues; }
// ---- waveform overview: decode the PCM once, downsample to N peak-amplitude buckets (normalized) ----
function computeWave(buf){
  const N=200; const ch=buf.getChannelData(0); const len=ch.length;
  const block=Math.max(1, Math.floor(len/N)); const out=new Float32Array(N);
  for(let b=0;b<N;b++){ let mx=0; const s=b*block, e=Math.min(len, s+block); for(let i=s;i<e;i++){ const a=Math.abs(ch[i]); if(a>mx)mx=a; } out[b]=mx; }
  let peak=0; for(let i=0;i<N;i++) if(out[i]>peak)peak=out[i];
  if(peak>0) for(let i=0;i<N;i++) out[i]/=peak;   // normalize relative energy so the loudest bucket reads ~1
  curWave=out;
}
export function getWave(){ return curWave; }
export function currentTrackKey(){ return curSourceKey; }   // identity for per-track look bindings

// ---- persist the full playlist queue + position across reloads (IndexedDB impls live in storage.js) ----
// restore on load (no autoplay — browsers block audio without a gesture; resumes on first click)
(async function(){
  try{
    const q=await idbGetQueue();
    if(q&&q.length){ const p=await idbGetPos(); const idx=(p&&p.idx>=0&&p.idx<q.length)?p.idx:0; pendingRestore={files:q, idx, pos:(p&&p.pos)||0}; setTrackName((q[idx].name||'track')+'  ·  click to resume'); return; }
    const rec=await idbGetAudio();   // legacy single-track cache
    if(rec&&rec.blob){ const f=new File([rec.blob], rec.name||'track', {type:rec.type||'audio/*'}); pendingRestore={files:[f], idx:0, pos:0}; setTrackName(f.name+'  ·  click to resume'); }
  } finally { restoreReadyResolve(); }   // always signal completion so a waiting first gesture can act
})();

export function stopSources(){
  stopXfadeOut();
  if(srcNode){ srcNode.onended=null; try{srcNode.stop();}catch(e){} try{srcNode.disconnect();}catch(e){} srcNode=null; }
  if(srcGain){ try{srcGain.disconnect();}catch(e){} srcGain=null; }
  if(demoNodes){ demoNodes.forEach(n=>{ try{n.stop&&n.stop();}catch(e){} try{n.disconnect();}catch(e){} }); demoNodes=null; }
  if(urlAudio){ try{urlAudio.pause();}catch(e){} try{urlMes.disconnect();}catch(e){} urlAudio=null; urlMes=null; }
  if(micSrc){ try{micSrc.disconnect();}catch(e){} micSrc=null; }                                       // live-input cleanup
  if(micStream){ micStream.getTracks().forEach((t)=>t.stop()); micStream=null;                         // stop the mic tracks
    if(audio.analyser && audio.master){ try{audio.analyser.connect(audio.master);}catch(e){} } }       // restore the speaker monitor path (muted during mic mode)
  isDemo=false;
}
// hard-stop the outgoing crossfade source (used by stopSources / seekTo / a superseding load)
function stopXfadeOut(){
  if(!xfadeOut) return;
  const o=xfadeOut; xfadeOut=null;
  if(!audio.ctx) return;
  o.src.onended=null;
  try{ o.gain.gain.cancelScheduledValues(audio.ctx.currentTime); }catch(e){}
  try{ o.src.stop(); }catch(e){} try{ o.src.disconnect(); }catch(e){} try{ o.gain.disconnect(); }catch(e){}
}
// ---------- live mic / line-in source (getUserMedia → analyser; NOT monitored to speakers to avoid feedback) ----------
export function startMic(){
  ensureCtx(); stopSources();
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast('mic not supported here'); return; }
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false } })
    .then((stream)=>{
      stopSources();                                                                                   // clear any source that arrived while the prompt was open
      micStream = stream;
      micSrc = audio.ctx.createMediaStreamSource(stream);
      micSrc.connect(audio.analyser);
      try{ audio.analyser.disconnect(audio.master); }catch(e){}                                        // mute the monitor path so the mic doesn't howl out the speakers
      curBuffer=null; playlist=[]; curIdx=-1; trackDur=0;
      playing=true; isDemo=false; playState(); setTrackName('🎤 live input'); seekVis(false); trackCount();
    })
    .catch(()=>toast('mic blocked or unavailable'));
}

function playFile(file, offset, xfade){
  ensureCtx();
  const xfd = xfade ? Math.min(XFADE, Math.max(0.3, xfade)) : 0;   // crossfade seconds (0 = hard cut)
  const canXfade = xfd > 0 && state.crossfadeOn && srcNode && playing;
  const outgoing = canXfade ? { src: srcNode, gain: srcGain } : null;
  if (canXfade) { stopXfadeOut(); xfadeOut = outgoing; srcNode = null; srcGain = null; }   // hand the active source to the outgoing pair; mark crossfade in progress
  else stopSources();
  const tok=++loadToken;   // guard against out-of-order decode completion during rapid skips
  const reader = new FileReader();
  reader.onload = () => {
    audio.ctx.decodeAudioData((/** @type {ArrayBuffer} */ (reader.result)).slice(0)).then(buf=>{
      if(tok!==loadToken) return;   // a newer load superseded this one
      decodeFails=0;
      curBuffer=buf; trackDur=buf.duration;
      computeWave(buf);   // build the seek-bar waveform overview once per track
      const off=Math.max(0,Math.min(offset||0, trackDur*0.999));   // resume offset (clamped) for queue restore / seek
      startCtxTime=audio.ctx.currentTime-off;
      srcNode = audio.ctx.createBufferSource();
      srcNode.buffer = buf; srcNode.loop = playlist.length<=1 || state.repeatMode===2;   // single file or repeat-one loops the buffer; a queue auto-advances
      srcGain = audio.ctx.createGain();
      const t = audio.ctx.currentTime;
      srcGain.gain.setValueAtTime(canXfade ? 0 : 1, t);   // fade in from silence during a crossfade, else full
      srcNode.connect(srcGain); srcGain.connect(audio.analyser);
      srcNode.onended = ()=>{ if(playlist.length>1) onTrackEnd(); };   // natural end only — manual stops null the handler first (loop=true suppresses it)
      srcNode.start(0, off); playing=true; isDemo=false; playState();
      if (canXfade) {   // overlap the outgoing + incoming over the crossfade window
        srcGain.gain.linearRampToValueAtTime(1, t + xfd);
        if (outgoing) {
          outgoing.gain.gain.cancelScheduledValues(t); outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, t); outgoing.gain.gain.linearRampToValueAtTime(0, t + xfd);
          outgoing.src.onended = null; try { outgoing.src.stop(t + xfd + 0.1); } catch (e) {}   // stop the outgoing just after the fade completes
        }
        setTimeout(() => { if (xfadeOut === outgoing) xfadeOut = null; }, (xfd + 0.4) * 1000);   // release the in-progress flag once the fade is done
      }
      setTrackName(file.name);
      seekVis(true);
      loadCuesFor(file.name); clearAB(); emit('transport', { type:'seekMarks' }); emit('transport', { type:'wave' });   // reload this track's cues + reset A-B + repaint the waveform
      const meta = parseId3(/** @type {ArrayBuffer} */ (reader.result));   // ID3v2 title/artist/artwork → HUD + (optional) album-art palette
      if (meta) emit('transport', { type:'meta', title: meta.title, artist: meta.artist, picture: meta.picture ? { mime: meta.picture.mime, bytes: meta.picture.data } : null });
      curSourceKey = file.name; emit('transport', { type:'trackLoaded', key: curSourceKey });   // per-track look binding recall
    }).catch(e=>{
      if(tok!==loadToken) return;
      if (canXfade) stopSources();   // a crossfade that failed to decode: hard-stop everything rather than leave the outgoing orphaned
      toast('could not read '+file.name);
      if(playlist.length>1 && ++decodeFails<playlist.length) nextTrack();   // skip a bad file within a queue (bounded)
      else fatal('Could not decode audio: '+e.message);
    });
  };
  reader.readAsArrayBuffer(file);
}
// ---------- URL / stream source (<audio> + MediaElementSource into the analyser) ----------
export function playUrl(url){
  ensureCtx(); stopSources();
  try{
    const audioEl=new Audio();
    audioEl.crossOrigin='anonymous';   // required so the analyser can read the stream (CORS-enabled sources only)
    audioEl.src=url; audioEl.loop=true;   // loop finite URLs; live streams ignore loop
    urlMes=audio.ctx.createMediaElementSource(audioEl); urlMes.connect(audio.analyser);
    urlAudio=audioEl; playlist=[]; curIdx=-1; curBuffer=null; trackDur=0;
    audioEl.play().then(()=>{ playing=true; isDemo=false; playState(); setTrackName(url.length>52?url.slice(0,52)+'…':url); seekVis(false); trackCount(); curSourceKey=url; emit('transport', { type:'trackLoaded', key: curSourceKey }); })
      .catch(()=>{ toast('could not play URL'); stopSources(); });
  }catch(e){ toast('could not play URL'); }
}
// ---------- playlist queue (multi-file / folder) ----------
export function isAudio(f){ return f && (f.type.startsWith('audio') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|aif[f]?)$/i.test(f.name)); }
export function loadFiles(files, idx, offset, skipSave){
  const aud=[...files].filter(isAudio);
  if(!aud.length) return;
  playlist=aud;
  if(!skipSave) idbSaveQueue(aud);   // persist the full queue so a dropped folder survives a refresh
  playIndex(idx||0, offset||0);
}
export function playIndex(i, offset){
  if(!playlist.length) return;
  curIdx=(i+playlist.length)%playlist.length;
  playFile(playlist[curIdx], offset||0); trackCount();
  saveQueuePos(offset||0);   // checkpoint the new track + its resume offset
}
// playIndex variant that overlaps the incoming over a crossfade (DJ-style transition)
function playIndexXfade(i, dur){
  if(!playlist.length) return;
  curIdx=(i+playlist.length)%playlist.length;
  playFile(playlist[curIdx], 0, dur); trackCount(); saveQueuePos(0);
}
function randIdx(){ let r; do{ r=Math.floor(Math.random()*playlist.length); }while(r===curIdx && playlist.length>1); return r; }   // shuffle: a different track than the current one
export function nextTrack(){ if(playlist.length>1) (state.crossfadeOn ? playIndexXfade(state.shuffleOn ? randIdx() : curIdx+1, XFADE) : playIndex(state.shuffleOn ? randIdx() : curIdx+1)); }
export function prevTrack(){ if(playlist.length>1) (state.crossfadeOn ? playIndexXfade(curIdx-1, XFADE) : playIndex(curIdx-1)); }
// pre-roll: if a crossfade is enabled and the current track is near its end, start the next one
// overlapping so the transition is seamless (called every frame from main.js). Respects repeat-off-at-end.
export function checkCrossfade(){
  if(!state.crossfadeOn || xfadeOut || !curBuffer || !audio.ctx || playlist.length<=1) return;
  if(state.repeatMode===0 && !state.shuffleOn && curIdx===playlist.length-1) return;   // let the last linear track end naturally
  const remaining = trackDur - currentElapsed();
  if(remaining > 0.05 && remaining < XFADE && currentElapsed() > 0.5) {
    const ni = state.shuffleOn ? randIdx() : curIdx + 1;
    playIndexXfade(ni, Math.max(0.3, Math.min(XFADE, remaining)));
  }
}
// natural end of a queue track: repeat-one loops via srcNode.loop, repeat-all advances, repeat-off stops after the last linear track
export function onTrackEnd(){ if(playlist.length<=1) return;
  if(state.repeatMode===0 && !state.shuffleOn && curIdx===playlist.length-1){ stopSources(); playing=false; playState(); }
  else nextTrack(); }
// folder-drop traversal (webkitGetAsEntry) — flatten a directory tree into audio Files
function readDirEntries(dir){ return new Promise(res=>{ const rd=dir.createReader(); const all=[]; (function read(){ rd.readEntries(ents=>{ if(!ents.length) return res(all); all.push(...ents); read(); }, ()=>res(all)); })(); }); }
function entryToFile(entry){ return new Promise(res=>entry.file(f=>res(f),()=>res(null))); }
export async function collectEntries(entries){ const out=[];
  async function walk(en){ if(en.isFile){ const f=await entryToFile(en); if(f) out.push(f); } else if(en.isDirectory){ for(const k of await readDirEntries(en)) await walk(k); } }
  for(const en of entries) await walk(en);
  return out.filter(isAudio); }

export function startDemo(){
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
  isDemo=true; playing=true; playState();
  curBuffer=null; seekVis(false);   // demo has no finite timeline
}

export function seekTo(frac){
  if(!curBuffer||!audio.ctx) return;
  stopXfadeOut();
  const off=Math.max(0,Math.min(frac,0.999))*trackDur;
  try{ if(srcNode){ srcNode.onended=null; srcNode.stop(); srcNode.disconnect(); } }catch(e){}
  if(srcGain){ try{srcGain.disconnect();}catch(e){} }
  srcNode=audio.ctx.createBufferSource(); srcNode.buffer=curBuffer; srcNode.loop = playlist.length<=1 || state.repeatMode===2;
  srcGain=audio.ctx.createGain(); srcGain.gain.value=1; srcNode.connect(srcGain); srcGain.connect(audio.analyser);
  srcNode.onended = ()=>{ if(playlist.length>1) onTrackEnd(); };
  startCtxTime=audio.ctx.currentTime-off;   // currentTime is frozen while suspended, so this works paused too
  srcNode.start(0, off);
}

// play-button click logic (lifted verbatim from the former inline handler)
export function togglePlay(){
  if(!audio.ctx){ startDemo(); return; }
  if(playing){ if(urlAudio) urlAudio.pause(); else audio.ctx.suspend(); playing=false; }
  else { if(urlAudio) urlAudio.play(); else if(micSrc) audio.ctx.resume(); else if(!srcNode && playlist.length) playIndex(curIdx); else audio.ctx.resume(); playing=true; }   // URL: toggle the element; mic: resume the ctx; else restart the track if playback stopped at queue end (repeat off)
  playState();
}

// first user gesture: resume the saved queue at its position, else start the demo (browsers require a gesture for audio).
// The restore lookup is async, so unlock the AudioContext synchronously here to capture the user activation, then act
// once the lookup has resolved (restoreReady). This way an early gesture no longer races ahead of the lookup: the
// context is already running when the restored track loads a moment later, so it plays without a second click.
export function onFirstGesture(){
  if(firstGestureHandled) return;
  firstGestureHandled = true;
  ensureCtx();   // resume/create the AudioContext within the gesture; the deferred action below reuses the running context
  restoreReady.then(() => {
    if(pendingRestore){ const r=pendingRestore; pendingRestore=null; loadFiles(r.files, r.idx, r.pos, true); }   // restore the queue at the saved position (skipSave: just read it)
    else startDemo();
  });
}

// repeat button: apply the new repeatMode to the currently-playing buffer source's loop flag
export function applyLoop(){ if(srcNode) srcNode.loop = playlist.length<=1 || state.repeatMode===2; }

export function isPlaying(){ return playing; }
export function isDemoSource(){ return isDemo; }
export function getPlaylist(){ return playlist; }
export function getCurIdx(){ return curIdx; }
export function getTrackDur(){ return trackDur; }
export function hasBuffer(){ return curBuffer!=null; }   // lets main.js's seek guard preserve the former !curBuffer check verbatim
