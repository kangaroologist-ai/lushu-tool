import { html, json, redirect } from "./http.js";

const COOKIE = "ukmd_auth";
const SESSION_TTL = 180 * 24 * 60 * 60;
const enc = new TextEncoder();

function base64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlText(text) {
  return base64Url(enc.encode(text));
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function cookieMap(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function loginPage(request, message = "") {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>路书登录</title>
<style>
html,body{height:100%;margin:0}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#dfe7e0;color:#172019;display:grid;place-items:center}
form{width:min(360px,calc(100vw - 40px));background:#fff;border:1px solid #DCE3DC;border-radius:10px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
h1{font-size:22px;margin:0 0 14px;color:#03543C}
label{display:block;font-size:13px;color:#5B6A60;margin-bottom:8px}
input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border:1px solid #DCE3DC;border-radius:8px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:8px;background:#03543C;color:#fff;font-weight:800;font-size:15px}
.err{margin:0 0 12px;color:#C8402F;font-size:13px}
</style>
</head>
<body>
<form method="post" action="/api/login">
<h1>路书登录</h1>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<label for="password">访问口令</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${escapeAttr(next)}">
<button type="submit">进入</button>
</form>
</body>
</html>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

export async function makeSession(secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error("AUTH_SECRET missing");
  const payload = base64UrlText(JSON.stringify({ iat: now, exp: now + SESSION_TTL }));
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifySession(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const expected = await sign(secret, parts[0]);
  if (expected !== parts[1]) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    return payload && payload.exp && payload.exp >= now;
  } catch (_) {
    return false;
  }
}

export async function requestAuthed(request, env) {
  const token = cookieMap(request.headers.get("Cookie"))[COOKIE];
  return verifySession(token, env.AUTH_SECRET);
}

export function setSessionCookie(headers, token, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const expires = new Date(Date.now() + SESSION_TTL * 1000).toUTCString();
  headers.append("Set-Cookie", `${COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}; Expires=${expires}`);
}

export function clearSessionCookie(headers, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  headers.append("Set-Cookie", `${COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

export function isPublicPath(path) {
  return path === "/login" || path === "/api/login" || path === "/api/status";
}

export function unauthorized(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", url);
  login.searchParams.set("next", url.pathname + url.search);
  return redirect(login.pathname + login.search, { status: 302 });
}

export function loginHtml(request, message, init) {
  return html(loginPage(request, message), init);
}
