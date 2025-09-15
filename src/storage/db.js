// db.js - small IndexedDB helper for storing analysis and metadata
const DB_NAME='vibes-db'; const DB_VERSION=1; const STORE_ANALYSIS='analysis'; const STORE_TRACKS='tracks';

export function openDb(){
  return new Promise((resolve, reject)=>{
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = ()=>{
      const db = r.result;
      if(!db.objectStoreNames.contains(STORE_ANALYSIS)) db.createObjectStore(STORE_ANALYSIS,{keyPath:'id'});
      if(!db.objectStoreNames.contains(STORE_TRACKS)) db.createObjectStore(STORE_TRACKS,{keyPath:'id'});
    }
    r.onsuccess = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error);
  });
}

export async function getAnalysis(id){
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE_ANALYSIS,'readonly');
    const store = tx.objectStore(STORE_ANALYSIS);
    const req = store.get(id);
    req.onsuccess=()=>res(req.result&&req.result.data);
    req.onerror=()=>rej(req.error);
  });
}

export async function putAnalysis(id,data){
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE_ANALYSIS,'readwrite');
    const store = tx.objectStore(STORE_ANALYSIS);
    const req = store.put({id,data,ts:Date.now()});
    req.onsuccess=()=>res(true);
    req.onerror=()=>rej(req.error);
  });
}

export async function putTrackMeta(id,meta){
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE_TRACKS,'readwrite');
    const store = tx.objectStore(STORE_TRACKS);
    const req = store.put({id,meta,ts:Date.now()});
    req.onsuccess=()=>res(true);
    req.onerror=()=>rej(req.error);
  });
}

export async function getTrackMeta(id){
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE_TRACKS,'readonly');
    const store = tx.objectStore(STORE_TRACKS);
    const req = store.get(id);
    req.onsuccess=()=>res(req.result&&req.result.meta);
    req.onerror=()=>rej(req.error);
  });
}
