export function baseUrl() {
  return (process.env.LUSHU_URL || "https://your-worker.workers.dev").replace(/\/+$/, "");
}

export async function fetchRetry(url, init = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;
      const code = err && err.cause && err.cause.code ? ` ${err.cause.code}` : "";
      console.error(`  - network retry ${i}/${tries} failed:${code}`);
      if (i < tries) await new Promise((resolve) => setTimeout(resolve, 800 * i));
    }
  }
  const code = last && last.cause && last.cause.code ? ` (${last.cause.code})` : "";
  throw new Error(`无法连接线上 Worker${code}。这是 DNS/TLS/网络层错误,还没进入 Worker 业务逻辑;换网络/VPN后重试。`);
}
