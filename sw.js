const SHELL_CACHE = 'music-archive-shell-50e3dd3cf5b1409a';
const AUDIO_CACHE = 'music-archive-audio-v1';
const APP_ROOT = new URL(self.registration.scope).pathname;
const AUDIO_PATH = /^\/api\/tracks\/[^/]+\/audio$/;
const LOCAL_AUDIO_PREFIX = `${APP_ROOT}offline-audio/`;

self.addEventListener('message', event => {
  if (event.data?.type === 'LIUSHENG_AUDIO_CAPABILITY') event.ports?.[0]?.postMessage({streamVersion:1});
});

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const response = await fetch(APP_ROOT, { credentials: 'same-origin', cache: 'reload' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('App shell unavailable');
    const html = await response.clone().text();
    await cache.put(APP_ROOT, response);
    const diagnosticsUrl = new URL('diagnostics.html', self.registration.scope).href;
    const diagnostics = await fetch(diagnosticsUrl, { credentials: 'same-origin', cache: 'reload' });
    if (!diagnostics.ok || !diagnostics.headers.get('content-type')?.includes('text/html')) throw new Error('Diagnostics page unavailable');
    await cache.put(diagnosticsUrl, diagnostics);
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

async function rangeResponse(full, rangeHeader) {
    const size = Number(full.headers.get('content-length')) || (await full.clone().blob()).size;
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
    if (!full.body) return new Response((await full.blob()).slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
    const reader = full.body.getReader();
    let offset = 0;
    const body = new ReadableStream({
      async pull(controller) {
        while (offset <= end) {
          const {value, done} = await reader.read();
          if (done) { controller.close(); return; }
          const chunkStart = offset;
          offset += value.byteLength;
          if (offset <= start) continue;
          const from = Math.max(0, start - chunkStart);
          const to = Math.min(value.byteLength, end - chunkStart + 1);
          if (to > from) controller.enqueue(value.subarray(from, to));
          if (offset > end) { controller.close(); await reader.cancel(); }
          return;
        }
        controller.close();
      },
      cancel() { return reader.cancel(); },
    });
    return new Response(body, { status: 206, statusText: 'Partial Content', headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;

  if (url.pathname.startsWith(LOCAL_AUDIO_PREFIX)) {
    event.respondWith((async () => {
      const id = url.pathname.slice(LOCAL_AUDIO_PREFIX.length);
      if (!/^[-\w]{1,120}$/.test(id)) return new Response(null, {status:404});
      const cache = await caches.open(AUDIO_CACHE);
      const key = new URL(`/api/tracks/${encodeURIComponent(id)}/audio`, self.location.origin).href;
      const cached = await cache.match(key, {ignoreVary:true});
      if (!cached) return new Response(null, {status:404});
      const range = request.headers.get('Range');
      return range ? rangeResponse(cached, range) : cached;
    })());
    return;
  }

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
      const diagnosticsUrl = new URL('diagnostics.html', self.registration.scope);
      if (url.pathname === diagnosticsUrl.pathname) {
        const cache = await caches.open(SHELL_CACHE);
        try {
          const latest = await fetch(request);
          if (latest.ok && latest.headers.get('content-type')?.includes('text/html')) {
            await cache.put(diagnosticsUrl.href, latest.clone());
            return latest;
          }
        } catch { /* Use the saved diagnostics page when offline. */ }
        return await cache.match(diagnosticsUrl.href) || new Response('诊断页面尚未缓存，请联网打开一次。', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
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
