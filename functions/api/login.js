import { clearSessionCookie, loginHtml, makeSession, setSessionCookie } from "../_lib/auth.js";
import { json, redirect } from "../_lib/http.js";

async function readLogin(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    const data = await request.json().catch(() => ({}));
    return { password: data.password || "", next: data.next || "/" };
  }
  const form = await request.formData();
  return { password: form.get("password") || "", next: form.get("next") || "/" };
}

function safeNext(next) {
  const s = String(next || "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export async function onRequestPost({ request, env }) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  const { password, next } = await readLogin(request);
  if (!env.APP_PASSWORD || !env.AUTH_SECRET) {
    return json({ ok: false, error: "auth_not_configured" }, { status: 500 });
  }
  if (String(password) !== String(env.APP_PASSWORD)) {
    if (wantsJson) return json({ ok: false, error: "bad_password" }, { status: 401 });
    return loginHtml(request, "口令不对", { status: 401 });
  }
  const headers = new Headers();
  setSessionCookie(headers, await makeSession(env.AUTH_SECRET), request);
  if (wantsJson) return json({ ok: true }, { headers });
  headers.set("Location", safeNext(next));
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers });
}

export function onRequestGet({ request }) {
  const headers = new Headers();
  clearSessionCookie(headers, request);
  return redirect("/login", { headers });
}
