#!/usr/bin/env node
// gen-fallback.mjs — 从主方案 MD 再生 trip.data.js 兜底文件
//
// 用法: node tools/gen-fallback.mjs [输入md] [输出js]
// 缺省: sample-trip.md → trip.data.js
//
// 输出结构(与现有 trip.data.js 首尾一致):
//   window.TRIP_MD = String.raw`
//   <MD 内容>
//   `;
//
// 硬约束:String.raw 包装意味着内容里绝不能出现反引号 ` 或 ${,
// 违例直接报错退出并指出行号。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const inputPath = resolve(projectRoot, process.argv[2] ?? 'sample-trip.md');
const outputPath = resolve(projectRoot, process.argv[3] ?? 'trip.data.js');

let md;
try {
  md = readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`[gen-fallback] 读取失败: ${inputPath}\n${err.message}`);
  process.exit(1);
}

// —— 校验:String.raw 模板字面量的硬约束 ——
const BACKTICK = '`';
const violations = [];
md.split('\n').forEach((line, i) => {
  if (line.includes(BACKTICK)) {
    violations.push(`第 ${i + 1} 行: 含反引号 (${BACKTICK})`);
  }
  if (line.includes('${')) {
    violations.push(`第 ${i + 1} 行: 含模板插值序列 \${`);
  }
});
if (violations.length > 0) {
  console.error(`[gen-fallback] 校验失败 — ${inputPath} 不能安全嵌入 String.raw 模板:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}

// —— 生成 ——
const body = md.endsWith('\n') ? md : md + '\n';
const out = 'window.TRIP_MD = String.raw' + BACKTICK + '\n' + body + BACKTICK + ';\n';

writeFileSync(outputPath, out, 'utf8');
console.log(`[gen-fallback] OK: ${inputPath} → ${outputPath} (${Buffer.byteLength(out)} 字节)`);
