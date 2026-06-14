import { requestAuthed } from "../_lib/auth.js";
import { getCommit, getContent, getHead, commitFiles, sha256Hex } from "../_lib/github.js";
import { json, methodNotAllowed, readJson } from "../_lib/http.js";
import { wrapTripData } from "../_lib/trip-data.js";

const MAIN_MD = "sample-trip.md";

function validTripFile(file, trips) {
  if (!/\.md$/i.test(file) || file.includes("/") || file.includes("..")) return false;
  return trips.some((t) => t && t.file === file);
}

export async function onRequestPost({ request, env }) {
  if (!(await requestAuthed(request, env))) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const data = await readJson(request);
  const file = data && String(data.file || "");
  const md = data && typeof data.md === "string" ? data.md : null;
  const baseHash = data && String(data.baseHash || "");
  if (!file || md == null || !/^[0-9a-f]{64}$/i.test(baseHash)) {
    return json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!/\.md$/i.test(file) || file.includes("/") || file.includes("..")) {
    return json({ ok: false, error: "file_not_allowed" }, { status: 400 });
  }

  const branch = env.GH_BRANCH || "main";
  let trips;
  try {
    trips = JSON.parse(await getContent(env, "trips.json", branch)).trips || [];
  } catch (err) {
    return json({ ok: false, error: "trips_read_failed", detail: err.message }, { status: err.status || 500 });
  }
  if (!validTripFile(file, trips)) {
    return json({ ok: false, error: "file_not_allowed" }, { status: 400 });
  }

  let remoteMd;
  try {
    remoteMd = await getContent(env, file, branch);
  } catch (err) {
    return json({ ok: false, error: "remote_read_failed", detail: err.message }, { status: err.status || 500 });
  }
  const remoteHash = await sha256Hex(remoteMd);
  if (remoteHash !== baseHash.toLowerCase()) {
    return json({ ok: false, error: "conflict", remoteHash, remoteMd }, { status: 409 });
  }
  if (remoteMd === md) {
    return json({ ok: true, noChange: true, remoteHash });
  }

  const files = [{ path: file, content: md }];
  try {
    if (file === MAIN_MD) files.push({ path: "trip.data.js", content: wrapTripData(md) });
  } catch (err) {
    return json({ ok: false, error: err.code || "trip_data_failed", detail: err.message }, { status: 400 });
  }

  try {
    const head = await getHead(env);
    const commit = await getCommit(env, head);
    const next = await commitFiles(env, files, `docs(trip): update ${file}`, head, commit.tree.sha);
    return json({ ok: true, commit: next.sha, short: next.sha.slice(0, 7) });
  } catch (err) {
    if (err.code === "ref_conflict" || err.status === 409) {
      return json({ ok: false, error: "conflict", remoteHash }, { status: 409 });
    }
    return json({ ok: false, error: "commit_failed", detail: err.message }, { status: err.status || 500 });
  }
}

export function onRequestGet() {
  return methodNotAllowed();
}
