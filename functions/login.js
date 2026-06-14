import { loginHtml } from "./_lib/auth.js";

export function onRequestGet({ request }) {
  return loginHtml(request);
}
