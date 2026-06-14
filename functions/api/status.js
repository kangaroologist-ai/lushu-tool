import { requestAuthed } from "../_lib/auth.js";
import { getContent } from "../_lib/github.js";
import { json } from "../_lib/http.js";

function repoConfigured(env) {
  const token = String(env.GH_TOKEN || "");
  return Boolean(token && !token.includes("...") && !/dummy|change-me/i.test(token));
}

export async function onRequestGet({ request, env }) {
  const authenticated = await requestAuthed(request, env);
  const configured = repoConfigured(env);
  let repoReachable = false;
  if (authenticated && configured) {
    try {
      await getContent(env, "trips.json", env.GH_BRANCH || "main");
      repoReachable = true;
    } catch (_) {
      repoReachable = false;
    }
  }
  return json({
    ok: true,
    authenticated,
    repoConfigured: configured,
    repoReachable,
    branch: env.GH_BRANCH || "main"
  });
}
