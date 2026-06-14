/* sw.js — 路书 v2 离线壳 Service Worker(P4.4c)。
 *
 * 离线目标(已确认收窄到一条):行程面板完整可读。
 *   预缓存 = 应用壳(HTML/兜底 JS)+ 行程清单/三个 MD + 图标 + manifest + CDN 库(leaflet/suncalc/fonts CSS)。
 *   运行时矩阵(见下 fetch 分流):
 *     ① 本地数据 .md / trips.json   → network-first 回退 cache(在线拿最新、离线读缓存)
 *     ② 应用壳 / 导航请求            → network-first 回退 cache(绝不 cache-first,防旧 HTML 钉死)
 *     ③ 第三方库 CDN(cdnjs/fonts)  → cache-first(版本固定;gstatic woff2 顺带落缓存)
 *     ④ 地图瓦片 basemaps.cartocdn  → network-only,绝不进缓存(离线时由同源 offline-map/ 小包兜底)
 *     ⑤ 外部 API(天气/OSRM/Photon/Nominatim/geocoding) → network-only(各自 localStorage 层管理)
 *     ⑥ 同源 offline-map/        → network-first 回退 cache;不在 install 自动预缓存,只由用户显式下载
 *     兜底:其余同源静态(icons/manifest) → cache-first 回退 network
 *
 * 三道硬守卫(评审修复):
 *   a. 落缓存一律过 cacheable():ok && !redirected && 终点路径=请求路径——Cloudflare Access 会话过期时
 *      302→登录页(follow 后 200)不得污染/覆盖缓存(install 预缓存与运行时 put 同口径);
 *   b. networkFirst 失败回退先查本 cache 再 caches.match 跨 cache 全局查——预缓存在 SHELL_CACHE 的
 *      MD/trips.json 在「装完即离线」(RUNTIME 还空)场景也读得到;
 *   c. networkFirst 的 fetch 带 6s 超时(Promise.race)——弱网半开下先于页面 fetchTO(8s)回缓存,
 *      导航请求也不再挂到浏览器分钟级超时。
 *
 * 注册 scope = 站点根("/");fetch 拦截只在 http(s) 生效——file:// 双击不注册 SW,走页面三级降级。
 *
 * 版本策略:CACHE 名带版本常量,改 SW_VERSION 即整代失效;activate 只清自己命名空间(ukmd- 前缀)的旧版。
 *   不在 install 里无条件 skipWaiting(壳走 network-first,新版 HTML 下次在线导航自然生效,
 *   新 SW 在旧页面全部关闭后接管);activate 里 clients.claim() 让首装无需刷新即接管。
 */
const SW_VERSION = "v1";
const SHELL_CACHE = `ukmd-shell-${SW_VERSION}`;     // 壳 + CDN + 图标 + manifest(install 写入)
const RUNTIME_CACHE = `ukmd-runtime-${SW_VERSION}`; // 运行时 network-first/cache-first 落的本地数据
const MAP_CACHE = "ukmd-map-v1";                    // P12 用户显式下载的离线地图包:独立固定名,不随 SW_VERSION 整代失效(壳升级不清用户已下载的地图;与 index.html/README 的 ukmd-map-v1 对齐)

/* ---------- 预缓存清单 ---------- */
// 同源壳资源(路径相对 SW 注册根 = 站点根)。中文名 .md 必须 encodeURI() 包裹,与 fetch 请求 URL 形态一致才命中。
const PRECACHE_LOCAL = [
  "./",
  "./index.html",
  "./trip.data.js",
  "./trips.json",
  encodeURI("./sample-trip.md"),
  encodeURI("./trip-template.md"),
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon-180.png",
];
// 跨源 CDN(全部实测 ACAO:* 可 cors 预缓存)。gstatic woff2 不列此(URL 随 UA 变,运行时 cache-first 落缓存)。
const PRECACHE_CDN = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/suncalc/1.9.0/suncalc.min.js",
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap",
];

/* ---------- host 分类 ---------- */
const CDN_HOSTS = ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOST_RE = /(^|\.)basemaps\.cartocdn\.com$/i;
const API_HOSTS = [
  "api.open-meteo.com", "archive-api.open-meteo.com", "geocoding-api.open-meteo.com",
  "photon.komoot.io", "nominatim.openstreetmap.org",
  "router.project-osrm.org", "routing.openstreetmap.de",
];

/* ---------- install:逐项预缓存(allSettled 容错:单项失败不让 install 整体 reject) ---------- */
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 本地资源:不用 cache.add(它只看 ok,Cloudflare Access 会话过期时 302→登录页 follow 后 200,
    // 会把登录 HTML 预缓存成壳/MD)。显式 fetch + cacheable() 守卫,重定向产物一律不进缓存。
    await Promise.allSettled(PRECACHE_LOCAL.map(async (u) => {
      const res = await fetch(u, { cache: "no-cache" });
      if (cacheable(res, new URL(u, self.location.href).href)) await cache.put(u, res.clone());
      else throw new Error("precache rejected: " + u);
    }));
    // 跨源 CDN:显式 cors 请求 + cacheable 守卫(避免缓存 opaque/404/重定向产物)
    await Promise.allSettled(PRECACHE_CDN.map(async (u) => {
      const res = await fetch(u, { mode: "cors" });
      if (cacheable(res, u)) await cache.put(u, res.clone());
      else throw new Error("CDN not ok: " + u);
    }));
  })());
});

/* ---------- activate:清自己命名空间的旧版缓存 + 接管页面 ---------- */
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("ukmd-") && k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== MAP_CACHE)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- 工具:network-first / cache-first ---------- */
// 可缓存判定:仅 200-ok、未经历重定向、且最终 URL 路径与请求路径一致的响应才允许落缓存。
// 防 Cloudflare Access 会话过期(P4.1 已开启,会话 1 个月):.md/trips.json/导航被 302 到登录页,
// fetch 默认 follow 后拿到 200 的登录 HTML——只判 res.ok 会把它写进缓存,覆盖之前缓存好的行程内容。
function cacheable(res, reqUrl) {
  if (!res || !res.ok || res.redirected) return false;
  try {
    if (res.url && new URL(res.url).pathname !== new URL(reqUrl).pathname) return false;
  } catch (_) {}
  return true;
}
// 带超时 fetch:弱网半开(captive portal/高地信号,页面侧 fetchTO 注释点名的场景)下 fetch 可挂分钟级;
// 6s 必 reject 让缓存回退走得到,且 < 页面侧 fetchTO 的 8s AbortController——SW 先回缓存,页面不至于先 abort。
// 用 Promise.race 而非给 req 重建 signal:导航 Request 不可带 init 重建,race 对所有请求形态安全。
const NET_TIMEOUT_MS = 6000;
function fetchTimeout(req, ms) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("sw-timeout")), ms || NET_TIMEOUT_MS);
  });
  return Promise.race([fetch(req), gate]).finally(() => clearTimeout(timer));
}
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetchTimeout(req, NET_TIMEOUT_MS);
    if (cacheable(res, req.url)) cache.put(req, res.clone());   // 仅缓存 ok 且非重定向产物
    return res;
  } catch (e) {
    // 先查本 cache(RUNTIME 较新),再 caches.match 跨 cache 全局兜底:install 预缓存的 MD/trips.json
    // 落在 SHELL_CACHE,而首访的页面 fetch 发生在 SW 受控前、RUNTIME 为空——「装完即离线」必须读得到预缓存。
    const hit = await cache.match(req) || await caches.match(req);
    if (hit) return hit;
    // 导航请求离线兜底:回壳缓存的 index.html(start_url 与 index.html 等价)
    const shell = await caches.open(SHELL_CACHE);
    const idx = await shell.match("./index.html") || await shell.match("./");
    if (idx && req.mode === "navigate") return idx;
    return new Response("离线且无缓存", { status: 503, statusText: "Offline" });
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req, req.mode === "cors" || new URL(req.url).origin !== self.location.origin
    ? { mode: "cors" } : undefined);
  if (cacheable(res, req.url)) cache.put(req, res.clone());
  return res;
}

/* ---------- fetch 分流 ---------- */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                  // 只处理 GET,其余透传(浏览器默认)

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;  // 非 http(s)(chrome-extension 等)透传

  const host = url.hostname;
  const sameOrigin = url.origin === self.location.origin;

  // ④ 地图瓦片:network-only,显式短路,绝不缓存(防被 ③/默认逻辑误缓存)
  if (TILE_HOST_RE.test(host)) return;               // 不调 respondWith → 浏览器原生网络,SW 不介入

  // ⑤ 外部 API:network-only(各自 localStorage 层管理,SW 不双层缓存)
  if (API_HOSTS.includes(host)) return;

  // ③ 第三方库 CDN:cache-first(gstatic woff2 走此分支顺带落缓存)
  if (CDN_HOSTS.includes(host)) {
    e.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  if (sameOrigin) {
    const path = url.pathname;
    // P9 口令门禁/API 响应不进离线壳缓存;登录页始终走网络,避免被运行时缓存留成旧状态。
    if (path === "/login" || path.startsWith("/api/")) return;
    // P12 同源离线地图包:不自动预缓存,但一旦用户下载过,离线时可回退 cache。
    if (path.startsWith("/offline-map/")) {
      e.respondWith(networkFirst(req, MAP_CACHE));
      return;
    }
    const isNav = req.mode === "navigate";
    const isShell = isNav || path === "/" || /\/index\.html$/i.test(path) || /\/trip\.data\.js$/i.test(path);
    const isData = /\.md$/i.test(path) || /\/trips\.json$/i.test(path);
    // ② 应用壳(含 trip.data.js 兜底)/ 导航 与 ① 本地数据 .md/trips.json:network-first 回退 cache
    // trip.data.js 必须 network-first:它是壳的一部分,cache-first 会被装机时的旧版钉死、服务器更新永不到达
    if (isShell || isData) {
      e.respondWith(networkFirst(req, isData ? RUNTIME_CACHE : SHELL_CACHE));
      return;
    }
    // 兜底:其余同源静态(icons/*.png、manifest)cache-first 回退 network
    e.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // 其它跨源(理论上不该出现):透传网络,失败则失败,不缓存
  e.respondWith(fetch(req).catch(() => new Response("", { status: 502 })));
});
