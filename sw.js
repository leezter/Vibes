// sw.js - service worker: cache app shell for offline usage
const CACHE = 'vibes-shell-v2';
const FILES = [
  '/', '/index.html', '/styles/app.css', '/src/main.js', '/src/audio/AudioEngine.js',
  '/src/audio/Deck.js', '/src/audio/Worklets/Timeworklet.js', '/src/analysis/AnalyzerWorker.js',
  '/src/analysis/peaks.js', '/src/storage/db.js', '/src/ui/components/DeckUI.js', '/src/ui/components/MixerUI.js',
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil((async ()=>{
    // delete old caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
