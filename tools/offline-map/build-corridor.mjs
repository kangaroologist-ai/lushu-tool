#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT_DIR = join(ROOT, "offline-map");
const HTML_PATH = join(ROOT, "index.html");
const TRIPS_PATH = join(ROOT, "trips.json");
const BUFFER_KM = 10;
const HARD_MAX_BYTES = 80 * 1024 * 1024;
const WARN_BYTES = 60 * 1024 * 1024;
const TARGET_BYTES = 20 * 1024 * 1024;
const CIRCLE_STEPS = 14;
const VERSION_DATE = process.env.OFFLINE_MAP_VERSION || new Date().toISOString().slice(0, 10);

function extractBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  if (s < 0) throw new Error(`missing ${startMark}`);
  const from = s + startMark.length;
  const e = src.indexOf(endMark, from);
  return e < 0 ? src.slice(from) : src.slice(from, e);
}

function parser() {
  const html = readFileSync(HTML_PATH, "utf8");
  const code = extractBetween(html, "/*PARSER-START*/", "/*PARSER-END*/");
  const ctx = vm.createContext({ console });
  new vm.Script(code, { filename: "index.html#parser" }).runInContext(ctx);
  vm.runInContext("this.__parseTrip = parseTrip;", ctx);
  return ctx.__parseTrip;
}

function hasCoord(o) {
  return o && typeof o.lat === "number" && typeof o.lng === "number";
}

function dayPoints(day) {
  const pts = [];
  day.items.forEach((it) => {
    if (hasCoord(it)) pts.push({ lat: it.lat, lng: it.lng, name: it.w, t: it.t, ferry: it.ferry, stay: false });
  });
  if (day.stay && hasCoord(day.stay)) pts.push({ lat: day.stay.lat, lng: day.stay.lng, name: day.stay.h, t: "", ferry: false, stay: true });
  return pts;
}

function prevStayPoint(days, di) {
  for (let i = di - 1; i >= 0; i--) {
    const pts = dayPoints(days[i]);
    if (pts.length) return pts[pts.length - 1];
  }
  return null;
}

function routeChain(days, di) {
  const pts = dayPoints(days[di]).slice();
  const pv = prevStayPoint(days, di);
  if (pv) pts.unshift(pv);
  const dedup = [];
  pts.forEach((p) => {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(last.lat - p.lat) > 1e-4 || Math.abs(last.lng - p.lng) > 1e-4) dedup.push(p);
  });
  const segs = [];
  let chain = [dedup[0]];
  for (let i = 1; i < dedup.length; i++) {
    if (dedup[i].ferry) {
      if (chain.length > 1) segs.push({ pts: chain, sea: false });
      segs.push({ pts: [chain[chain.length - 1], dedup[i]], sea: true });
      chain = [dedup[i]];
    } else {
      chain.push(dedup[i]);
    }
  }
  if (chain.length > 1) segs.push({ pts: chain, sea: false });
  return segs.filter((seg) => seg.pts.every(Boolean));
}

function metersPerLng(lat) {
  return 111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
}

function toXY(p, lat0) {
  return { x: p.lng * metersPerLng(lat0), y: p.lat * 110540 };
}

function fromXY(p, lat0) {
  return [Number((p.x / metersPerLng(lat0)).toFixed(6)), Number((p.y / 110540).toFixed(6))];
}

function segmentPolygon(a, b, km) {
  const lat0 = (a.lat + b.lat) / 2;
  const aa = toXY(a, lat0), bb = toXY(b, lat0);
  const dx = bb.x - aa.x, dy = bb.y - aa.y;
  const len = Math.hypot(dx, dy) || 1;
  const w = km * 1000;
  const nx = -dy / len * w, ny = dx / len * w;
  const ring = [
    fromXY({ x: aa.x + nx, y: aa.y + ny }, lat0),
    fromXY({ x: bb.x + nx, y: bb.y + ny }, lat0),
    fromXY({ x: bb.x - nx, y: bb.y - ny }, lat0),
    fromXY({ x: aa.x - nx, y: aa.y - ny }, lat0)
  ];
  ring.push(ring[0]);
  return ring;
}

function pointCircle(p, km) {
  const lat0 = p.lat;
  const c = toXY(p, lat0);
  const r = km * 1000;
  const ring = [];
  for (let i = 0; i < CIRCLE_STEPS; i++) {
    const a = Math.PI * 2 * i / CIRCLE_STEPS;
    ring.push(fromXY({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }, lat0));
  }
  ring.push(ring[0]);
  return ring;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function feature(geometry, properties) {
  return { type: "Feature", properties, geometry };
}

function colorFor(i) {
  const colors = ["#03543C", "#0D5EAF", "#A34A28", "#6B5B95", "#C8402F", "#20756B", "#8A5A00", "#475569", "#5B7F2A"];
  return colors[i % colors.length];
}

const parseTrip = parser();
const trips = JSON.parse(readFileSync(TRIPS_PATH, "utf8")).trips || [];
const features = [];
const seenLabels = new Set();
const allCoords = [];
let routeKm = 0;
let segmentCount = 0;

for (const trip of trips) {
  const md = readFileSync(join(ROOT, trip.file), "utf8");
  const parsed = parseTrip(md);
  parsed.days.forEach((day, di) => {
    const dayColor = colorFor(di);
    const segs = routeChain(parsed.days, di);
    for (const seg of segs) {
      const coords = seg.pts.map((p) => [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))]);
      features.push(feature(
        { type: "LineString", coordinates: coords },
        { layer: "route_line", trip: trip.id || trip.file, day: day.id, sea: seg.sea, color: seg.sea ? "#1F6FB5" : dayColor }
      ));
      for (let i = 1; i < seg.pts.length; i++) {
        routeKm += haversineKm(seg.pts[i - 1], seg.pts[i]);
        if (!seg.sea) {
          features.push(feature(
            { type: "Polygon", coordinates: [segmentPolygon(seg.pts[i - 1], seg.pts[i], BUFFER_KM)] },
            { layer: "corridor", trip: trip.id || trip.file, day: day.id, bufferKm: BUFFER_KM }
          ));
        }
        segmentCount++;
      }
    }

    for (const p of dayPoints(day)) {
      allCoords.push([p.lng, p.lat]);
      features.push(feature(
        { type: "Polygon", coordinates: [pointCircle(p, BUFFER_KM)] },
        { layer: "corridor", trip: trip.id || trip.file, day: day.id, bufferKm: BUFFER_KM, point: true }
      ));
      const labelKey = `${p.name}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
      if (!seenLabels.has(labelKey)) {
        seenLabels.add(labelKey);
        features.push(feature(
          { type: "Point", coordinates: [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))] },
          { layer: p.stay ? "stay_label" : "place_label", name: p.name, day: day.id, trip: trip.id || trip.file }
        ));
      }
    }
  });
}

const lats = allCoords.map((c) => c[1]);
const lngs = allCoords.map((c) => c[0]);
const pad = BUFFER_KM / 80;
const bbox = [
  Number((Math.min(...lngs) - pad).toFixed(4)),
  Number((Math.min(...lats) - pad).toFixed(4)),
  Number((Math.max(...lngs) + pad).toFixed(4)),
  Number((Math.max(...lats) + pad).toFixed(4))
];

mkdirSync(OUT_DIR, { recursive: true });
const collection = {
  type: "FeatureCollection",
  properties: {
    name: "offline corridor map",
    bufferKm: BUFFER_KM,
    generatedAt: VERSION_DATE,
    source: "Generated from local trip Markdown coordinates; no public raster tiles are cached."
  },
  features
};

const geoPath = join(OUT_DIR, "corridor.geojson");
writeFileSync(geoPath, JSON.stringify(collection));
const bytes = statSync(geoPath).size;
if (bytes > HARD_MAX_BYTES) {
  throw new Error(`offline map package ${bytes} bytes exceeds hard max ${HARD_MAX_BYTES}`);
}

const manifest = {
  version: VERSION_DATE,
  kind: "trip-corridor-geojson",
  bufferKm: BUFFER_KM,
  bbox,
  routeKm: Math.round(routeKm),
  segmentCount,
  featureCount: features.length,
  source: collection.properties.source,
  targetBytes: TARGET_BYTES,
  warnBytes: WARN_BYTES,
  hardMaxBytes: HARD_MAX_BYTES,
  files: [
    { path: "offline-map/corridor.geojson", bytes, role: "leaflet-geojson" }
  ]
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(OUT_DIR, "README.md"), `# Offline Map\n\nGenerated by \`npm run build:offline-map\`.\n\n- Buffer: ${BUFFER_KM} km\n- Route length: ${manifest.routeKm} km\n- Features: ${features.length}\n- Package: ${bytes} bytes\n- Source: ${collection.properties.source}\n\nThis package is a small trip-corridor guide layer for Leaflet. It does not cache CARTO or OpenStreetMap public raster tiles.\n`);

const mb = (bytes / 1024 / 1024).toFixed(2);
const note = bytes > WARN_BYTES ? " WARN over target" : "OK";
console.log(`[offline-map] ${note}: ${features.length} features, ${manifest.routeKm} km route, ${mb} MB -> ${geoPath}`);
