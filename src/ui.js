// Player chrome + readouts: error banner, bass/mid/treble meters, toast, help modal,
// fullscreen, idle HUD show/hide, play/pause, seek bar, prev/next/shuffle/repeat buttons,
// and the track counter. Lifted verbatim from the former monolith (main.js); the meter
// paint formula, fmtTime, IDLE_MS=10000, fullscreen webkit fallbacks, shuffle/repeat
// persistence + toasts, and seek input/change behavior are byte-unchanged. ui.js owns the
// 'transport' bus subscription (playback.js emits -> ui.js updates the DOM). main.js keeps
// the configuration panels, file/url/drag-drop, and the keydown handler until Task 9; the
// display-key branches of keydown call back into the exports here (toggleHelp/toggleFullscreen/
// toggleHideKey/poke), and two read-only helpers (isHelpOpen/isSeekFocused) cover the help
// modal-swallow and the seek-focus arrow-key guard that remain in main.js's keydown.
import { state, on } from './state.js';
import { audio } from './audio.js';
import * as pb from './playback.js';

const errEl = document.getElementById('err');
export function fatal(msg){ errEl.style.display='block'; errEl.textContent = '⚠ '+msg; console.error(msg); }

// ---------- meters ----------
function buildMeters(el,n){ for(let i=0;i<n;i++) el.appendChild(document.createElement('i')); }
function paintMeter(el,val){ const b=el.children, lit=Math.round(val*14);
  for(let i=0;i<b.length;i++){ const c=/** @type {HTMLElement} */(b[i]); c.style.height=(i<lit?(3+(i/b.length)*23):2)+'px'; c.style.opacity=String(i<lit?1:0.25); } }
export function updateMeters(){
  paintMeter(document.getElementById('mBass'),audio.bands.bass);
  paintMeter(document.getElementById('mMid'),audio.bands.mid);
  paintMeter(document.getElementById('mTreble'),audio.bands.treble);
}

// ---------- toast ----------
const ui=document.getElementById('ui'), hintEl=document.getElementById('hint'), toastEl=document.getElementById('toast');
let toastTimer=null;
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1400); }

// ---------- fullscreen ----------
export function toggleFullscreen(){
  // @ts-expect-error document.webkitFullscreenElement is a legacy Safari-prefixed API absent from the TS DOM lib
  const isFs=document.fullscreenElement||document.webkitFullscreenElement;
  // @ts-expect-error webkitRequestFullscreen is a legacy Safari-prefixed API absent from the TS DOM lib
  if(!isFs){ const rq=document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen;
    if(rq){ try{ const p=rq.call(document.documentElement); if(p&&p.catch) p.catch(()=>{}); toast('fullscreen'); }catch(e){} } }
  // @ts-expect-error webkitExitFullscreen is a legacy Safari-prefixed API absent from the TS DOM lib
  else { const ex=document.exitFullscreen||document.webkitExitFullscreen; if(ex){ try{ ex.call(document); toast('windowed'); }catch(e){} } }
}

// ---------- help modal ----------
const helpEl=document.getElementById('help');
export function toggleHelp(force){ helpEl.classList.toggle('show', force!==undefined?force:!helpEl.classList.contains('show')); }
export function isHelpOpen(){ return helpEl.classList.contains('show'); }

// ---------- idle HUD show/hide ----------
const IDLE_MS=10000;
let idleTimer=null;
function showUI(){ ui.classList.add('show'); hintEl.classList.add('show'); }
function hideUI(){ ui.classList.remove('show'); hintEl.classList.remove('show'); }
export function poke(){ showUI(); clearTimeout(idleTimer); if(state.autoHide) idleTimer=setTimeout(hideUI, IDLE_MS); }
export function toggleHideKey(){
  // manual toggle: hide now and stay hidden until the next pointer/key activity
  if(ui.classList.contains('show')){ hideUI(); clearTimeout(idleTimer); }
  else { poke(); }
}

// ---------- play button ----------
const playBtn=document.getElementById('play');
function updatePlayBtn(){ playBtn.textContent = pb.isPlaying()?'⏸ Pause':'▶ Play'; }
playBtn.addEventListener('click', () => pb.togglePlay());

// ---------- seek bar (file playback only) ----------
const seekRow=document.getElementById('seekRow'), seekEl=/** @type {HTMLInputElement} */(document.getElementById('seek')),
      seekMarks=document.getElementById('seekMarks'),
      curTimeEl=document.getElementById('curTime'), totTimeEl=document.getElementById('totTime');
let seeking=false;
function fmtTime(s){ s=Math.max(0,Math.floor(s||0)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return (h>0? h+':'+String(m).padStart(2,'0') : String(m))+':'+String(sec).padStart(2,'0'); }
function showSeek(on){ seekRow.style.display = on?'flex':'none'; if(on){ totTimeEl.textContent=fmtTime(pb.getTrackDur()); renderSeekMarks(); } }
// paint A-B loop points (gold) + per-track cue markers (cyan, click to jump) over the seek bar
function renderSeekMarks(){
  if(!seekMarks) return;
  seekMarks.innerHTML='';
  const dur=pb.getTrackDur(); if(!dur) return;
  const mk=(frac, cls, cueFrac)=>{
    const d=document.createElement('div'); d.className='seekMark '+cls; d.style.left=(Math.max(0,Math.min(1,frac))*100)+'%';
    if(cls==='cue' && cueFrac!=null){ d.title=fmtTime(cueFrac*dur); d.addEventListener('click',(ev)=>{ ev.stopPropagation(); pb.seekTo(cueFrac); }); }
    seekMarks.appendChild(d);
  };
  const ab=pb.getAB(); if(ab.a>=0) mk(ab.a/dur,'ab'); if(ab.b>=0) mk(ab.b/dur,'ab');
  for(const c of pb.getCues()) mk(c/dur,'cue', c/dur);
}
export function updateSeek(){
  if(!pb.hasBuffer()||!audio.ctx||seeking) return;
  const el=pb.currentElapsed(), dur=pb.getTrackDur();
  seekEl.value=String(Math.round(el/dur*1000));
  curTimeEl.textContent=fmtTime(el);
}
export function isSeekFocused(){ return document.activeElement===seekEl; }
seekEl.addEventListener('input', ()=>{ seeking=true; if(pb.hasBuffer()) curTimeEl.textContent=fmtTime(parseFloat(seekEl.value)/1000*pb.getTrackDur()); });
seekEl.addEventListener('change', ()=>{ if(pb.hasBuffer()) pb.seekTo(parseFloat(seekEl.value)/1000); seeking=false; });

// ---------- prev / next + track counter + shuffle / repeat ----------
const prevBtn=/** @type {HTMLButtonElement} */(document.getElementById('prev')), nextBtn=/** @type {HTMLButtonElement} */(document.getElementById('next')),
      trackCountEl=document.getElementById('trackCount'),
      shufBtn=/** @type {HTMLButtonElement} */(document.getElementById('shuf')), repBtn=/** @type {HTMLButtonElement} */(document.getElementById('rep'));
prevBtn.addEventListener('click', pb.prevTrack);
nextBtn.addEventListener('click', pb.nextTrack);
function updateTrackCounter(){ const pl=pb.getPlaylist(), ci=pb.getCurIdx(); const multi=pl.length>1; trackCountEl.textContent = multi ? (ci+1)+' / '+pl.length : ''; prevBtn.disabled=nextBtn.disabled=shufBtn.disabled=repBtn.disabled=!multi; }
function applyShufUI(){ shufBtn.classList.toggle('on', state.shuffleOn); }
function applyRepUI(){ repBtn.classList.toggle('on', state.repeatMode!==0); repBtn.textContent = state.repeatMode===2 ? '↻1' : '↻'; }
shufBtn.addEventListener('click', ()=>{ state.shuffleOn=!state.shuffleOn; localStorage.setItem('resomance_shuffle', state.shuffleOn?'1':'0'); applyShufUI(); toast(state.shuffleOn?'shuffle on':'shuffle off'); });
repBtn.addEventListener('click', ()=>{ state.repeatMode=(state.repeatMode+1)%3; pb.applyLoop(); localStorage.setItem('resomance_repeat', String(state.repeatMode)); applyRepUI(); toast(['repeat off','repeat all','repeat one'][state.repeatMode]); });

// ---------- boot: wire the rest (init once at app start) ----------
export function initUI(){
  buildMeters(document.getElementById('mBass'),14);
  buildMeters(document.getElementById('mMid'),14);
  buildMeters(document.getElementById('mTreble'),14);
  helpEl.addEventListener('click', e=>{ if(e.target===helpEl) toggleHelp(false); });   // backdrop click closes
  applyShufUI(); applyRepUI();
  poke();
  ['pointermove','pointerdown','wheel','touchstart'].forEach(ev=> window.addEventListener(ev, poke, {passive:true}));
  on('transport', (e) => {
    if (e.type === 'playState') updatePlayBtn();
    else if (e.type === 'trackName') document.getElementById('sub').textContent = e.name;
    else if (e.type === 'seekVisibility') showSeek(e.on);
    else if (e.type === 'seekMarks') renderSeekMarks();
    else if (e.type === 'trackCount') updateTrackCounter();
    else if (e.type === 'toast') toast(e.msg);
    else if (e.type === 'fatal') fatal(e.msg);
  });
}
