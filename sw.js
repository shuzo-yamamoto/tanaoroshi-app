/**
 * sw.js — Service Worker(オフライン対応)
 * 画箋堂 棚卸PWA
 *
 * 方針:
 *   - アプリシェル(HTML/CSS/JS/アイコン)はキャッシュ優先 → 完全オフラインで起動可能
 *   - GASへの提出(POST)はキャッシュしない(fetchはそのまま通す)
 *   - バージョン更新時は CACHE_VERSION を上げる → 旧キャッシュを削除
 */
'use strict';

const CACHE_VERSION = 'tanaoroshi-v1.0.3';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/zxing.min.js',
  './js/db.js',
  './js/scanner.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // POST(GAS提出)や外部オリジンはネットワーク直通
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // アプリシェルはキャッシュ優先・裏で更新(stale-while-revalidate)
  e.respondWith(
    caches.match(req).then(cached => {
      const fetched = fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
