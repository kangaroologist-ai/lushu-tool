# 路书 · Roadbook

一个**单文件**的自驾路书 / 行程地图工具:用一份 Markdown 写行程,自动出地图标点、OSRM 算路、日出日落、天气、离线 PWA。数据是你自己的 Markdown,纯前端渲染。

> 这是**公开工具版**,自带一份示例行程(`sample-trip.md`,仅公共地标、无任何真实预订)。把它换成你自己的即可。

## 功能

- 一份 MD = 一条行程(多方案下拉切换),语法见 [`SCHEMA.md`](SCHEMA.md) 与 [`trip-template.md`](trip-template.md)
- 全屏地图 + 左侧面板(桌面)/ 底部三态抽屉(移动);标点、OSRM 算路、渡海虚线段
- 日出/日落/黄金时刻(SunCalc 本地计算)、天气(Open-Meteo,预报 + 近 10 年同日气候)
- 离线 PWA(Service Worker 缓存壳 + 数据);可选 10km 走廊离线矢量地图
- 网页内编辑(悬停操作 / 移动端长按)、改时间自动顺延后续、固化自动值回写 MD
- 可选「存回文件 / 存回仓库」把编辑落盘

## 快速开始(本地)

```
# 任意静态服务器即可(SW/PWA 需 http,不能 file:// 直开)
npx http-server .        # 或 python3 -m http.server
# 浏览器打开 http://localhost:8080
```

直接双击 `index.html`(file://)也能看,但走的是 `trip.data.js` 兜底(无 SW、无多方案下拉)。

## 用你自己的行程

1. 按 [`SCHEMA.md`](SCHEMA.md) / `trip-template.md` 写一份 `my-trip.md`。
2. 在 `trips.json` 里把条目指向它。
3. 跑 `node tools/gen-fallback.mjs my-trip.md trip.data.js` 更新 file:// 兜底。
4. (可选)`node tools/offline-map/build-corridor.mjs` 重建离线走廊地图。

## 部署(Cloudflare Worker,可选,带口令门禁)

线上版用 Cloudflare Worker 提供**服务端口令门禁**(`worker.js` + `functions/`),并可把网页里的编辑「存回仓库」。

1. 复制 `.dev.vars.example` → `.dev.vars`,填:
   - `APP_PASSWORD` 站点访问口令
   - `AUTH_SECRET` 会话签名密钥(`node tools/gen-auth-secret.mjs` 生成)
   - `GH_TOKEN` 细粒度 PAT,授予你自己仓库的 contents:write(用于「存回仓库」)
2. 在 `wrangler.jsonc` 把 `name` / `vars.GH_OWNER` / `vars.GH_REPO` / `vars.GH_BRANCH` 改成你自己的。
3. `npm run deploy`(或连接 Cloudflare Workers Builds,push 自动构建)。

> 不配 `APP_PASSWORD`/`AUTH_SECRET` 时门禁自动关闭,纯静态可读。

## 测试

```
npm test   # round-trip(MD 解析↔序列化)+ functions + service worker + offline-map
```

## 结构

- `index.html` — 整个 App(解析器 / 渲染 / 地图 / 编辑都在里面)
- `trips.json` / `*.md` / `trip.data.js` — 行程数据(自带示例)
- `worker.js` / `functions/` — 部署壳 + 口令门禁 + 存回仓库 API
- `sw.js` — 离线 Service Worker;`offline-map/` — 可选离线矢量地图
- `tools/` — 构建/校验脚本;`SCHEMA.md` — MD 语法规范

## License

自用工具,按需取用。
