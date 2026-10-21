/* GoMarket — service worker. Fichier générique, sans donnée de marché.
   SHELL_VERSION doit rester identique à GM_SHELL_VERSION dans shell/nav.js.
   Le nom de cache publié est gomarket-shell-<version>. La page chiffrée est
   rangée à part : gomarket-shell-<version>-page-<identifiant de build>. */
'use strict';

var SHELL_VERSION = '1';
var CACHE_FAMILY = 'gomarket-shell-' + SHELL_VERSION;
var STATIC_CACHE = CACHE_FAMILY + '-static';
var PAGE_PREFIX = CACHE_FAMILY + '-page-';
var META_NAME = 'gm-cache-meta.json';
var PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './assets/lightweight-charts-5.2.1.standalone.production.js'
];

function scopeUrl(path) {
  return new URL(path, self.registration.scope);
}

function metaUrl() {
  return scopeUrl('./' + META_NAME);
}

function extractBuildId(text) {
  var match = String(text || '').match(/\bB="([^"]*)"/);
  return match && match[1] ? match[1] : '';
}

function isMetaRequest(url) {
  return url.pathname.slice(-META_NAME.length) === META_NAME;
}

function isPageRequest(req, url) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  var path = url.pathname;
  return path.charAt(path.length - 1) === '/' || path.slice(-11) === '/index.html';
}

function isStaticAsset(url) {
  return /\.(?:webmanifest|png|js|css|svg|ico|woff2?)$/i.test(url.pathname);
}

async function writeMeta(meta) {
  var cache = await caches.open(STATIC_CACHE);
  await cache.put(metaUrl(), new Response(JSON.stringify(meta), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function readMeta() {
  try {
    var hit = await caches.match(metaUrl().href);
    if (!hit) return null;
    return await hit.json();
  } catch (e) {
    return null;
  }
}

async function deleteOldPageCaches(buildId) {
  var keep = PAGE_PREFIX + buildId;
  var keys = await caches.keys();
  await Promise.all(keys.map(function (name) {
    if (name.indexOf(PAGE_PREFIX) === 0 && name !== keep) return caches.delete(name);
    return null;
  }));
}

async function storePage(response, buildId) {
  var id = buildId || 'unknown';
  var cache = await caches.open(PAGE_PREFIX + id);
  var page = response.clone();
  var root = response.clone();
  await cache.put(scopeUrl('./index.html'), page);
  await cache.put(scopeUrl('./'), root);
  await writeMeta({
    cachedAt: new Date().toISOString(),
    buildId: id,
    shell: SHELL_VERSION,
    fromCache: false
  });
  await deleteOldPageCaches(id);
}

async function cachedPage(req) {
  var keys = await caches.keys();
  var names = keys.filter(function (name) { return name.indexOf(PAGE_PREFIX) === 0; });
  names.sort();
  for (var i = names.length - 1; i >= 0; i--) {
    var cache = await caches.open(names[i]);
    var hit = await cache.match(req, { ignoreSearch: true });
    if (!hit) hit = await cache.match(scopeUrl('./index.html').href);
    if (!hit) hit = await cache.match(scopeUrl('./').href);
    if (hit) return hit;
  }
  return null;
}

async function networkFirstDocument(req) {
  try {
    var net = await fetch(req, { cache: 'no-store' });
    if (!net || !net.ok) throw new Error('status');
    var text = await net.clone().text();
    await storePage(net.clone(), extractBuildId(text) || 'unknown');
    return net;
  } catch (e) {
    var hit = await cachedPage(req);
    if (hit) {
      var prev = await readMeta();
      var meta = prev || { shell: SHELL_VERSION };
      meta.fromCache = true;
      if (!meta.cachedAt) meta.cachedAt = null;
      try { await writeMeta(meta); } catch (err) {}
      return hit;
    }
    return new Response('Hors ligne', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirst(req) {
  var cache = await caches.open(STATIC_CACHE);
  var hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  var net = await fetch(req);
  if (net && net.ok) {
    try { await cache.put(req, net.clone()); } catch (e) {}
  }
  return net;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(STATIC_CACHE);
    for (var i = 0; i < PRECACHE.length; i++) {
      try {
        var url = scopeUrl(PRECACHE[i]);
        var res = await fetch(url, { cache: 'no-cache' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) {}
    }
    try {
      var page = await fetch(scopeUrl('./index.html'), { cache: 'no-store' });
      if (page && page.ok) {
        var copy = page.clone();
        var text = await page.text();
        await storePage(copy, extractBuildId(text) || 'unknown');
      }
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    var hasPage = keys.some(function (name) { return name.indexOf(PAGE_PREFIX) === 0; });
    await Promise.all(keys.map(function (name) {
      if (name === STATIC_CACHE) return null;
      if (name.indexOf(PAGE_PREFIX) === 0) return null;
      if (!hasPage && name.indexOf('-page-') !== -1 && name.indexOf('gomarket-') === 0) return null;
      return caches.delete(name);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (isMetaRequest(url)) {
    event.respondWith((async function () {
      var hit = await caches.match(metaUrl().href);
      if (hit) return hit;
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    })());
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (isPageRequest(req, url) || !/\.[a-z0-9]+$/i.test(url.pathname)) {
    event.respondWith(networkFirstDocument(req));
  }
});
