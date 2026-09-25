/* Uchat Service Worker（2026-09-25 v2.9.12）
 * 目的只有一个：让"安装到桌面"成立（PWA 必须有 SW），顺带在断网时给个离线兜底页。
 * 策略刻意保守 —— 这是聊天应用，**绝不能给用户看旧版本**：
 *   · 同源 GET 一律**网络优先**：先取网络，成功了就更新缓存并返回网络结果；
 *   · 只有在网络失败（断网）时才回落到缓存；
 *   · /api/、/ws/、/music/、/api/files/ 一律**不拦截**（聊天、上传、听歌、文件必须走网络）；
 *   · POST 等非 GET 请求不拦截。
 * 换版本时改 CACHE 名字即可（旧的会在 activate 里清掉）。
 */
const CACHE = 'uchat-shell-v1';
const SHELL = [
  './', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/favicon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    } catch (err) { /* 离线安装失败不该阻断 */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST/上传不拦
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域不拦
  if (/^\/(api|ws|music)\b/.test(url.pathname)) return;   // 接口 / 实时 / 听歌房音频不拦
  if (url.pathname.startsWith('/api/files')) return;      // 文件下载/预览不拦（要 Range）

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 503, statusText: 'offline' });
    }
  })());
});
