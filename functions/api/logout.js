import { clearSessionCookie } from "../_lib/auth.js";
import { json, redirect } from "../_lib/http.js";

export function onRequestPost({ request }) {
  const headers = new Headers();
  clearSessionCookie(headers, request);
  return json({ ok: true }, { headers });
}

export function onRequestGet({ request }) {
  const headers = new Headers();
  clearSessionCookie(headers, request);
  return redirect("/login", { headers });
}
