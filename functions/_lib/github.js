const enc = new TextEncoder();

function repo(env) {
  return {
    owner: env.GH_OWNER || "your-org",
    name: env.GH_REPO || "your-repo",
    branch: env.GH_BRANCH || "main"
  };
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function decodeBase64Text(content) {
  const bin = atob(String(content || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gh(env, path, init = {}) {
  if (!env.GH_TOKEN) {
    const err = new Error("GH_TOKEN missing");
    err.status = 500;
    throw err;
  }
  const { owner, name } = repo(env);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${env.GH_TOKEN}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "lushu-cloudflare-functions");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function getContent(env, path, ref = repo(env).branch) {
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  const data = await res.json();
  return decodeBase64Text(data.content);
}

export async function getHead(env) {
  const { branch } = repo(env);
  const res = await gh(env, `/git/ref/heads/${encodeURIComponent(branch)}`);
  const data = await res.json();
  return data.object.sha;
}

export async function getCommit(env, sha) {
  const res = await gh(env, `/git/commits/${encodeURIComponent(sha)}`);
  return res.json();
}

export async function commitFiles(env, files, message, parentSha, baseTreeSha) {
  const treeRes = await gh(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content
      }))
    })
  });
  const tree = await treeRes.json();
  const commitRes = await gh(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentSha]
    })
  });
  const commit = await commitRes.json();
  try {
    const { branch } = repo(env);
    await gh(env, `/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
  } catch (err) {
    if (err.status === 409) {
      err.code = "ref_conflict";
    }
    throw err;
  }
  return commit;
}
