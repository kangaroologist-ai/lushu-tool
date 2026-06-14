import { isPublicPath, requestAuthed, unauthorized } from "./_lib/auth.js";
import { redirect } from "./_lib/http.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const authed = await requestAuthed(context.request, context.env);
  if (url.pathname === "/login" && authed) return redirect("/");
  if (isPublicPath(url.pathname)) return context.next();
  if (authed) return context.next();
  return unauthorized(context.request);
}
