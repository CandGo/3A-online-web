// server/index.js — Saltline 多人模式服务器入口（单进程：HTTP 静态 + WS 房间中继）
// 运行：node server/index.js（或 npm run mp）；端口 process.env.PORT || 8787。
// 本文件不含任何游戏逻辑：HTTP 只静态服务 dist/，WS 只接受 /ws 升级并交给 rooms。
// 唯一例外是 GET /lan-info —— 房间元数据查询（MP-PVP §12 局域网发现），同样不是游戏逻辑，
// 服务器仍是纯中继（对局权威全部在房主端，此处只读房间摘要）。
// HTTP 生产化（国内移动网络友好，见 docs/DEPLOY-NETWORK.md）：
//   gzip（node:zlib 手写，零新依赖）+ 分层缓存头 + nosniff。WS 路径行为与此完全无关。

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT } from "../src/net/protocol.js";
import { createRoomServer } from "./rooms.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(__dirname, "../dist");
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const WS_PATH = "/ws";
const MAX_PAYLOAD = 64 * 1024; // 游戏帧都很小（快照约 1KB），64KB 上限防滥用

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function log(...args) {
  console.log("[saltline-mp]", ...args);
}

// --- HTTP 生产化：gzip + 缓存头 + nosniff ---

// 可 gzip 的文本类型；.woff2/.png 等已是压缩格式，再压只费 CPU 不减体积
const GZIP_EXT = new Set([".js", ".css", ".html", ".svg"]);
// 同一构建产物只压一次：keyed by 文件 mtime+size，重建后自动失效（约 430KB/主包）
const gzipCache = new Map(); // filePath -> { key: "mtimeMs:size", data: Buffer }

function acceptsGzip(req) {
  const ae = req.headers["accept-encoding"];
  if (!ae) return false;
  for (const part of ae.split(",")) {
    const [token, ...params] = part.trim().split(";");
    if (token.trim().toLowerCase() !== "gzip") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !(q && Number(q.slice(2)) <= 0);
  }
  return false;
}

async function gzipCached(filePath, body) {
  const st = await stat(filePath).catch(() => null);
  const key = st ? `${st.mtimeMs}:${st.size}` : null;
  if (key) {
    const hit = gzipCache.get(filePath);
    if (hit && hit.key === key) return hit.data;
  }
  const data = gzipSync(body);
  if (key) gzipCache.set(filePath, { key, data });
  return data;
}

// 分层缓存：index.html 永远可再验证（发版即生效）→ /assets/* 文件名带 hash 一年
// immutable（跨发布永不变化）→ 其余静态（fonts 等）1 小时
function cacheControlFor(pathname, fileName) {
  if (fileName === "index.html") return "no-cache";
  if (pathname.startsWith("/assets/"))
    return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD")
    return sendText(res, 405, "Method Not Allowed");
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return sendText(res, 400, "Bad Request");
  }
  if (pathname.includes("\0")) return sendText(res, 400, "Bad Request");

  // SPA 兜根路径：无扩展名的路由（如 /lobby）回落 index.html；带扩展名按静态文件走
  const hasExt = extname(pathname) !== "";
  const filePath = resolve(DIST, "." + (hasExt ? pathname : "/index.html"));
  if (filePath !== DIST && !filePath.startsWith(DIST + sep))
    return sendText(res, 403, "Forbidden"); // 防目录穿越

  try {
    const raw = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControlFor(pathname, basename(filePath)),
      "X-Content-Type-Options": "nosniff",
    };
    let payload = raw;
    if (GZIP_EXT.has(ext)) {
      // 响应体随 Accept-Encoding 变化，过共享代理/CDN 必须声明 Vary
      headers["Vary"] = "Accept-Encoding";
      if (acceptsGzip(req)) {
        payload = await gzipCached(filePath, raw);
        headers["Content-Encoding"] = "gzip";
      }
    }
    headers["Content-Length"] = payload.length;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : payload);
  } catch {
    if (!hasExt)
      return sendText(res, 500, "dist/index.html 缺失，请先执行 npm run build");
    sendText(res, 404, "Not Found");
  }
}

const rooms = createRoomServer({ log });

// --- 局域网自动发现端点（MP-PVP §12）：GET /lan-info ---
// 用途：加入界面「自动发现」扫描器（src/net/lan-scan.js）逐台探测本网段，
//       列出应答房间的模式/人数/房主名供点选直连（队友侧零输入）。
// CORS 全开（ACAO:*）：file:// 直开构建产物的页面 origin 为 null，非凭据跨源请求
//       在 ACAO:* 下同样放行 —— 扫描器无需任何服务器同源假设。
// 应答形状（rooms.lanInfo()）：顶层保留首房兼容字段，并新增 roomList 全部房间目录；
//       公开房 {code,mode,visibility,phase,players,host,names}；
//       私密房名单脱敏为 {visible:false,mode,phase,n}（无码无名，想进房仍须手输房码）；
//       对局中(phase!=lobby)照常应答 —— 客户端据此显示「对局中」灰态条目。
const LAN_INFO_PATH = "/lan-info";
const LAN_INFO_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function handleLanInfo(req, res) {
  // 预检直通：携带 Origin / Access-Control-Request-* 的 OPTIONS 也在此应答
  if (req.method === "OPTIONS") {
    res.writeHead(204, LAN_INFO_CORS);
    return res.end();
  }
  const headers = {
    ...LAN_INFO_CORS,
    "Cache-Control": "no-store", // 房间态实时数据，禁缓存（扫描器侧另有 cache:'no-store' 双保险）
    "X-Content-Type-Options": "nosniff",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      ...headers,
      Allow: "GET, HEAD, OPTIONS",
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Method Not Allowed");
  }
  const body = JSON.stringify(rooms.lanInfo());
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = Buffer.byteLength(body);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

const httpServer = createServer((req, res) => {
  let pathname = "";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {}
  // §12 发现端点先于静态路由（不受 dist 是否构建影响 —— 打包 exe 场景静态缺失也要能应答）
  if (pathname === LAN_INFO_PATH) return handleLanInfo(req, res);
  serveStatic(req, res).catch((err) => {
    log("HTTP 处理错误:", err.message);
    if (!res.headersSent) sendText(res, 500, "Internal Server Error");
    else res.destroy();
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

// WS upgrade 只走 /ws，其余升级请求直接断开
httpServer.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {}
  if (pathname !== WS_PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  rooms.onOpen(ws);
  ws.on("message", (data) => rooms.onMessage(ws, data));
  ws.on("pong", () => rooms.onPong(ws));
  ws.on("close", () => rooms.onClose(ws));
  ws.on("error", (err) => log("WS 连接错误:", err.message));
});

httpServer.on("error", (err) => {
  console.error("[saltline-mp] 服务器错误:", err.message);
  process.exitCode = 1;
  httpServer.close();
});

httpServer.listen(PORT, () => {
  log(`服务器已启动: http://localhost:${PORT}`);
  log(`静态根目录: ${DIST}`);
  log(`WS 端点: ws://localhost:${PORT}${WS_PATH}`);
});

// 优雅退出：解散房间、断开全部连接
function shutdown() {
  log("正在关闭服务器…");
  try {
    rooms.dispose();
  } catch {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
