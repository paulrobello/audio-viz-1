// Orbit + pinch-zoom camera: the per-pointer gesture state and the canvas pointer /
// dblclick listeners that drive it. Lifted verbatim from the former monolith; the gesture
// math (single-pointer orbit, two-pointer orbit + pinch-zoom, the -1.2..1.2 pitch clamp,
// the 0.4..3.5 zoom clamp, setPointerCapture/releasePointerCapture, the mouse left-button
// guard, and the double-click reset) is byte-unchanged. Camera state lives on the exported
// `cam` object and is mutated in place by the handlers; main.js's frame() reads
// cam.yaw/pitch/zoom/active each tick and passes them into renderFrame(). The double-click
// reset emits the 'auto camera' toast via the transport bus (main.js owns the toast UI).
import { emit } from './state.js';

export const cam = { yaw: 0, pitch: 0, zoom: 1, active: false };

// per-pointer gesture state (module-internal)
let dragging = false;          // true while an active gesture is in progress
let lastDX = 0, lastDY = 0;    // previous pointer position (or two-pointer midpoint), for delta math
const pointers = new Map();    // pointerId -> { x, y }
let pinchDist0 = 0;            // previous two-pointer distance, for the pinch-zoom ratio

function updateGesture(isMove){
  const ps=[...pointers.values()];
  if(ps.length<1){ dragging=false; pinchDist0=0; return; }
  cam.active=true; dragging=true;
  if(ps.length>=2){ const a=ps[0],b=ps[1]; const dist=Math.hypot(b.x-a.x,b.y-a.y); const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    if(isMove && pinchDist0>0) cam.zoom=Math.max(0.4,Math.min(3.5, cam.zoom*(dist/pinchDist0)));
    if(isMove){ cam.yaw-=(mx-lastDX)*0.006; cam.pitch=Math.max(-1.2,Math.min(1.2, cam.pitch-(my-lastDY)*0.006)); }
    pinchDist0=dist; lastDX=mx; lastDY=my; }
  else { const p=ps[0]; if(isMove){ cam.yaw-=(p.x-lastDX)*0.008; cam.pitch=Math.max(-1.2,Math.min(1.2, cam.pitch-(p.y-lastDY)*0.008)); } lastDX=p.x; lastDY=p.y; pinchDist0=0; }
}

export function initCamera(canvas){
  canvas.addEventListener('pointerdown', e=>{ if(e.button!==0 && e.pointerType==='mouse') return; pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); try{canvas.setPointerCapture(e.pointerId);}catch(_){} updateGesture(false); });
  canvas.addEventListener('pointermove', e=>{ if(!pointers.has(e.pointerId)) return; pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); updateGesture(true); });
  const endDrag=e=>{ pointers.delete(e.pointerId); try{canvas.releasePointerCapture(e.pointerId);}catch(_){} updateGesture(false); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', ()=>{ cam.active=false; cam.yaw=cam.pitch=0; cam.zoom=1; emit('transport', { type:'toast', msg:'auto camera' }); });
}
