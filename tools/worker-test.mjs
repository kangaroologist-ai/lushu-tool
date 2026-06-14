#!/usr/bin/env node
import worker from "../worker.js";
import { makeSession } from "../functions/_lib/auth.js";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const env = {
  APP_PASSWORD: "good",
  AUTH_SECRET: "secret",
  GH_TOKEN: "github_pat_...",
  GH_BRANCH: "main",
  ASSETS: {
    fetch: async () => new Response("asset-ok")
  }
};

console.log("== worker entry ==");

const bootstrapPage = await worker.fetch(new Request("https://example.test/"), {
  GH_TOKEN: "github_pat_...",
  GH_BRANCH: "main",
  ASSETS: {
    fetch: async () => new Response("asset-ok")
  }
});
assert(bootstrapPage.status === 200 && await bootstrapPage.text() === "asset-ok", "未配置登录 secret 时应保持公开静态访问,便于 bootstrap");

const unauthPage = await worker.fetch(new Request("https://example.test/"), env);
assert(unauthPage.status >= 300 && unauthPage.status < 400 && unauthPage.headers.get("Location").startsWith("/login"), "未登录静态资源应跳登录");

const loginPage = await worker.fetch(new Request("https://example.test/login"), env);
assert(loginPage.status === 200 && (await loginPage.text()).includes("路书登录"), "/login 应返回登录页");

const status = await worker.fetch(new Request("https://example.test/api/status"), env);
const statusJson = await status.json();
assert(status.status === 200 && statusJson.authenticated === false, "/api/status 未登录应可探测");

const token = await makeSession("secret");
const authedPage = await worker.fetch(new Request("https://example.test/", {
  headers: { Cookie: "ukmd_auth=" + token }
}), env);
assert(authedPage.status === 200 && await authedPage.text() === "asset-ok", "已登录静态资源应从 ASSETS 返回");

if (failures) {
  console.error(`✗ ${failures} 项 worker 入口断言失败`);
  process.exit(1);
}
console.log("OK — worker 入口断言通过。");
