#!/usr/bin/env node
/**
 * roundtrip-test.mjs — 路书 v2 唯一硬门禁测试脚本(纯 node stdlib,ESM)。
 *
 * 1. 从 index.html 抠出 /*PARSER-START*​/ … /*PARSER-END*​/ 之间的解析器,vm 求值得 parseTrip;
 * 2. 对三个真实 MD 跑 parse 并断言基本结构,打印统计表;
 * 3. 语法门禁:vm.Script 编译 index.html 内所有行内 <script> 块(跳过带 src 的);
 * 4. 若存在 /*SERIALIZER-START*​/ 标记,自动追加 round-trip 断言(3 个真实 MD + broken.md 共 4 件):
 *    a) parse→serialize→parse 深度全等(JSON.stringify 比较,失败时输出首处差异 JSON 路径);
 *    b) serialize 幂等:S(P(S(P(x)))) 与 S(P(x)) 输出字节相等(锁死「规范化只发生一次」);
 * 5. 任何失败 → exit 1;全过 → OK 摘要。
 *
 * 用法:node tools/roundtrip-test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML_PATH = join(ROOT, "index.html");
const MD_FILES = [
  "sample-trip.md",
  "trip-template.md",
];
const MAIN_MD = MD_FILES[0]; // 主方案:额外断言 checklist/notes/linkGroups 非空

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ FAIL: ${msg}`); };
const assert = (cond, msg) => { if (!cond) fail(msg); return !!cond; };

/* ---------- 0. 读 index.html ---------- */
const html = readFileSync(HTML_PATH, "utf8");

/* ---------- 1. 抠解析器 + vm 求值 ---------- */
function extractBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  if (s < 0) return null;
  const from = s + startMark.length;
  const e = endMark ? src.indexOf(endMark, from) : -1;
  return e < 0 ? src.slice(from) : src.slice(from, e);
}

const parserCode = extractBetween(html, "/*PARSER-START*/", "/*PARSER-END*/");
if (parserCode == null) {
  console.error("✗ FATAL: index.html 中找不到 /*PARSER-START*/ … /*PARSER-END*/ 标记");
  process.exit(1);
}

const ctx = vm.createContext({ console });
try {
  new vm.Script(parserCode, { filename: "index.html#parser" }).runInContext(ctx);
  // 函数声明在 vm 顶层不会自动挂到 contextObject,显式取一次
  vm.runInContext(
    "this.__parseTrip = typeof parseTrip === 'function' ? parseTrip : undefined;" +
    "this.__serializeTrip = typeof serializeTrip === 'function' ? serializeTrip : undefined;",
    ctx, { filename: "index.html#export" });
} catch (e) {
  console.error(`✗ FATAL: 解析器代码求值失败 — ${e.message}`);
  process.exit(1);
}
const parseTrip = ctx.__parseTrip;
if (typeof parseTrip !== "function") {
  console.error("✗ FATAL: 解析器块求值后未得到 parseTrip 函数");
  process.exit(1);
}

/* ---------- 2. 三个 MD:parse + 断言 + 统计 ---------- */
console.log("== parse 断言(3 个真实 MD)==");
const rows = [];
const parsed = {}; // file -> {md, T} 供 round-trip 复用
for (const file of MD_FILES) {
  console.log(`-- ${file}`);
  let md;
  try { md = readFileSync(join(ROOT, file), "utf8"); }
  catch (e) { fail(`读文件失败 — ${e.message}`); continue; }

  let T;
  try { T = parseTrip(md); }
  catch (e) { fail(`parseTrip 抛异常 — ${e.stack || e.message}`); continue; }
  parsed[file] = { md, T };

  assert(T && Array.isArray(T.days) && T.days.length > 0, `days.length 应 >0,实际 ${T?.days?.length}`);
  for (const d of T.days || []) {
    assert(Array.isArray(d.items) && d.items.length > 0, `${d.id} items.length 应 >0,实际 ${d.items?.length}`);
  }
  const hasCoord = (o) => o && typeof o.lat === "number" && typeof o.lng === "number";
  const itemCoords = (T.days || []).reduce((n, d) => n + d.items.filter(hasCoord).length, 0);
  const stays = (T.days || []).filter((d) => d.stay).length;
  const stayCoords = (T.days || []).filter((d) => hasCoord(d.stay)).length;
  assert(itemCoords > 0, `含坐标条目数应 >0,实际 ${itemCoords}`);
  if (file === MAIN_MD) {
    assert(T.checklist.length > 0, `主方案 checklist 应非空,实际 ${T.checklist.length}`);
    assert(T.notes.length > 0, `主方案 notes 应非空,实际 ${T.notes.length}`);
    assert(T.linkGroups.length > 0, `主方案 linkGroups 应非空,实际 ${T.linkGroups.length}`);
  }
  const items = (T.days || []).reduce((n, d) => n + d.items.length, 0);
  rows.push({ file, days: T.days.length, items, coords: itemCoords + stayCoords, stays });
  console.log(`  ✓ 天数 ${T.days.length} · 条目 ${items} · 坐标点 ${itemCoords + stayCoords}(条目 ${itemCoords} + 宿 ${stayCoords})· 宿 ${stays}` +
    ` · 清单 ${T.checklist.length} · 须知 ${T.notes.length} · 链接组 ${T.linkGroups.length}`);
}

console.log("\n== 统计表 ==");
console.log("文件                                  天数  条目  坐标点  宿数");
for (const r of rows) {
  console.log(`${r.file.padEnd(34)}  ${String(r.days).padStart(4)}  ${String(r.items).padStart(4)}  ${String(r.coords).padStart(6)}  ${String(r.stays).padStart(4)}`);
}

/* ---------- 3. 语法门禁:编译所有行内 <script> ---------- */
console.log("\n== 语法门禁(index.html 行内 <script>)==");
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, blockNo = 0, inlineNo = 0;
while ((m = SCRIPT_RE.exec(html)) !== null) {
  blockNo++;
  const attrs = m[1] || "";
  if (/\bsrc\s*=/i.test(attrs)) { console.log(`  - 块#${blockNo}: 带 src,跳过`); continue; }
  inlineNo++;
  // 块起始行号,便于定位
  const lineNo = html.slice(0, m.index).split("\n").length;
  try {
    new vm.Script(m[2], { filename: `index.html#script-block-${blockNo}`, lineOffset: lineNo });
    console.log(`  ✓ 块#${blockNo}(起于 ${lineNo} 行,${m[2].length} 字符)编译通过`);
  } catch (e) {
    fail(`块#${blockNo}(起于 ${lineNo} 行)语法错误 — ${e.message}`);
  }
}
assert(inlineNo > 0, "未找到任何行内 <script> 块(提取逻辑或 HTML 结构异常)");

/* ---------- 4. round-trip 扩展点 ---------- */
console.log("\n== round-trip(parse→serialize→parse)==");
let serializeTrip = ctx.__serializeTrip;
if (!serializeTrip && html.includes("/*SERIALIZER-START*/")) {
  // 序列化器在解析器标记之外:单独抠出求值
  const serCode = extractBetween(html, "/*SERIALIZER-START*/", "/*SERIALIZER-END*/");
  try {
    new vm.Script(serCode, { filename: "index.html#serializer" }).runInContext(ctx);
    vm.runInContext("this.__serializeTrip = typeof serializeTrip === 'function' ? serializeTrip : undefined;", ctx);
    serializeTrip = ctx.__serializeTrip;
  } catch (e) {
    fail(`序列化器代码求值失败 — ${e.message}`);
  }
}
/* 失败定位辅助:返回两个 parse 结果第一处差异的 JSON 路径(仅在不全等时调用) */
function firstDiff(a, b, path = "$") {
  if (a === b) return null;
  const ta = Object.prototype.toString.call(a), tb = Object.prototype.toString.call(b);
  if (ta !== tb) return `${path}: 类型 ${ta} vs ${tb}`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(",") !== kb.join(",")) return `${path} 键集/键序: [${ka}] vs [${kb}]`;
    for (const k of ka) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

if (typeof serializeTrip === "function") {
  // broken.md 也纳入全等对象:它含缺年份/乱序/跳号、无功能区块、无 topComment,
  // 验证 serializer 不依赖派生值、不被 warning 干扰、空可选字段不发垃圾行。
  const RT_FILES = [...MD_FILES, "tools/fixtures/broken.md"];
  for (const file of RT_FILES) {
    let md = parsed[file]?.md;
    if (md == null) {
      try { md = readFileSync(join(ROOT, file), "utf8"); }
      catch (e) { fail(`${file} 读文件失败,无法做 round-trip — ${e.message}`); continue; }
    }
    try {
      const T1 = parseTrip(md);
      const a = serializeTrip(T1);
      const T2 = parseTrip(a);
      const j1 = JSON.stringify(T1), j2 = JSON.stringify(T2);
      if (assert(j1 === j2, `${file} round-trip 不全等:parse(serialize(parse(md))) !== parse(md)`)) {
        console.log(`  ✓ ${file} 深度全等`);
      } else {
        console.error(`    首处差异:${firstDiff(T1, T2)}`);
      }
      // 幂等:第一次 serialize 完成全部规范化,第二次必须字节不变
      const b = serializeTrip(parseTrip(a));
      if (assert(a === b, `${file} serialize 非幂等:S(P(S(P(x)))) !== S(P(x))`)) {
        console.log(`  ✓ ${file} serialize 幂等`);
      } else {
        let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
        console.error(`    首处字节差异 @${i}:…${JSON.stringify(a.slice(Math.max(0, i - 30), i + 30))} vs …${JSON.stringify(b.slice(Math.max(0, i - 30), i + 30))}`);
      }
    } catch (e) {
      fail(`${file} round-trip 抛异常 — ${e.stack || e.message}`);
    }
  }
} else {
  console.log("  serializer: 暂未实现,跳过");
}

/* ---------- 4.5 lint 回归:故意写坏的 fixture 必须触发各类黄牌 ---------- */
console.log("\n== lint 回归(tools/fixtures/broken.md)==");
try {
  const broken = readFileSync(join(ROOT, "tools/fixtures/broken.md"), "utf8");
  const W = (parseTrip(broken).warnings || []).join("\n");
  const expect = [
    ["缺年份", /年份锚|缺.*年份/],
    ["缺时区", /缺「?时区/],
    ["时间乱序", /时间乱序/],
    ["缺坐标", /缺坐标/],
    ["编号不连续", /编号不连续|不连续/],
  ];
  for (const [name, re] of expect) {
    assert(re.test(W), `broken.md 应触发「${name}」lint,但 warnings 中未出现(防止解析器改动静默吞掉该类告警)`);
  }
  console.log(`  ✓ 5 类 lint 黄牌全部触发(共 ${parseTrip(broken).warnings.length} 条 warning)`);
} catch (e) {
  fail(`lint 回归读/解析失败 — ${e.message}`);
}

/* ---------- 5. 总结 ---------- */
console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} 项断言失败`);
  process.exit(1);
}
console.log(`OK — ${MD_FILES.length} 个 MD parse 断言全过,${inlineNo} 个行内 <script> 语法门禁通过` +
  (typeof serializeTrip === "function" ? `,round-trip ${MD_FILES.length + 1} 件全等 + 幂等。` : "(serializer 未实现,round-trip 跳过)。"));
