#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const listeners = {};
const cache = {
  match: async () => null,
  put: async () => undefined
};

const context = {
  URL,
  Request,
  Response,
  Error,
  Promise,
  setTimeout,
  clearTimeout,
  fetch: async () => new Response("ok", { status: 200 }),
  caches: {
    open: async () => cache,
    match: async () => null,
    keys: async () => []
  },
  self: {
    location: new URL("https://example.test/sw.js"),
    addEventListener(type, cb) {
      listeners[type] = cb;
    }
  }
};
context.globalThis = context;

vm.runInNewContext(readFileSync(join(ROOT, "sw.js"), "utf8"), context, { filename: "sw.js" });

function dispatchFetch(path) {
  const url = /^https?:\/\//.test(path) ? path : "https://example.test" + path;
  let responded = false;
  let responsePromise = null;
  listeners.fetch({
    request: new Request(url),
    respondWith(promise) {
      responded = true;
      responsePromise = Promise.resolve(promise);
    }
  });
  return { responded, responsePromise };
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
}

console.log("== service worker routing ==");
assert(!dispatchFetch("/login").responded, "/login 不应进入离线缓存分流");
assert(!dispatchFetch("/api/status").responded, "/api/status 不应进入离线缓存分流");
assert(!dispatchFetch("/api/save").responded, "/api/save 不应进入离线缓存分流");
assert(!dispatchFetch("https://a.basemaps.cartocdn.com/rastertiles/voyager/6/31/20.png").responded,
  "CARTO 外部瓦片不应被 SW 缓存");

const offlineMap = dispatchFetch("/offline-map/corridor.geojson");
assert(offlineMap.responded, "offline-map/ 同源离线地图包应由 SW network-first/cache 回退处理");
await offlineMap.responsePromise;

const shell = dispatchFetch("/");
assert(shell.responded, "应用壳仍应由 SW network-first 处理");
await shell.responsePromise;

if (failures) {
  console.error(`✗ ${failures} 项 service worker 断言失败`);
  process.exit(1);
}
console.log("OK — service worker 路由断言通过。");
