#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(ROOT, "offline-map", "manifest.json");
const indexPath = join(ROOT, "index.html");
const swPath = join(ROOT, "sw.js");
let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
}

console.log("== offline map package ==");
assert(existsSync(manifestPath), "offline-map/manifest.json 应存在");

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  assert(false, "manifest JSON 解析失败: " + err.message);
}

if (manifest) {
  assert(manifest.bufferKm === 10, "bufferKm 应为 10");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest.files 应非空");
  assert(Number(manifest.hardMaxBytes) > 0, "manifest.hardMaxBytes 应存在");
  assert(Number(manifest.featureCount) > 0, "manifest.featureCount 应 > 0");
  let total = 0;
  for (const file of manifest.files || []) {
    const abs = join(ROOT, file.path);
    assert(file.path.startsWith("offline-map/"), `${file.path} 必须在 offline-map/ 下`);
    assert(existsSync(abs), `${file.path} 应存在`);
    if (existsSync(abs)) {
      const size = statSync(abs).size;
      total += size;
      assert(size === file.bytes, `${file.path} manifest bytes=${file.bytes}, 实际=${size}`);
    }
  }
  assert(total > 0, "离线地图总大小应 > 0");
  assert(total <= manifest.hardMaxBytes, `离线地图 ${total} bytes 超过 hardMaxBytes ${manifest.hardMaxBytes}`);
  const geoPath = join(ROOT, "offline-map", "corridor.geojson");
  const geo = JSON.parse(readFileSync(geoPath, "utf8"));
  const layers = new Set((geo.features || []).map((f) => f.properties && f.properties.layer));
  for (const layer of ["corridor", "route_line", "place_label", "stay_label"]) {
    assert(layers.has(layer), `corridor.geojson 应包含 ${layer}`);
  }
  console.log(`  ✓ ${manifest.files.length} 个文件, ${(total / 1024).toFixed(1)} KB, ${manifest.featureCount} features`);
}

const html = readFileSync(indexPath, "utf8");
const p12Start = html.indexOf("P12 10km");
const p12 = p12Start >= 0 ? html.slice(p12Start) : "";
assert(p12.includes('const MAP_CACHE="ukmd-map-v1"'), "页面应使用独立 ukmd-map-v1 cache");
assert(p12.includes("navigator.storage&&navigator.storage.estimate"), "下载前应检查浏览器 storage quota");
assert(p12.includes("usage+total>quota*.85"), "下载前应保留 quota 安全余量");
assert(p12.includes("total>hard"), "下载前应检查 manifest hardMaxBytes");
assert(p12.includes("done>hard"), "下载过程中应检查累计大小不超过 hardMaxBytes");
assert(p12.includes("Math.abs(blob.size-f.bytes)>Math.max(2048,f.bytes*.02)"), "下载文件应按 manifest bytes 校验大小");
assert(p12.includes("caches.delete(MAP_CACHE)"), "清除按钮应只删除地图 cache");
const filePut = p12.indexOf("await c.put(f.path");
const manifestPut = p12.indexOf("await c.put(MAP_MANIFEST");
assert(filePut >= 0 && manifestPut > filePut, "manifest 应在所有地图文件写入成功后再落 cache");

const sw = readFileSync(swPath, "utf8");
const precacheLocal = sw.match(/const PRECACHE_LOCAL = \[([\s\S]*?)\];/);
assert(precacheLocal && !precacheLocal[1].includes("offline-map/"), "offline-map/ 不应在 install 阶段自动预缓存");
assert(sw.includes('const MAP_CACHE = "ukmd-map-v1"'), "SW 应使用独立固定地图 cache(ukmd-map-v1,不随 SW_VERSION 失效,与 index.html 对齐)");
assert(sw.includes('path.startsWith("/offline-map/")') && sw.includes("networkFirst(req, MAP_CACHE)"),
  "SW 应只对同源 offline-map/ 使用地图 cache");
assert(sw.includes("TILE_HOST_RE.test(host)) return"), "SW 应保持外部 CARTO 瓦片 network-only");

if (failures) {
  console.error(`✗ ${failures} 项 offline map 断言失败`);
  process.exit(1);
}
console.log("OK — offline map 包体与储存策略断言通过。");
