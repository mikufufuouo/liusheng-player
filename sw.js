const SHELL_CACHE = 'music-archive-shell-37d4b2af6217cd7a';
const AUDIO_CACHE = 'music-archive-audio-v1';
const APP_ROOT = new URL(self.registration.scope).pathname;
const AUDIO_PATH = /^\/api\/tracks\/[^/]+\/audio$/;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const response = await fetch(APP_ROOT, { credentials: 'same-origin', cache: 'reload' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('App shell unavailable');
    const html = await response.clone().text();
    await cache.put(APP_ROOT, response);
    const assets = new Map();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      try {
        const url = new URL(match[1], self.registration.scope);
        if (url.origin === self.location.origin && /\.(?:js|css|woff2?|ttf|svg)(?:\?|$)/i.test(url.href)) {
          assets.set(url.href, /\.(?:js|css)(?:\?|$)/i.test(url.href));
        }
      } catch { /* ignore malformed or external references */ }
    }
    await Promise.all([...assets].map(async ([url, required]) => {
      try {
        const asset = await fetch(url, { credentials: 'same-origin' });
        if (!asset.ok || asset.headers.get('content-type')?.includes('application/json')) throw new Error(`App asset unavailable: ${url}`);
        await cache.put(url, asset);
      } catch (error) { if (required) throw error; }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('music-archive-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function rangeResponse(full, rangeHeader) {
  return full.blob().then(blob => {
    const size = blob.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!range || (!range[1] && !range[2]) || rangeHeader.includes(',')) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
    }
    let start; let end;
    if (!range[1]) {
      const suffixLength = Number(range[2]);
      if (!suffixLength) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      start = Math.max(0, size - suffixLength); end = size - 1;
    } else {
      start = Number(range[1]); end = range[2] ? Number(range[2]) : size - 1;
    }
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
    end = Math.min(end, size - 1);
    const headers = new Headers(full.headers);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', full.headers.get('Content-Type') || 'audio/mpeg');
    return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;

  if (AUDIO_PATH.test(url.pathname) && url.searchParams.get('sync') !== '1') {
    event.respondWith((async () => {
      const cache = await caches.open(AUDIO_CACHE);
      const cached = await cache.match(new URL(url.pathname, self.location.origin).href);
      if (cached) {
        const range = request.headers.get('Range');
        return range ? rangeResponse(cached, range) : cached;
      }
      return new Response('Song is not saved on this device', {status:404});
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached=await (await caches.open(SHELL_CACHE)).match(APP_ROOT);
      return cached || fetch(request);
    })());
    return;
  }

  if (/\.(?:js|css|woff2?|ttf|svg)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached=await cache.match(request);
      if(cached)return cached;
      const response=await fetch(request);
      if(response.ok && !response.headers.get('content-type')?.includes('application/json'))await cache.put(request,response.clone());
      return response;
    })());
  }
});
