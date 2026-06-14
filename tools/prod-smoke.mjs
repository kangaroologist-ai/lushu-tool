#!/usr/bin/env node
import { baseUrl, fetchRetry } from "./_prod-http.mjs";

const BASE = baseUrl();
const PASSWORD = process.env.APP_PASSWORD || "";
const REQUIRE_REPO = process.env.REQUIRE_REPO === "1";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
}

function cookieFrom(headers) {
  const raw = headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

console.log(`== production smoke: ${BASE} ==`);

const unauth = await fetchRetry(BASE + "/", { redirect: "manual" });
assert(unauth.status >= 300 && unauth.status < 400 && (unauth.headers.get("location") || "").startsWith("/login"), "未登录首页应跳 /login");

const status0 = await fetchRetry(BASE + "/api/status", { cache: "no-store" });
assert(status0.status === 200 || status0.status === 404, "/api/status 应返回 200；404 表示新 Worker 尚未部署");
if (status0.status === 200) {
  const j = await status0.json();
  assert(j.authenticated === false, "未登录 status.authenticated 应为 false");
}

if (PASSWORD) {
  const login = await fetchRetry(BASE + "/api/login", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD, next: "/" })
  });
  const cookie = cookieFrom(login.headers);
  assert(login.status >= 300 && login.status < 400 && cookie.startsWith("ukmd_auth="), "登录应返回跳转和 ukmd_auth cookie");

  const status = await fetchRetry(BASE + "/api/status", { headers: { Cookie: cookie }, cache: "no-store" });
  assert(status.status === 200, "登录后 /api/status 应为 200");
  if (status.status === 200) {
    const j = await status.json();
    assert(j.authenticated === true, "登录后 status.authenticated 应为 true");
    if (REQUIRE_REPO) {
      assert(j.repoConfigured === true && j.repoReachable === true, "远端保存要求 repoConfigured/repoReachable 都为 true");
    }
  }

  const page = await fetchRetry(BASE + "/", { headers: { Cookie: cookie } });
  assert(page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"), "登录后首页应返回 HTML");
} else {
  console.log("  - APP_PASSWORD 未设置，跳过登录后检查。");
}

if (failures) {
  console.error(`✗ ${failures} 项 production smoke 断言失败`);
  process.exit(1);
}
console.log("OK — production smoke 断言通过。");
