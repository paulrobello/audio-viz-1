// IndexedDB persistence for the playlist queue + playback position (audio blobs exceed
// the 5MB localStorage quota). Lifted verbatim from the original inline script; idbOpen
// stays module-local, the five callers are exported for main.js to import.
const IDB_DB='resomance', IDB_STORE='audio';
function idbOpen(){
  return new Promise((res)=>{
    const r=indexedDB.open(IDB_DB,1);
    r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
    r.onsuccess=()=>res(r.result); r.onerror=()=>res(null);
  });
}
export async function idbGetAudio(){   // legacy single-track cache (fallback for pre-queue installs)
  const db=await idbOpen(); if(!db) return null;
  return new Promise((res)=>{ try{
    const req=db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get('last');
    req.onsuccess=()=>res(req.result||null); req.onerror=()=>res(null);
  }catch(e){ res(null); } finally{ try{db.close();}catch(_){} } });
}
export async function idbSaveQueue(files){
  const db=await idbOpen(); if(!db) return;
  try{ const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put(files.map(f=>({blob:f,name:f.name,type:f.type,size:f.size})),'queue');
    tx.oncomplete=()=>{ try{db.close();}catch(_){} }; tx.onerror=()=>{ try{db.close();}catch(_){} };
  }catch(e){ try{db.close();}catch(_){} }
}
export async function idbGetQueue(){
  const db=await idbOpen(); if(!db) return null;
  return new Promise((res)=>{ try{
    const req=db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get('queue');
    req.onsuccess=()=>{ const a=req.result; res(a&&a.length? a.map(r=>new File([r.blob], r.name||'track', {type:r.type||'audio/*'})) : null); };
    req.onerror=()=>res(null);
  }catch(e){ res(null); } finally{ try{db.close();}catch(_){} } });
}
export async function idbSavePos(obj){
  const db=await idbOpen(); if(!db) return;
  try{ const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put(obj,'pos'); tx.oncomplete=()=>{ try{db.close();}catch(_){} }; tx.onerror=()=>{ try{db.close();}catch(_){} };
  }catch(e){ try{db.close();}catch(_){} }
}
export async function idbGetPos(){
  const db=await idbOpen(); if(!db) return null;
  return new Promise((res)=>{ try{
    const req=db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get('pos');
    req.onsuccess=()=>res(req.result||null); req.onerror=()=>res(null);
  }catch(e){ res(null); } finally{ try{db.close();}catch(_){} } });
}
