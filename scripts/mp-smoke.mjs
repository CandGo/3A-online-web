#!/usr/bin/env node
// scripts/mp-smoke.mjs — 多人服务器冒烟自测（覆盖 server/index.js + rooms.js + src/net/protocol.js）
// 流程：spawn server/index.js 子进程 → HTTP 静态断言 → 6 个 ws 客户端走完
//   hello / createRoom / joinRoom / ROOM_FULL / toHost / fromHost 转发 /
//   start 仅房主放行 / GAME_STARTED 拒加入 / 房主掉线 HOST_GONE 解散
//   → 对抗模式管道（MP-PVP §8.1）：createRoom 带 mode=pvp 回显、
//   joined/roomState 含 mode、pvp 载荷 fromHost 透传不丢 e 字段、
//   旧客户端 createRoom 不带 mode 缺省等价 coop
//   → 公开房与快速加入（MP-PVP §10.1）：visibility 创建/回显、quickJoin
//   命中公开房/带 mode 优先同模式/无匹配自动建公开房/私密房不进匹配池、
//   pvp 房 team 序号按加入序 0,1,0,1 下发 → 打印 PASS。
// 增补（HTTP 生产化，DEPLOY-NETWORK 国内移动网络友好）：gzip 生效（Content-Encoding
//   + 体积骤降 + 解压还原）、/assets/* immutable 缓存头、index.html no-cache。
// 增补（MP-PVP §12 局域网发现）：GET /lan-info 公开房完整回显/私密房名单脱敏/
//   CORS 头（ACAO:*）/OPTIONS 预检 204/HEAD 无正文/对局中 phase 照常回显；
//   lan-scan 扫描器 E2E —— 第二实例（不同端口=模拟另一台主机）双实例各自扫出、
//   onFound 流式回调、整段扫描 ≤3s、空端口全失败返回 []。
//   扫描器注入 node:http fetch 替身（agent:false，无 keep-alive 残留句柄 —— 遵守
//   本文件头"不用 undici fetch"的 Windows libuv 纪律；浏览器真实调用方走全局 fetch）。
// 运行：node scripts/mp-smoke.mjs（随机高位端口，结束杀干净子进程，退出码 0/1）
// 注：不用 undici fetch（Windows 下 keep-alive 句柄 + process.exit 会触发 libuv 断言），
//     一律 node:http 单发请求（agent:false，无残留句柄），结束时自然退出 + 宽限兜底。

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import WebSocket from "ws";
import {
  MSG,
  PROTOCOL_VERSION,
  MODE_COOP,
  MODE_PVP,
  VIS_PRIVATE,
  VIS_PUBLIC,
  encode,
} from "../src/net/protocol.js";
import { scanLan } from "../src/net/lan-scan.js";

const PORT = 18787 + Math.floor(Math.random() * 1000);
const PORT2 = 23787 + Math.floor(Math.random() * 1000); // §12 第二实例（不同端口=模拟另一台主机）
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));
const TIMEOUT_MS = 30000;

let secondInstance = null; // §12 第二实例（main 内创建，finally 统一击杀）

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed.push(label);
}

function httpGet(url, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          type: String(res.headers["content-type"] || ""),
          headers: res.headers,
          buf,
          body: buf.toString(),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// fetch 替身（scanLan 注入用）：node:http 单发请求（agent:false，无 keep-alive 残留句柄）。
// 形状只覆盖 scanLan 消费面：{ ok, status, json() }；signal 经 req.destroy 传达中止。
function fetchLike(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    req.on("error", reject);
    if (signal) {
      const abort = () => req.destroy(new Error("scan-abort"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    req.end();
  });
}

// --- §12 lan-info 读取小件 ---
async function getLanInfo(base = HTTP_URL) {
  const res = await httpGet(`${base}/lan-info`);
  let info = null;
  try {
    info = JSON.parse(res.body);
  } catch {}
  return { res, info };
}

/** 轮询 /lan-info 直至谓词命中（房间解散/换位是异步事件，等它稳定再断言） */
async function waitLanInfo(pred, label, base = HTTP_URL, tries = 30) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await getLanInfo(base);
    if (last.info && pred(last.info)) return last.res;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `等待 lan-info 超时: ${label}（末次应答 ${last ? last.res.body : "无"}）`
  );
}

/** 起一个服务器实例（主实例/第二实例共用；第二实例=不同端口模拟局域网另一台主机） */
function spawnServer(port) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const st = { proc, log: "", exit: null };
  proc.stdout.on("data", (d) => (st.log += d));
  proc.stderr.on("data", (d) => (st.log += d));
  proc.on("exit", (code, signal) => {
    st.exit = `code=${code} signal=${signal ?? "none"}`;
    if (!finishing) console.error(`[smoke] 服务器子进程(${port})提前退出 ${st.exit}`);
  });
  return st;
}

async function waitHttpOn(st, port, timeoutMs = 10000) {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (st.proc.exitCode !== null) throw new Error(`服务器(${port})未启动即退出:\n${st.log}`);
    try {
      const r = await httpGet(`${url}/`, "HEAD");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待服务器(${port})启动超时:\n${st.log}`);
}

let finishing = false;
let serverExitInfo = null; // 从 exit 事件取证（Windows 终止路径下 server.exitCode 恒为 null）
const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
server.on("exit", (code, signal) => {
  serverExitInfo = `code=${code} signal=${signal ?? "none"}`;
  if (!finishing) console.error(`[smoke] 服务器子进程提前退出 ${serverExitInfo}`);
});

async function waitHttp(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`服务器未启动即退出:\n${serverLog}`);
    try {
      const r = await httpGet(`${HTTP_URL}/`, "HEAD");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待服务器启动超时:\n${serverLog}`);
}

const clients = [];
function connect(name, url = WS_URL) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else inbox.push(m);
  });
  ws.on("error", () => {}); // 断言由 expect 超时兜底
  const c = {
    name,
    ws,
    send: (obj) => ws.send(encode(obj)),
    open: () => once(ws, "open"),
    expect(pred, label, ms = 4000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) waiters.splice(j, 1);
          reject(new Error(`等待超时: ${label}`));
        }, ms);
        waiters.push(w);
      });
    },
    close() {
      return new Promise((r) => {
        if (ws.readyState === WebSocket.CLOSED) return r();
        ws.once("close", r);
        ws.close();
      });
    },
  };
  clients.push(c);
  return c;
}

async function main() {
  await waitHttp();

  // --- HTTP 静态 ---
  const home = await httpGet(`${HTTP_URL}/`);
  ok(
    home.status === 200 &&
      home.type.includes("text/html") &&
      /<!doctype html/i.test(home.body),
    "HTTP / 返回 index.html"
  );
  const spa = await httpGet(`${HTTP_URL}/some/deep/route`);
  ok(
    spa.status === 200 && spa.type.includes("text/html"),
    "SPA 兜根路径回落 index.html"
  );
  const missing = await httpGet(`${HTTP_URL}/assets/no-such-file.js`);
  ok(missing.status === 404, "缺失资源返回 404");

  // --- HTTP 生产化：gzip + 分层缓存头（国内移动网络友好） ---
  const assetsDir = fileURLToPath(new URL("../dist/assets", import.meta.url));
  const bundleName = (await readdir(assetsDir)).find((f) => f.endsWith(".js"));
  if (!bundleName)
    throw new Error("dist/assets 下未找到 .js 构建产物（请先 npm run build）");
  const rawSize = (await stat(join(assetsDir, bundleName))).size;
  const gz = await httpGet(`${HTTP_URL}/assets/${bundleName}`, "GET", {
    "Accept-Encoding": "gzip",
  });
  ok(
    gz.status === 200 &&
      gz.headers["content-encoding"] === "gzip" &&
      gz.buf.length > 0 &&
      gz.buf.length < rawSize * 0.7 &&
      gunzipSync(gz.buf).length === rawSize,
    `gzip 生效（${bundleName}: ${rawSize}B → ${gz.buf.length}B，解压还原一致）`
  );
  const gzCc = String(gz.headers["cache-control"] || "");
  ok(
    gzCc.includes("max-age=31536000") && gzCc.includes("immutable"),
    "/assets/* 缓存头 immutable（max-age=31536000）"
  );
  ok(
    String(home.headers["cache-control"] || "") === "no-cache",
    "index.html 缓存头 no-cache"
  );

  // --- 建房 / 加入 ---
  const A = connect("A"); // 房主
  const B = connect("B");
  const C = connect("C");
  const F = connect("F"); // 第 4 名成员
  const E = connect("E"); // 满员被拒
  const G = connect("G"); // 对局中被拒
  await Promise.all([A, B, C, F, E, G].map((c) => c.open()));
  for (const c of [A, B, C, F, E, G])
    c.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `队员${c.name}` });

  A.send({ t: MSG.CREATE_ROOM, seed: 4242 });
  const joinedA = await A.expect((m) => m.t === MSG.JOINED, "A joined");
  ok(/^[A-HJ-NP-Z2-9]{4}$/.test(joinedA.code), "房间码 4 位大写且无 0/O/1/I");
  ok(
    joinedA.seed === 4242 && joinedA.you.id === joinedA.hostId,
    "A 即房主，seed 回发"
  );
  await A.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 1,
    "A roomState(1)"
  );

  B.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  const joinedB = await B.expect((m) => m.t === MSG.JOINED, "B joined");
  ok(
    joinedB.seed === joinedA.seed &&
      joinedB.players.length === 2 &&
      joinedB.hostId === joinedA.hostId,
    "B joined 信息一致（seed/hostId/人数）"
  );
  await A.expect(
    (m) => m.t === MSG.PEER_EVENT && m.kind === "join",
    "A 收 peerEvent(join)"
  );
  await A.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 2,
    "A 收 roomState(2)"
  );

  C.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  await C.expect((m) => m.t === MSG.JOINED, "C joined");
  F.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  const joinedF = await F.expect((m) => m.t === MSG.JOINED, "F joined");
  ok(joinedF.players.length === 4, "房间满编 4 人");
  await A.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 4,
    "A 收 roomState(4)"
  );

  E.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  ok(
    (await E.expect((m) => m.t === MSG.ERROR, "E 被拒")).code === "ROOM_FULL",
    "第 5 人加入拒绝 ROOM_FULL"
  );

  // --- 隧道转发 ---
  B.send({ t: MSG.TO_HOST, p: { k: MSG.PS, pos: [1, 2, 3] } });
  const up = await A.expect((m) => m.t === MSG.TO_HOST, "A 收 toHost 转发");
  ok(
    up.from === joinedB.you.id && up.p && up.p.k === MSG.PS,
    "toHost 带发送者 id + 载荷透传"
  );
  A.send({ t: MSG.FROM_HOST, p: { k: MSG.PEERS, states: [] } });
  const down = await B.expect((m) => m.t === MSG.FROM_HOST, "B 收 fromHost 转发");
  ok(down.p && down.p.k === MSG.PEERS, "fromHost 载荷透传");

  // --- 开局：仅房主放行 ---
  B.send({ t: MSG.START });
  ok(
    (await B.expect((m) => m.t === MSG.ERROR, "B 非房主 start 被拒")).code ===
      "BAD_REQUEST",
    "非房主 start 拒绝"
  );
  A.send({ t: MSG.START, skipIntro: true });
  const startB = await B.expect((m) => m.t === MSG.START, "B 收 start 放行");
  ok(startB.skipIntro === true, "start 附加字段透传");
  await B.expect(
    (m) => m.t === MSG.ROOM_STATE && m.phase === "playing",
    "B roomState(playing)"
  );
  await A.expect(
    (m) => m.t === MSG.ROOM_STATE && m.phase === "playing",
    "A roomState(playing)"
  );

  // --- 对局中拒绝加入 ---
  G.send({ t: MSG.JOIN_ROOM, code: "ZZZZ" });
  ok(
    (await G.expect((m) => m.t === MSG.ERROR, "G 坏码")).code === "BAD_CODE",
    "无效房间码 BAD_CODE"
  );
  G.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  ok(
    (await G.expect((m) => m.t === MSG.ERROR, "G 对局中加入")).code ===
      "GAME_STARTED",
    "对局中拒绝 GAME_STARTED"
  );

  // --- 房主掉线 → HOST_GONE 广播 + 房间解散 ---
  await A.close();
  const gone = await B.expect(
    (m) => m.t === MSG.ERROR && m.code === "HOST_GONE",
    "B 收 HOST_GONE"
  );
  ok(!!gone.msg, "HOST_GONE 附中文提示");
  await C.expect(
    (m) => m.t === MSG.ERROR && m.code === "HOST_GONE",
    "C 收 HOST_GONE"
  );
  G.send({ t: MSG.JOIN_ROOM, code: joinedA.code });
  ok(
    (await G.expect((m) => m.t === MSG.ERROR, "G 房间已散")).code === "BAD_CODE",
    "房间解散后加入 BAD_CODE"
  );

  // --- 对抗模式管道（MP-PVP §8.1）：mode 透传 + pvp 载荷纯中继 ---
  const H = connect("H"); // pvp 房主
  const I = connect("I"); // pvp 成员
  const J = connect("J"); // 旧式客户端：createRoom 不带 mode 字段
  await Promise.all([H, I, J].map((c) => c.open()));
  for (const c of [H, I, J])
    c.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `队员${c.name}` });

  // 断言 1：createRoom 带 mode=pvp 回显正确
  H.send({ t: MSG.CREATE_ROOM, seed: 777, mode: MODE_PVP });
  const joinedH = await H.expect((m) => m.t === MSG.JOINED, "H joined(pvp)");
  ok(
    joinedH.mode === MODE_PVP && joinedH.seed === 777 && joinedH.code !== joinedA.code,
    "createRoom 带 mode=pvp 回显正确（mode/seed/独立房间）"
  );

  // 断言 2：joined/roomState 均含 mode（加入者视角 + 广播视角）
  I.send({ t: MSG.JOIN_ROOM, code: joinedH.code });
  const joinedI = await I.expect((m) => m.t === MSG.JOINED, "I joined(pvp)");
  const rsI = await I.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 2,
    "I roomState(pvp, 2 人)"
  );
  ok(
    joinedI.mode === MODE_PVP && rsI.mode === MODE_PVP,
    "joined/roomState 均含 mode=pvp"
  );

  // 断言 3：pvp 载荷 fromHost 透传不丢 e 字段（服务器纯中继不解析）
  H.send({
    t: MSG.FROM_HOST,
    p: {
      k: MSG.PVP,
      e: MSG.PVP_SCORE,
      board: [{ id: joinedH.you.id, name: "队员H", kills: 3, deaths: 1 }],
    },
  });
  const pvpDown = await I.expect(
    (m) => m.t === MSG.FROM_HOST && m.p && m.p.k === MSG.PVP,
    "I 收 pvp 载荷"
  );
  ok(
    pvpDown.p.e === MSG.PVP_SCORE &&
      Array.isArray(pvpDown.p.board) &&
      pvpDown.p.board.length === 1 &&
      pvpDown.p.board[0].kills === 3 &&
      pvpDown.p.board[0].deaths === 1,
    "pvp 载荷 fromHost 透传不丢 e 字段（board 原样）"
  );

  // 兼容红线：旧客户端 createRoom 不带 mode → 缺省等价 coop，照常工作
  J.send({ t: MSG.CREATE_ROOM, seed: 888 });
  const joinedJ = await J.expect((m) => m.t === MSG.JOINED, "J joined(旧式)");
  const rsJ = await J.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 1,
    "J roomState(旧式)"
  );
  ok(
    joinedJ.mode === MODE_COOP &&
      rsJ.mode === MODE_COOP &&
      joinedJ.seed === 888 &&
      joinedJ.you.id === joinedJ.hostId,
    "旧客户端 createRoom 缺省 mode 等价 coop"
  );
  // §10.1 旧客户端兼容：不带 visibility → 缺省 private；team 字段 coop 恒 0
  ok(
    joinedJ.visibility === VIS_PRIVATE && rsJ.visibility === VIS_PRIVATE,
    "旧客户端 createRoom 缺省 visibility 等价 private"
  );
  ok(
    joinedJ.players[0].team === 0 && rsJ.players[0].team === 0,
    "coop 房 team 恒 0（joined/roomState 双通道）"
  );

  // --- §10 公开房 + 快速加入 + team 序号（MP-PVP §10.1） ---
  const K = connect("K"); // 公开 pvp 房主（team 序号靶场）
  const L = connect("L");
  const M = connect("M");
  const N = connect("N");
  const U = connect("U"); // 私密房主（先于公开房注册，验证 quickJoin 跳过私密房）
  const P = connect("P"); // 公开 coop 房主（quickJoin 免码命中靶）
  const R = connect("R"); // quickJoin 免码命中
  const S = connect("S"); // 公开 pvp 房主（mode 优先匹配靶）
  const T = connect("T"); // quickJoin 带 mode=pvp
  const V = connect("V"); // 仅私密房在场 → 自动建公开房
  const W = connect("W"); // quickJoin(mode=pvp) 无同模式 → 自动建 pvp 公开房
  const crew10 = [K, L, M, N, U, P, R, S, T, V, W];
  await Promise.all(crew10.map((c) => c.open()));
  for (const c of crew10)
    c.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `队员${c.name}` });

  // 断言：公开房创建 + joined/roomState 回显 visibility=public
  K.send({ t: MSG.CREATE_ROOM, seed: 1010, mode: MODE_PVP, visibility: VIS_PUBLIC });
  const joinedK = await K.expect((m) => m.t === MSG.JOINED, "K joined(公开pvp)");
  const rsK = await K.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 1,
    "K roomState(公开pvp)"
  );
  ok(
    joinedK.visibility === VIS_PUBLIC &&
      rsK.visibility === VIS_PUBLIC &&
      joinedK.mode === MODE_PVP &&
      joinedK.players[0].team === 0 &&
      rsK.players[0].team === 0,
    "公开 pvp 房创建：joined/roomState 回显 visibility=public，房主 team=0"
  );

  // 断言：pvp 房 team 序号按加入序 0,1,0,1 下发
  L.send({ t: MSG.JOIN_ROOM, code: joinedK.code });
  const joinedL = await L.expect((m) => m.t === MSG.JOINED, "L joined(pvp)");
  M.send({ t: MSG.JOIN_ROOM, code: joinedK.code });
  const joinedM = await M.expect((m) => m.t === MSG.JOINED, "M joined(pvp)");
  N.send({ t: MSG.JOIN_ROOM, code: joinedK.code });
  const joinedN = await N.expect((m) => m.t === MSG.JOINED, "N joined(pvp)");
  const rsN = await N.expect(
    (m) => m.t === MSG.ROOM_STATE && m.players.length === 4,
    "N roomState(pvp 4 人)"
  );
  ok(
    rsN.players.map((p) => p.team).join(",") === "0,1,0,1",
    "pvp 房 team 序号按加入序 0,1,0,1 下发（roomState）"
  );
  ok(
    joinedL.players.find((p) => p.id === joinedL.you.id).team === 1 &&
      joinedM.players.find((p) => p.id === joinedM.you.id).team === 0 &&
      joinedN.players.find((p) => p.id === joinedN.you.id).team === 1,
    "各加入者 joined 自身 team 正确（红/蓝/红）"
  );

  // 私密房（先注册：迭代序在公开房之前，验证 quickJoin 遍历必跳过私密房）
  U.send({ t: MSG.CREATE_ROOM, seed: 4004, visibility: VIS_PRIVATE });
  const joinedU = await U.expect((m) => m.t === MSG.JOINED, "U joined(私密)");
  ok(joinedU.visibility === VIS_PRIVATE, "显式私密房回显 visibility=private");

  // 公开 coop 房（quickJoin 免码命中靶）
  P.send({ t: MSG.CREATE_ROOM, seed: 2020, mode: MODE_COOP, visibility: VIS_PUBLIC });
  const joinedP = await P.expect((m) => m.t === MSG.JOINED, "P joined(公开coop)");

  // 断言：quickJoin 免码命中公开 lobby 未满房（跳过更早注册的私密房；K 房已满不匹配）
  R.send({ t: MSG.QUICKJOIN });
  const joinedR = await R.expect((m) => m.t === MSG.JOINED, "R quickJoin 命中");
  ok(
    joinedR.code === joinedP.code &&
      joinedR.seed === joinedP.seed &&
      joinedR.code !== joinedU.code &&
      joinedR.hostId === joinedP.hostId &&
      joinedR.players.every((p) => p.team === 0),
    "quickJoin 免码命中公开未满房（跳过私密房，coop team 恒 0）"
  );

  // 公开 pvp 房（mode 优先匹配靶）
  S.send({ t: MSG.CREATE_ROOM, seed: 3030, mode: MODE_PVP, visibility: VIS_PUBLIC });
  const joinedS = await S.expect((m) => m.t === MSG.JOINED, "S joined(公开pvp)");

  // 断言：quickJoin 带 mode 优先匹配同模式（pvp 请求落 pvp 房，不落 coop 房）
  T.send({ t: MSG.QUICKJOIN, mode: MODE_PVP });
  const joinedT = await T.expect((m) => m.t === MSG.JOINED, "T quickJoin(pvp)");
  ok(
    joinedT.code === joinedS.code &&
      joinedT.mode === MODE_PVP &&
      joinedT.code !== joinedP.code,
    "quickJoin 带 mode=pvp 优先匹配同模式公开房"
  );

  // 清场：两间可匹配公开房的房主离场（房间即解散），场上只剩私密房与满员公开房
  await P.close();
  await R.expect(
    (m) => m.t === MSG.ERROR && m.code === "HOST_GONE",
    "R 收 HOST_GONE(P)"
  );
  await S.close();
  await T.expect(
    (m) => m.t === MSG.ERROR && m.code === "HOST_GONE",
    "T 收 HOST_GONE(S)"
  );

  // 断言：仅私密房在场 → quickJoin 不匹配私密房，自动建公开新房（免码请求者即房主）
  V.send({ t: MSG.QUICKJOIN });
  const joinedV = await V.expect((m) => m.t === MSG.JOINED, "V quickJoin 自建");
  const knownCodes = [joinedA.code, joinedH.code, joinedJ.code, joinedK.code, joinedU.code];
  ok(
    joinedV.visibility === VIS_PUBLIC &&
      joinedV.mode === MODE_COOP &&
      joinedV.you.id === joinedV.hostId &&
      !knownCodes.includes(joinedV.code),
    "quickJoin 无公开房可匹配：私密房不进匹配池，自动建 visibility=public 房"
  );

  // 断言：quickJoin 带 mode 无同模式匹配 → 自动建房 mode=请求值（不落进 V 的 coop 公开房）
  W.send({ t: MSG.QUICKJOIN, mode: MODE_PVP });
  const joinedW = await W.expect((m) => m.t === MSG.JOINED, "W quickJoin(pvp) 自建");
  ok(
    joinedW.visibility === VIS_PUBLIC &&
      joinedW.mode === MODE_PVP &&
      joinedW.you.id === joinedW.hostId &&
      joinedW.code !== joinedV.code,
    "quickJoin(mode=pvp) 无匹配自动建 pvp 公开房（mode=请求值）"
  );

  // --- §12 局域网自动发现：/lan-info 路由 + CORS 全开 + lan-scan 扫描器 ---
  // 此刻存活房间按创建序：H(pvp 私密 2 人) → J(coop 私密 1 人) → K(公开 pvp 4 人) → U/V/W。
  // lanInfo() 取最早创建的存活房 —— 先以 H 做私密房脱敏靶，再令 H/J 离场把 K 顶到首位做公开房靶。

  // 断言：私密房脱敏（首个存活房 H：无 code/names，仅 visible:false + mode + phase + n）
  const lanPriv = await getLanInfo();
  ok(
    lanPriv.res.status === 200 &&
      String(lanPriv.res.headers["content-type"] || "").includes("application/json"),
    "/lan-info 返回 200 application/json"
  );
  ok(
    !!lanPriv.info &&
      lanPriv.info.visible === false &&
      lanPriv.info.mode === MODE_PVP &&
      lanPriv.info.phase === "lobby" &&
      lanPriv.info.n === 2 &&
      lanPriv.info.code === undefined &&
      lanPriv.info.names === undefined,
    "私密房 /lan-info 名单脱敏：仅 {visible:false,mode,phase,n}，无码无名"
  );
  ok(
    String(lanPriv.res.headers["access-control-allow-origin"] || "") === "*",
    "/lan-info CORS 头存在（Access-Control-Allow-Origin: *）"
  );

  // 断言：OPTIONS 预检 204 + 放行（带 Origin 与 Access-Control-Request-Method 的真预检形状）
  const pre = await httpGet(`${HTTP_URL}/lan-info`, "OPTIONS", {
    Origin: "http://192.168.31.99:5173",
    "Access-Control-Request-Method": "GET",
  });
  ok(
    pre.status === 204 &&
      String(pre.headers["access-control-allow-origin"] || "") === "*" &&
      /GET/.test(String(pre.headers["access-control-allow-methods"] || "")),
    "OPTIONS /lan-info 预检 204 + CORS 放行（ACAM 含 GET）"
  );

  // 断言：HEAD 也过（有 CORS 头、无正文）——origin: null 即 file:// 页的 Origin 形状
  const lanHead = await httpGet(`${HTTP_URL}/lan-info`, "HEAD", { Origin: "null" });
  ok(
    lanHead.status === 200 &&
      String(lanHead.headers["access-control-allow-origin"] || "") === "*" &&
      lanHead.body === "",
    "HEAD /lan-info 200 有头无正文（origin:null 同样放行）"
  );

  // 清场：H/J 房主离场（房间解散）→ K（公开 pvp 4 人）顶到 lanInfo 首位
  await H.close();
  await I.expect(
    (m) => m.t === MSG.ERROR && m.code === "HOST_GONE",
    "I 收 HOST_GONE(H)"
  );
  await J.close();

  // 断言：公开房完整回显（code/mode/visibility/phase/players/host/names，房主居首）
  const lanPub = await waitLanInfo((info) => info.code === joinedK.code, "公开房顶位");
  const pubInfo = JSON.parse(lanPub.body);
  ok(
    pubInfo.code === joinedK.code &&
      pubInfo.mode === MODE_PVP &&
      pubInfo.visibility === VIS_PUBLIC &&
      pubInfo.phase === "lobby" &&
      pubInfo.players === 4 &&
      pubInfo.host === "队员K" &&
      Array.isArray(pubInfo.names) &&
      pubInfo.names.join(",") === "队员K,队员L,队员M,队员N",
    "公开房 /lan-info 完整回显（房主名+成员名，players=4）"
  );

  // 断言：对局中照常回显 phase=playing（客户端「对局中」灰态数据源）
  K.send({ t: MSG.START, skipIntro: true });
  await L.expect(
    (m) => m.t === MSG.ROOM_STATE && m.phase === "playing",
    "L roomState(playing, lan-info 前置)"
  );
  const lanPlay = await waitLanInfo((info) => info.phase === "playing", "对局中 phase");
  const playInfo = JSON.parse(lanPlay.body);
  ok(
    playInfo.code === joinedK.code &&
      playInfo.phase === "playing" &&
      Array.isArray(playInfo.names),
    "对局中 /lan-info 照常回显 phase=playing（名单不因开局回收）"
  );

  // 第二实例（不同端口 = 模拟局域网里另一台主机），开一间公开 coop 房（2 人）
  secondInstance = spawnServer(PORT2);
  await waitHttpOn(secondInstance, PORT2);
  const X = connect("X", `ws://127.0.0.1:${PORT2}/ws`);
  const Y = connect("Y", `ws://127.0.0.1:${PORT2}/ws`);
  await Promise.all([X, Y].map((c) => c.open()));
  for (const c of [X, Y])
    c.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `队员${c.name}` });
  X.send({ t: MSG.CREATE_ROOM, seed: 5151, mode: MODE_COOP, visibility: VIS_PUBLIC });
  const joinedX = await X.expect((m) => m.t === MSG.JOINED, "X joined(实例2)");
  Y.send({ t: MSG.JOIN_ROOM, code: joinedX.code });
  await Y.expect((m) => m.t === MSG.JOINED, "Y joined(实例2)");

  // 断言：扫描器 E2E —— 主实例房间可被扫出（127.0.0.1 精确命中 + 房码一致）
  const seen = [];
  const t0 = Date.now();
  const found1 = await scanLan({
    port: PORT,
    subnet: "127.0.0",
    timeoutMs: 400,
    concurrency: 64,
    fetchImpl: fetchLike,
    onFound: (e) => seen.push(e),
  });
  const scanMs = Date.now() - t0;
  ok(
    found1.some((e) => e.ip === "127.0.0.1" && e.info && e.info.code === joinedK.code),
    `lan-scan 扫出主实例房间（127.0.0.1:${PORT} → ${joinedK.code}）`
  );
  ok(
    seen.length === found1.length &&
      seen.some((e) => e.info && e.info.code === joinedK.code),
    "onFound 逐台流式回调（与返回列表一致）"
  );
  ok(scanMs <= 3000, `整网段扫描 ≤3s（254 地址实测 ${scanMs}ms）`);

  // 断言：双实例（不同端口）各自扫出 —— 实例2 公开房 players=2
  const found2 = await scanLan({
    port: PORT2,
    subnet: "127.0.0",
    timeoutMs: 400,
    fetchImpl: fetchLike,
  });
  ok(
    found2.some(
      (e) => e.ip === "127.0.0.1" && e.info && e.info.code === joinedX.code && e.info.players === 2
    ),
    "lan-scan 双实例不同端口各自扫出（实例2 公开房 players=2）"
  );

  // 断言：无服务器端口整段扫描 → 空数组（拒连/超时/坏 JSON 全部静默跳过）
  const foundNone = await scanLan({
    port: 1,
    subnet: "127.0.0",
    timeoutMs: 150,
    concurrency: 128,
    fetchImpl: fetchLike,
  });
  ok(
    Array.isArray(foundNone) && foundNone.length === 0,
    "无服务器端口整段扫描返回空数组（全失败跳过不抛错）"
  );
}

const watchdog = setTimeout(() => {
  finishing = true;
  server.kill();
  console.error(
    `[smoke] FAIL 总超时（${TIMEOUT_MS}ms）\n--- 服务器日志 ---\n${serverLog}`
  );
  process.exit(1);
}, TIMEOUT_MS);

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
} finally {
  clearTimeout(watchdog);
}

// --- 清理：关客户端 → 杀服务器（含 §12 第二实例）→ 等退出（exit 事件为证）→ 自然退出（宽限兜底） ---
finishing = true;
try {
  await Promise.race([
    Promise.allSettled(clients.map((c) => c.close())),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
} catch {}
if (secondInstance && secondInstance.exit === null && secondInstance.proc.exitCode === null)
  secondInstance.proc.kill();
if (secondInstance)
  await Promise.race([
    once(secondInstance.proc, "exit"),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
if (serverExitInfo === null && server.exitCode === null) server.kill();
await Promise.race([once(server, "exit"), new Promise((r) => setTimeout(r, 4000))]);
if (serverExitInfo === null && server.exitCode === null) {
  // 兜底强杀（正常不应走到这里）
  try {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
  } catch {}
  await Promise.race([once(server, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}
const exited = serverExitInfo !== null || server.exitCode !== null;

if (failure) {
  console.error(`[smoke] FAIL ${failure.message}\n--- 服务器日志 ---\n${serverLog}`);
  process.exitCode = 1;
} else if (!exited) {
  console.error("[smoke] FAIL 服务器子进程未退出（可能残留 pid=" + server.pid + "）");
  process.exitCode = 1;
} else if (secondInstance && secondInstance.exit === null && secondInstance.proc.exitCode === null) {
  console.error(
    "[smoke] FAIL 第二实例未退出（可能残留 pid=" + secondInstance.proc.pid + "）"
  );
  process.exitCode = 1;
} else {
  console.log(
    "PASS 服务器冒烟全部通过（含对抗模式管道 + 公开房/快速加入/team 序号 + 局域网发现 lan-info/lan-scan）:"
  );
  for (const label of passed) console.log(`  ok ${label}`);
  console.log(
    `[smoke] 子进程已杀干净（主实例 exit ${serverExitInfo}，第二实例 exit ${secondInstance ? secondInstance.exit : "未启用"}） | 断言 ${passed.length} 条`
  );
}
const grace = setTimeout(() => process.exit(process.exitCode || 0), 1500);
grace.unref?.();
