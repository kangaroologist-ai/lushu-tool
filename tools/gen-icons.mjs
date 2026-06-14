#!/usr/bin/env node
/**
 * gen-icons.mjs — 纯 node 图标生成器(P4.4a)。
 *
 * 零第三方依赖:只用内置 zlib + Buffer 手搓 PNG(IHDR/IDAT/IEND + CRC32)。
 * 确定性:像素颜色全由坐标公式决定,deflate level 固定,禁用 Date / Math.random
 *   ⇒ 多次运行逐字节一致(git 可复现、CI diff 为空)。
 *
 * 产物(写到 ./icons/):
 *   icon-192.png             192x192  any        圆角绿底 + 白色地图针
 *   icon-512.png             512x512  any        同上(大尺寸)
 *   icon-512-maskable.png    512x512  maskable   满铺绿底(无圆角)+ 居中缩小 60% 图形(安全区)
 *   apple-touch-icon-180.png 180x180  iOS 主屏   满铺方角绿底(不透明、无圆角,iOS 自己套圆角)
 *
 * 视觉:品牌绿 #03543C 底 + 白色 teardrop pin(上圆 ∪ 下三角)+ 针孔(底色镂空圆)+
 *   针下白色短折线(路线意象)。判定纯几何 + 1px 软边抗锯齿(alpha 线性混合)。
 *
 * 用法:node tools/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "icons");

/* ---------- 颜色常量(0–255) ---------- */
const GREEN = [3, 84, 60];      // #03543C 品牌绿
const WHITE = [255, 255, 255];

/* ---------- PNG 编码(无依赖) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
/** rgba: Uint8Array length W*H*4 (R,G,B,A row-major) → PNG Buffer (8-bit RGBA) */
function encodePNG(W, H, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression / filter / interlace
  // raw scanlines: each row prefixed with filter byte 0x00
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const ro = y * (1 + W * 4);
    raw[ro] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, ro + 1, y * W * 4, (y + 1) * W * 4)
      : Buffer.from(rgba.buffer, y * W * 4, W * 4).copy(raw, ro + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- 几何画布 ---------- */
/** 在 (x,y) 处把颜色 [r,g,b] 以覆盖度 cov∈[0,1] 混入缓冲(over alpha 合成,底透明) */
function blend(buf, W, x, y, rgb, cov) {
  if (cov <= 0) return;
  if (cov > 1) cov = 1;
  const i = (y * W + x) * 4;
  const da = buf[i + 3] / 255;            // 已有 alpha
  const sa = cov;                          // 源 alpha
  const oa = sa + da * (1 - sa);           // 输出 alpha
  if (oa <= 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
  for (let c = 0; c < 3; c++) {
    const sc = rgb[c], dc = buf[i + c];
    buf[i + c] = Math.round((sc * sa + dc * da * (1 - sa)) / oa);
  }
  buf[i + 3] = Math.round(oa * 255);
}

/* 软边覆盖度:signed distance d(内部为正,单位像素),1px 过渡带 */
const sdfCov = (d) => d <= -0.5 ? 0 : d >= 0.5 ? 1 : d + 0.5;

/**
 * 生成一张图标的 RGBA 缓冲。
 * @param size 边长
 * @param opts.maskable 满铺底、无圆角、图形缩到 60% 安全区
 * @param opts.opaqueSquare 满铺方角不透明底(apple-touch:无圆角、无透明)
 */
function drawIcon(size, opts = {}) {
  const W = size, H = size;
  const buf = Buffer.alloc(W * H * 4); // 全 0 = 透明

  // 圆角半径(any 版 ≈ 18% 边长;maskable / apple 满铺无圆角)
  const corner = (opts.maskable || opts.opaqueSquare) ? 0 : size * 0.18;

  // ① 底:绿色填充 + 圆角软边(maskable/apple 满铺方角)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      let cov = 1;
      if (corner > 0) {
        // 到最近圆角圆心的 signed distance:角内圆心 = (corner,corner) 等四角
        const cx = px < corner ? corner : (px > W - corner ? W - corner : px);
        const cy = py < corner ? corner : (py > H - corner ? H - corner : py);
        const dx = px - cx, dy = py - cy;
        const dist = Math.hypot(dx, dy);
        cov = sdfCov(corner - dist);  // 圆角内=正
      }
      if (cov > 0) blend(buf, W, x, y, GREEN, cov);
    }
  }

  // ② 图形(白色 pin + 针孔 + 路线折线)。坐标在「图形局部归一化空间」算,再映射到画布。
  //    any/apple:图形铺满约 0.86 区域并居中;maskable:整体缩到 0.60 安全区。
  const gscale = opts.maskable ? 0.60 : 0.86;
  const gpx = size * gscale;             // 图形外接尺寸(像素)
  const gx0 = (size - gpx) / 2;          // 图形左上角偏移
  const gy0 = (size - gpx) / 2;

  // pin 几何(局部坐标 0..1 → 乘 gpx + 偏移)。圆心偏上、针尖朝下。
  const R = 0.30 * gpx;                  // 上圆半径
  const cx = gx0 + 0.50 * gpx;           // 针上圆心 x(水平居中)
  const cy = gy0 + 0.40 * gpx;           // 针上圆心 y(偏上)
  const tipY = gy0 + 0.92 * gpx;         // 针尖 y
  const holeR = 0.45 * R;                // 针孔半径
  const lineW = 0.055 * gpx;             // 路线线宽

  // 路线折线两段(针尖下方一点的横折线):p0→p1→p2(局部)
  const ly = gy0 + 0.985 * gpx;          // 路线基线(底部)
  const lx0 = gx0 + 0.18 * gpx, lx1 = gx0 + 0.50 * gpx, lx2 = gx0 + 0.82 * gpx;
  const ly0 = ly, ly1 = ly - 0.10 * gpx, ly2 = ly;
  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    let t = (vx * vx + vy * vy) ? (wx * vx + wy * vy) / (vx * vx + vy * vy) : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  // pin signed distance:max( 上圆 SDF , 三角形 SDF ) 之并(取最大=并集的内部度量近似,逐边裁)
  // 三角形:顶点在圆心两侧切点附近(±R*0.86 在 cy)与针尖(cx,tipY),实现水滴下尖。
  const triApexL = [cx - R * 0.92, cy + R * 0.38];
  const triApexR = [cx + R * 0.92, cy + R * 0.38];
  const triTip = [cx, tipY];
  // 点在三角形内的 signed distance(正=内):取三条边的内侧半平面最小裕度
  const halfPlane = (px, py, ax, ay, bx, by, ix, iy) => {
    // 法向指向内部点 (ix,iy) 的一侧;返回带符号距离(正=内)
    let nx = -(by - ay), ny = (bx - ax);
    const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    const s = (px - ax) * nx + (py - ay) * ny;
    const inside = (ix - ax) * nx + (iy - ay) * ny;
    return inside >= 0 ? s : -s;
  };
  const tcx = (triApexL[0] + triApexR[0] + triTip[0]) / 3;
  const tcy = (triApexL[1] + triApexR[1] + triTip[1]) / 3;
  const triSDF = (px, py) => Math.min(
    halfPlane(px, py, triApexL[0], triApexL[1], triApexR[0], triApexR[1], tcx, tcy),
    halfPlane(px, py, triApexR[0], triApexR[1], triTip[0], triTip[1], tcx, tcy),
    halfPlane(px, py, triTip[0], triTip[1], triApexL[0], triApexL[1], tcx, tcy)
  );

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const circSDF = R - Math.hypot(px - cx, py - cy);   // 上圆内=正
      const pinSDF = Math.max(circSDF, triSDF(px, py));   // 水滴 = 圆 ∪ 三角
      let cov = sdfCov(pinSDF);
      // 路线折线:并入 pin 覆盖
      const dL = Math.min(
        segDist(px, py, lx0, ly0, lx1, ly1),
        segDist(px, py, lx1, ly1, lx2, ly2)
      );
      cov = Math.max(cov, sdfCov(lineW / 2 - dL));
      if (cov > 0) blend(buf, W, x, y, WHITE, cov);
      // 针孔:把 pin 内部圆挖回底色(覆盖度内重新涂绿,形成「针孔」)
      const holeCov = sdfCov(holeR - Math.hypot(px - cx, py - cy));
      if (holeCov > 0) blend(buf, W, x, y, GREEN, holeCov);
    }
  }

  // ③ apple-touch:必须不透明(iOS 不支持透明,会加白底)→ 把任何残余透明像素补绿
  if (opts.opaqueSquare) {
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] < 255) {
        const a = buf[i + 3] / 255;
        for (let c = 0; c < 3; c++) buf[i + c] = Math.round(buf[i + c] * a + GREEN[c] * (1 - a));
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

/* ---------- 生成 ---------- */
mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  { name: "icon-192.png", size: 192, opts: {} },
  { name: "icon-512.png", size: 512, opts: {} },
  { name: "icon-512-maskable.png", size: 512, opts: { maskable: true } },
  { name: "apple-touch-icon-180.png", size: 180, opts: { opaqueSquare: true } },
];

let allOk = true;
for (const t of targets) {
  const rgba = drawIcon(t.size, t.opts);
  const png = encodePNG(t.size, t.size, rgba);
  writeFileSync(join(OUT_DIR, t.name), png);
  // 自检:magic + IHDR 宽高
  const magicOk = png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);  // IHDR data 起于 offset 16
  const dimOk = w === t.size && h === t.size;
  const ok = magicOk && dimOk;
  allOk = allOk && ok;
  console.log(`${ok ? "✓" : "✗"} ${t.name.padEnd(26)} ${png.length} B  magic=${magicOk} IHDR=${w}x${h}`);
}
console.log(allOk ? "OK — 4 个 PNG 全部合法(magic + IHDR 尺寸正确)" : "FAIL — 存在非法 PNG");
process.exit(allOk ? 0 : 1);
