#!/usr/bin/env node
import { baseUrl, fetchRetry } from "./_prod-http.mjs";

const BASE = baseUrl();
const PASSWORD = process.env.APP_PASSWORD || "";
const FILE = process.env.TEST_FILE || "trip-template.md";

if (!PASSWORD) {
  console.error("APP_PASSWORD required");
  process.exit(1);
}

const enc = new TextEncoder();
async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieFrom(headers) {
  const raw = headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function save(cookie, body) {
  const res = await fetchRetry(BASE + "/api/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

console.log(`== production writeback smoke: ${BASE} :: ${FILE} ==`);

const login = await fetchRetry(BASE + "/api/login", {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD, next: "/" })
});
const cookie = cookieFrom(login.headers);
if (!(login.status >= 300 && login.status < 400 && cookie.startsWith("ukmd_auth="))) {
  console.error("login failed:", login.status);
  process.exit(1);
}

const status = await fetchRetry(BASE + "/api/status", { headers: { Cookie: cookie }, cache: "no-store" });
const st = await status.json();
if (!st.authenticated || !st.repoConfigured || !st.repoReachable) {
  console.error("repo not ready:", JSON.stringify(st));
  process.exit(1);
}

const conflict = await save(cookie, {
  file: FILE,
  md: "# smoke placeholder\n",
  baseHash: "0".repeat(64)
});
if (conflict.res.status !== 409 || !conflict.data.remoteMd || !conflict.data.remoteHash) {
  console.error("failed to load remote md via conflict probe:", conflict.res.status, JSON.stringify(conflict.data));
  process.exit(1);
}

const original = conflict.data.remoteMd;
const originalHash = conflict.data.remoteHash;
const marker = `\n<!-- P9 writeback smoke ${new Date().toISOString()} -->\n`;
const changed = original.endsWith("\n") ? original + marker : original + "\n" + marker;

const write = await save(cookie, { file: FILE, md: changed, baseHash: originalHash });
if (!write.res.ok || !write.data.ok || !write.data.commit) {
  console.error("temporary write failed:", write.res.status, JSON.stringify(write.data));
  process.exit(1);
}
console.log("temporary commit:", write.data.short || write.data.commit.slice(0, 7));

const revert = await save(cookie, {
  file: FILE,
  md: original,
  baseHash: await sha256Hex(changed)
});
if (!revert.res.ok || !revert.data.ok || !revert.data.commit) {
  console.error("revert failed:", revert.res.status, JSON.stringify(revert.data));
  process.exit(1);
}
console.log("revert commit:", revert.data.short || revert.data.commit.slice(0, 7));
console.log("OK — production writeback smoke passed; remote file restored.");
