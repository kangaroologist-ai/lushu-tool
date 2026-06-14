import { isPublicPath, requestAuthed, unauthorized } from "./functions/_lib/auth.js";
import { json, methodNotAllowed, redirect } from "./functions/_lib/http.js";
import { onRequestGet as loginGet } from "./functions/login.js";
import { onRequestGet as loginClear, onRequestPost as loginPost } from "./functions/api/login.js";
import { onRequestGet as logoutGet, onRequestPost as logoutPost } from "./functions/api/logout.js";
import { onRequestPost as savePost } from "./functions/api/save.js";
import { onRequestGet as statusGet } from "./functions/api/status.js";

function authConfigured(env) {
  return Boolean(env.APP_PASSWORD && env.AUTH_SECRET);
}

async function api(request, env) {
  const url = new URL(request.url);
  const context = { request, env };
  if (url.pathname === "/api/login") {
    if (request.method === "POST") return loginPost(context);
    if (request.method === "GET") return loginClear(context);
    return methodNotAllowed();
  }
  if (url.pathname === "/api/logout") {
    if (request.method === "POST") return logoutPost(context);
    if (request.method === "GET") return logoutGet(context);
    return methodNotAllowed();
  }
  if (url.pathname === "/api/status") {
    if (request.method === "GET") return statusGet(context);
    return methodNotAllowed();
  }
  if (url.pathname === "/api/save") {
    if (request.method === "POST") return savePost(context);
    return methodNotAllowed();
  }
  return json({ ok: false, error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env);

    if (!authConfigured(env)) {
      if (url.pathname === "/login") return redirect("/");
      return env.ASSETS.fetch(request);
    }

    const authed = await requestAuthed(request, env);
    if (url.pathname === "/login") {
      if (authed) return redirect("/");
      if (request.method !== "GET") return methodNotAllowed();
      return loginGet({ request, env });
    }
    if (!isPublicPath(url.pathname) && !authed) return unauthorized(request);
    return env.ASSETS.fetch(request);
  }
};
