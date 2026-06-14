#!/usr/bin/env node
import { baseUrl, fetchRetry } from "./_prod-http.mjs";

const BASE = baseUrl();

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

let root;
try {
  root = await fetchRetry(BASE + "/", { redirect: "manual", cache: "no-store" });
} catch (err) {
  fail([err.message]);
}

const location = root.headers.get("location") || "";
const authOk = root.status === 302 && location.startsWith("/login");

let statusJson = null;
try {
  const status = await fetchRetry(BASE + "/api/status", { cache: "no-store" });
  if (status.ok) statusJson = await status.json();
} catch (_) {
  statusJson = null;
}

const repoOk = Boolean(statusJson && statusJson.repoConfigured);
if (authOk && repoOk) {
  console.log("OK — 线上 Worker 已启用门禁且 GH_TOKEN 可见; deploy 将使用 --keep-vars 保留 Dashboard 变量。");
  process.exit(0);
}

const missing = [];
if (!authOk) missing.push("APP_PASSWORD/AUTH_SECRET");
if (!repoOk) missing.push("GH_TOKEN");

fail([
  "线上 Worker 当前缺少运行时变量: " + missing.join(", "),
  "先在 Cloudflare Worker lushu 的 Variables and Secrets 中补齐 APP_PASSWORD、AUTH_SECRET、GH_TOKEN。",
  "发布命令必须带 --keep-vars；如果刚刚发布成无门禁版本，先用 wrangler rollback 回到上一版。"
]);
