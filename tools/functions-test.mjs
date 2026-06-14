#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSession, verifySession } from "../functions/_lib/auth.js";
import { sha256Hex } from "../functions/_lib/github.js";
import { wrapTripData } from "../functions/_lib/trip-data.js";
import { onRequest as middleware } from "../functions/_middleware.js";
import { onRequestPost as savePost } from "../functions/api/save.js";
import { onRequestGet as statusGet } from "../functions/api/status.js";
import { onRequestPost as loginPost } from "../functions/api/login.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
};

console.log("== functions helpers ==");

const md = readFileSync(join(ROOT, "sample-trip.md"), "utf8");
const expected = readFileSync(join(ROOT, "trip.data.js"), "utf8");
assert(wrapTripData(md) === expected, "wrapTripData 输出应与 trip.data.js 一致");

for (const bad of ["# Bad`\n", "# Bad ${x}\n"]) {
  let threw = false;
  try { wrapTripData(bad); } catch (_) { threw = true; }
  assert(threw, "wrapTripData 应拒绝不安全模板内容");
}

const h1 = await sha256Hex("abc");
assert(h1 === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256Hex abc");

const token = await makeSession("secret", 1000);
assert(await verifySession(token, "secret", 1001), "session 应可验证");
assert(!(await verifySession(token, "wrong", 1001)), "错误 secret 不应通过");
assert(!(await verifySession(token, "secret", 1000 + 180 * 24 * 60 * 60 + 1)), "过期 session 不应通过");

const statusReq = new Request("https://example.test/api/status", { headers: { Cookie: "ukmd_auth=" + await makeSession("secret") } });
const statusPlaceholder = await statusGet({ request: statusReq, env: { AUTH_SECRET: "secret", GH_TOKEN: "github_pat_...", GH_BRANCH: "main" } });
assert((await statusPlaceholder.json()).repoConfigured === false, "占位 GH_TOKEN 不应视为已配置");
{
  const oldFetch = globalThis.fetch;
  let checkedTrips = false;
  globalThis.fetch = async (url) => {
    checkedTrips = String(url).includes("/contents/trips.json");
    return jsonResponse({ content: b64(readFileSync(join(ROOT, "trips.json"), "utf8")) });
  };
  try {
    const statusRealish = await statusGet({ request: statusReq, env: {
      AUTH_SECRET: "secret",
      GH_TOKEN: "github_pat_test",
      GH_OWNER: "your-org",
      GH_REPO: "test-repo",
      GH_BRANCH: "main"
    } });
    const statusRealishJson = await statusRealish.json();
    assert(statusRealishJson.authenticated === true && statusRealishJson.repoConfigured === true, "有效形态 GH_TOKEN 应显示远端保存能力");
    assert(statusRealishJson.repoReachable === true && checkedTrips, "已登录且 token 配置后应只读检查 trips.json");
  } finally {
    globalThis.fetch = oldFetch;
  }
}

const badLogin = await loginPost({
  request: new Request("https://example.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=bad"
  }),
  env: { APP_PASSWORD: "good", AUTH_SECRET: "secret" }
});
assert(badLogin.status === 401, "表单口令错误应返回 401");

const goodLogin = await loginPost({
  request: new Request("https://example.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=good"
  }),
  env: { APP_PASSWORD: "good", AUTH_SECRET: "secret" }
});
const loginCookie = goodLogin.headers.get("Set-Cookie") || "";
assert(goodLogin.status >= 300 && goodLogin.status < 400, "表单口令正确应重定向");
assert(loginCookie.includes("ukmd_auth=") && loginCookie.includes("Max-Age=15552000") && /Expires=/i.test(loginCookie),
  "登录 cookie 应为持久 cookie(Max-Age + Expires)");

const freshToken = await makeSession("secret");
const authedLogin = await middleware({
  request: new Request("https://example.test/login", { headers: { Cookie: "ukmd_auth=" + freshToken } }),
  env: { AUTH_SECRET: "secret" },
  next: () => new Response("next")
});
assert(authedLogin.status >= 300 && authedLogin.status < 400 && authedLogin.headers.get("Location") === "/", "已登录访问 /login 应回首页");

const protectedPage = await middleware({
  request: new Request("https://example.test/index.html"),
  env: { AUTH_SECRET: "secret" },
  next: () => new Response("next")
});
assert(protectedPage.status >= 300 && protectedPage.status < 400 && protectedPage.headers.get("Location").startsWith("/login"), "未登录访问页面应跳登录");

function b64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function callSave(body, { remoteMd = md, mockStatus = 200 } = {}) {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/contents/trips.json")) {
      return jsonResponse({ content: b64(readFileSync(join(ROOT, "trips.json"), "utf8")) }, mockStatus);
    }
    if (u.includes("/contents/")) {
      return jsonResponse({ content: b64(remoteMd) }, mockStatus);
    }
    if (u.includes("/git/ref/heads/main")) {
      return jsonResponse({ object: { sha: "head-sha" } }, mockStatus);
    }
    if (u.includes("/git/commits/head-sha")) {
      return jsonResponse({ tree: { sha: "tree-sha" } }, mockStatus);
    }
    if (u.includes("/git/trees")) {
      return jsonResponse({ sha: "new-tree" }, mockStatus);
    }
    if (u.includes("/git/commits")) {
      return jsonResponse({ sha: "commit-sha-1234567890" }, mockStatus);
    }
    if (u.includes("/git/refs/heads/main")) {
      return jsonResponse({ object: { sha: "commit-sha-1234567890" } }, mockStatus);
    }
    return jsonResponse({ message: "unexpected " + u }, 404);
  };
  try {
    const auth = await makeSession("secret");
    const req = new Request("https://example.test/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "ukmd_auth=" + auth },
      body: JSON.stringify(body)
    });
    const res = await savePost({ request: req, env: {
      AUTH_SECRET: "secret",
      GH_TOKEN: "github_pat_test",
      GH_OWNER: "your-org",
      GH_REPO: "test-repo",
      GH_BRANCH: "main"
    } });
    return { res, data: await res.json(), calls };
  } finally {
    globalThis.fetch = oldFetch;
  }
}

const changedMd = md.replace("示例", "示例测试");
const okSave = await callSave({
  file: "sample-trip.md",
  md: changedMd,
  baseHash: await sha256Hex(md)
});
assert(okSave.res.status === 200 && okSave.data.ok, "/api/save 主方案成功响应");
const treeCall = okSave.calls.find(c => c.url.includes("/git/trees"));
const treeBody = treeCall && JSON.parse(treeCall.init.body);
assert(treeBody && treeBody.tree.some(x => x.path === "sample-trip.md"), "主方案 commit 应包含 MD");
assert(treeBody && treeBody.tree.some(x => x.path === "trip.data.js" && x.content === wrapTripData(changedMd)), "主方案 commit 应同步 trip.data.js");
const refCall = okSave.calls.find(c => c.url.includes("/git/refs/heads/main"));
assert(refCall && JSON.parse(refCall.init.body).force === false, "update ref 必须 force:false");

const noChange = await callSave({
  file: "sample-trip.md",
  md,
  baseHash: await sha256Hex(md)
});
assert(noChange.res.status === 200 && noChange.data.ok && noChange.data.noChange, "/api/save 内容未变应 noChange");
assert(!noChange.calls.some(c => c.url.includes("/git/trees")), "内容未变不得创建 tree/commit");

const conflict = await callSave({
  file: "trip-template.md",
  md: changedMd,
  baseHash: "0".repeat(64)
}, { remoteMd: readFileSync(join(ROOT, "trip-template.md"), "utf8") });
assert(conflict.res.status === 409 && conflict.data.error === "conflict", "/api/save hash 不一致应 409");
assert(!conflict.calls.some(c => c.url.includes("/git/trees")), "冲突时不得创建 tree/commit");

const badPath = await callSave({ file: "../x.md", md: "# x", baseHash: "0".repeat(64) });
assert(badPath.res.status === 400 && badPath.calls.length === 0, "非法路径应先拒绝且不访问 GitHub");

if (failures) {
  console.error(`✗ ${failures} 项 functions helper 断言失败`);
  process.exit(1);
}
console.log("OK — functions helper 断言通过。");
