// src/net/trystero-transport.js — §13 零服务器传输适配层（Trystero P2P）
// 契约依据：docs/MP-PVP.md §13.0/§13.1/§13.2。
//
// 职责：把 Trystero 的 P2P mesh 伪装成 net.js 既有传输缝所期望的
// WebSocket 形状（readyState/send/close/onopen/onmessage/onclose），
// 并在 mesh 上仿真出 ws 架构里"中继服务器"承担的房间职责——
// joined/roomState/peerEvent 合成、房主选举（建房者优先，缺席后最小 peerId 接管）、满员驱逐、
// host 掉线 HOST_GONE。游戏协议帧（protocol.js 的 t/k 值）原样透传，
// host-sim/puppet/remote-players 等消费端零改动。
//
// 铁律（与 net.js 对齐）：
//  * 消息面 = makeAction('m') 单通道（§13.0），帧体就是 ws 线上的 JSON 帧；
//    net.js 的 handleFrame 收到的与服务器模式下逐字节同构。
//  * 选举/满员/驱逐全部由 peer 集合本地可算（peers+selfId），无中心（§13.2）。
//  * 房主掉线 v1 = 房间终局（HOST_GONE 同步各端），不做权威迁移。
//  * trystero 只经动态 import 触达（vite 独立分包；ws 模式/单机零加载）。
//
// 房间命名（§13.2 公私双轨，appId 命名空间内）：
//  * 私人房 slp-{4位码} —— 建房端本地生成 4 位码（makeRoomCode 同字符集），
//    joinRoom 即进房，与 ws 模式的码体验一致；
//  * 公共房 slpub-{mode}-{n}（n=1..9 分片）—— 免码匹配：依次探测分片，
//    joinRoom 后等 1.5s 数 peer，<4 人留驻、≥4 人离房试下一片。

import { MSG, PROTOCOL_VERSION, MODE_COOP, MODE_PVP, normalizeMode } from "./protocol.js";

// ---- 常量（§13.0：选举稳定窗 1.5s；4 人满员）----
export const P2P_STABILITY_MS = 1500;
export const P2P_MAX_PLAYERS = 4;
export const P2P_PUBLIC_SHARDS = 9;

// appId 命名空间（§13.0「appId 前缀隔离」）：房间名只在同名 appId 内可见
export const P2P_APP_ID = "saltline-p2p-v1";
export const P2P_DIRECTORY_ROOM = "saltline-directory-v1";
const P2P_DIRECTORY_TTL_MS = 18_000;
const P2P_DIRECTORY_HEARTBEAT_MS = 5_000;

// Trystero's endpoint identity is generated with Web Crypto P-256.  Browsers
// expose crypto.subtle only in secure contexts (HTTPS, localhost, or loopback),
// so an HTTP LAN address must fail before the library reaches generateKey().
// Keeping this check here gives the UI a useful recovery message instead of a
// minified "reading 'generateKey'" exception.
export function p2pEnvironmentError(runtime) {
  let root = runtime || (typeof globalThis !== "undefined" ? globalThis : {});
  let secure =
    typeof root.isSecureContext === "boolean"
      ? root.isSecureContext
      : root.window && typeof root.window.isSecureContext === "boolean"
        ? root.window.isSecureContext
        : null;
  if (secure === false) {
    let err = new Error(
      "零服务器联机需要 HTTPS 或 localhost。当前局域网 HTTP 地址无法使用 Web Crypto，请改用 HTTPS/localhost，或切换服务器模式。",
    );
    err.code = "P2P_INSECURE_CONTEXT";
    return err;
  }
  let subtle = root.crypto && root.crypto.subtle;
  if (!subtle || typeof subtle.generateKey !== "function") {
    let err = new Error(
      "当前浏览器没有可用的 Web Crypto API，无法建立零服务器联机；请使用新版 Chrome/Edge 的 HTTPS 或 localhost 页面。",
    );
    err.code = "P2P_WEB_CRYPTO_UNAVAILABLE";
    return err;
  }
  return null;
}

// 策略表（§13.0：默认 nostr；失败自动轮换）。trystero 0.27 主包只随附
// nostr 策略（mqtt/torrent 拆分为独立 @trystero-p2p/* 包，按需加装后
// 往此表追加加载器即可启用轮换，无需改调用方）。
const STRATEGIES = [
  {
    name: "nostr",
    load: function () {
      return import("trystero").then(function (m) {
        return m.joinRoom;
      });
    },
  },
];

// ---- 房间名工具（net.js 与测试共用）----
export function p2pPrivateRoomName(code) {
  return "slp-" + String(code || "").trim().toUpperCase();
}
export function p2pPublicRoomName(mode, shard) {
  return "slpub-" + normalizeMode(mode) + "-" + Math.max(1, Math.min(P2P_PUBLIC_SHARDS, shard | 0));
}
// 公共房名反解（label 用）：slpub-{mode}-{n} → {mode, shard} | null
export function p2pParsePublicRoomName(name) {
  let m = /^slpub-(coop|pvp)-([1-9])$/.exec(String(name || ""));
  return m ? { mode: m[1], shard: +m[2] } : null;
}
// 私人房名反解：slp-{code} → code | null
export function p2pParsePrivateRoomName(name) {
  let m = /^slp-([A-Z0-9]{4})$/.exec(String(name || ""));
  return m ? m[1] : null;
}

// 房间种子：房间名确定性散列（两端同算同值，免去"服务器生成 seed"这一中心环节）
export function seedFromRoomName(name) {
  let s = 2166136261 >>> 0;
  let str = String(name || "");
  for (let i = 0; i < str.length; i++) {
    s ^= str.charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  return (s % 0x7fffffff) | 0;
}

// 4 位房间码（与 protocol.js makeRoomCode 同字符集去 0/O/1/I；此处本地生成不查重——
// 同名碰撞概率 1/32^4，且碰撞只表现为"进错房"，换个码即可）
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeP2PRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++)
    code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return code;
}

/**
 * 零服务器房间目录。
 *
 * 目录本身也是一个 Trystero 房间：目录参与者各自保存一份房间记录，
 * 通过心跳和快照同步；目录主是当前 peer 集合中最小的 peerId，掉线后
 * 所有在线成员会自动算出下一位。Nostr 只负责把陌生浏览器带进目录房间，
 * 不保存游戏状态。记录带 TTL，房主消失后不会永久残留。
 */
export function createP2PDirectory(opts = {}) {
  const o = opts || {};
  // Keep the directory on the same Trystero appId as game rooms.  Trystero
  // deterministically selects a relay subset from the appId; using a suffix
  // here could put the directory on a different, unreachable relay subset
  // even when the actual room connection works.  The distinct room id below
  // still keeps directory traffic isolated from game traffic.
  const appId = o.appId || P2P_APP_ID;
  const ttlMs = Number.isFinite(+o.ttlMs) ? Math.max(5_000, +o.ttlMs) : P2P_DIRECTORY_TTL_MS;
  const strategyTimeoutMs = Number.isFinite(+o.strategyTimeoutMs)
    ? Math.max(1_000, +o.strategyTimeoutMs)
    : 9_000;
  const joinFn = typeof o.joinFn === "function" ? o.joinFn : null;
  const listeners = new Set();
  const peers = new Set();
  const records = new Map();
  let room = null;
  let action = null;
  let selfId = null;
  let closed = false;
  let heartbeat = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function leaderId() {
    let ids = [selfId].filter(Boolean).concat([...peers]);
    ids.sort();
    return ids[0] || null;
  }
  function emit() {
    const items = list();
    for (const fn of listeners) {
      try {
        fn(items, leaderId());
      } catch {}
    }
  }
  function send(obj, target) {
    if (!action || closed) return;
    try {
      const p = action.send(JSON.stringify(obj), target ? { target } : { target: null });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const code = String(raw.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    if (!/^[A-Z0-9]{4}$/.test(code)) return null;
    const hostId = String(raw.hostId || "");
    if (!hostId) return null;
    return {
      id: String(raw.id || "slp-" + code),
      code,
      name: String(raw.name || "房间 " + code).slice(0, 24),
      host: String(raw.host || "房主").slice(0, 24),
      hostId,
      mode: raw.mode === MODE_PVP ? MODE_PVP : MODE_COOP,
      phase: raw.phase === "playing" ? "playing" : "lobby",
      players: Math.max(0, Math.min(P2P_MAX_PLAYERS, Number(raw.players) || 0)),
      maxPlayers: P2P_MAX_PLAYERS,
      seq: Number.isFinite(+raw.seq) ? +raw.seq : 0,
    };
  }
  function mergeRecord(raw, from) {
    const rec = normalizeRecord(raw);
    if (!rec) return;
    const old = records.get(rec.id);
    if (old && old.seq > rec.seq) return;
    records.set(rec.id, { ...rec, _seenAt: Date.now() });
    emit();
  }
  function mergeSnapshot(items, from) {
    if (!Array.isArray(items)) return;
    for (const item of items) mergeRecord(item, from);
    emit();
  }
  function snapshot(target) {
    send({ t: "snapshot", records: list(true) }, target);
  }
  function onMessage(data, ctx) {
    let msg = null;
    try {
      msg = JSON.parse(typeof data === "string" ? data : "");
    } catch {}
    if (!msg || typeof msg !== "object") return;
    const from = ctx && ctx.peerId != null ? String(ctx.peerId) : "";
    if (msg.t === "hello") return snapshot(from);
    if (msg.t === "snapshot") return mergeSnapshot(msg.records, from);
    if (msg.t === "announce") return mergeRecord(msg.record, from);
    if (msg.t === "withdraw") {
      const id = String(msg.id || "");
      if (id && records.delete(id)) emit();
    }
  }
  function attachPeerEvents(r) {
    action = r.makeAction("directory");
    action.onMessage(onMessage);
    r.onPeerJoin((ctx) => {
      const id = ctx && ctx.peerId != null ? String(ctx.peerId) : "";
      if (!id) return;
      peers.add(id);
      send({ t: "hello" }, id);
      snapshot(id);
      emit();
    });
    r.onPeerLeave((ctx) => {
      const id = ctx && ctx.peerId != null ? String(ctx.peerId) : "";
      if (!id) return;
      peers.delete(id);
      for (const [key, rec] of records) if (rec.hostId === id) records.delete(key);
      emit();
    });
  }
  async function loadJoin() {
    if (joinFn) return joinFn;
    const mod = await Promise.race([
      import("trystero").then((m) => m.joinRoom),
      new Promise((_, reject) => setTimeout(() => reject(new Error("目录信令装载超时")), strategyTimeoutMs)),
    ]);
    if (typeof mod !== "function") throw new Error("无可用目录信令");
    return mod;
  }
  async function start() {
    try {
      const joinRoom = await loadJoin();
      room = await joinRoom({ appId }, P2P_DIRECTORY_ROOM);
      if (room.ready && typeof room.ready.then === "function") await room.ready;
      const self = await room.getSelf();
      selfId = self && self.peerId != null ? String(self.peerId) : null;
      attachPeerEvents(room);
      if (typeof room.getPeers === "function") {
        const current = room.getPeers() || {};
        for (const id of Object.keys(current)) peers.add(String(id));
      }
      heartbeat = setInterval(() => {
        const now = Date.now();
        for (const [key, rec] of records) {
          if (rec.hostId === selfId) {
            rec.seq = now;
            rec._seenAt = now;
            send({ t: "announce", record: rec });
          } else if (now - rec._seenAt > ttlMs) {
            records.delete(key);
          }
        }
        emit();
      }, P2P_DIRECTORY_HEARTBEAT_MS);
      send({ t: "hello" });
      emit();
      readyResolve(api);
    } catch (err) {
      readyReject(err);
    }
  }
  function list(includeExpired = false) {
    const now = Date.now();
    return [...records.values()]
      .filter((rec) => includeExpired || now - rec._seenAt <= ttlMs)
      .map(({ _seenAt, seq, ...rec }) => ({ ...rec, seq }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  }
  function publish(record) {
    if (!selfId || closed) return null;
    const next = normalizeRecord({ ...record, hostId: selfId, seq: Date.now() });
    if (!next) return null;
    records.set(next.id, { ...next, _seenAt: Date.now() });
    send({ t: "announce", record: next });
    emit();
    return next;
  }
  function withdraw(id) {
    const key = String(id || "");
    if (!key) return;
    records.delete(key);
    send({ t: "withdraw", id: key });
    emit();
  }
  function onUpdate(fn) {
    if (typeof fn === "function") listeners.add(fn);
    return () => listeners.delete(fn);
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (room && typeof room.leave === "function") await room.leave();
    } catch {}
    listeners.clear();
  }
  const api = {
    ready,
    list,
    peerCount: () => new Set([selfId].filter(Boolean).concat([...peers])).size,
    publish,
    withdraw,
    onUpdate,
    leaderId,
    selfId: () => selfId,
    close,
  };
  start();
  return api;
}

function enc(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "null";
  }
}
function dec(text) {
  try {
    let obj = JSON.parse(typeof text === "string" ? text : null);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 创建 P2P 传输 socket（net.js 传输缝的 WebSocket 形状）。
 * @param {object} opts
 *   roomName      目标 Trystero 房间名（私人房完整名；公共房为首片名——
 *                 probe 为真时按 §13.2 依次探测）
 *   displayName   本端呼号（net hello 上行后回填，亦可直接给）
 *   roomMeta      建房端房间元数据 {mode, visibility}（随 hello 广播全房采纳）
 *   isCreator     是否为本次私人房的建房端；建房者优先成为房主
 *   probe         公共匹配模式：true = 分片探测（slpub-{mode}-{n}）
 *   stabilityMs   选举稳定窗（默认 1500）
 *   strategyTimeoutMs 单策略建立超时（默认 9000）
 *   appId / relayUrls / rtcPolyfill / joinFn  注入缝（测试与 Node 环境）
 * @returns {object} WS-like socket；失败在 onopen 前 onclose（pending 由 net 侧超时/错误收口）
 */
export function createP2PSocket(opts) {
  let o = opts || {};
  let stabilityMs = o.stabilityMs != null ? o.stabilityMs : P2P_STABILITY_MS;
  let strategyTimeoutMs = o.strategyTimeoutMs != null ? o.strategyTimeoutMs : 9000;
  let appId = o.appId || P2P_APP_ID;
  let joinFn = o.joinFn || null; // 测试注入：joinRoom(config, roomId) → room
  let probe = !!o.probe;
  let isCreator = !!o.isCreator;

  // ---- 对 net.js 暴露的 WS 形状 ----
  let sock = {
    readyState: 0, // 0 connecting | 1 open | 3 closed
    onopen: null,
    onmessage: null, // ({data: jsonText}) —— 与 ws.onmessage 同形
    onclose: null,
    onerror: null,
    close: null, // 下方绑定
    send: null,
    // §13 附查面（net.roomLabel()/transportKind 数据源；非 WS 标准字段）
    p2p: {
      kind: "p2p",
      strategy: null,
      roomName: null,
      code: null, // 私人房显示码
      mode: null,
      visibility: null,
      get label() {
        return sock.p2p._label;
      },
      _label: null,
    },
  };

  // ---- 内部状态 ----
  let room = null;
  let sendM = null; // makeAction('m') send
  let selfId = null;
  let peers = new Set(); // 已连通 peerId（trystero 连接级）
  let names = new Map(); // peerId → 呼号（hello 学习，mesh 级）
  let roomMeta = null; // {mode, visibility} —— 建房端随 hello 广播，先到先得
  let creatorId = null; // 私人房建房端 peerId；由 hello 在 mesh 中传播
  let creatorConflict = false;
  let hostId = null; // 当选房主（建房者优先，缺席后最小 peerId）
  let elected = false;
  let joinedSent = false; // 本端 joined 帧是否已送进 net（lobby 期重选举会重发）
  let roster = []; // host 端权威花名册（加入序）：[id,...]
  let phase = "lobby"; // host 端跟踪（start/restart 推 playing，lobby 回房间）
  let displayCode = null; // 私人房 4 位码（显示用）
  let closed = false;
  let leavePromise = null;
  let settleTimer = null; // 选举稳定窗
  let inbox = []; // 选举前到达的房主帧缓冲（如满员驱逐：host 对 peerJoin 即时反应，
  // 快于本端 1.5s 选举窗——无 hostId 可路由，先缓冲待选举后重放）

  // ---- 帧下行（→ net.handleFrame）----
  function deliver(frame) {
    if (closed || !sock.onmessage) return;
    try {
      sock.onmessage({ data: enc(frame) });
    } catch {}
  }
  // ---- 帧上行（net.sendRaw → 本 send）----
  sock.send = function (text) {
    let frame = dec(text);
    if (!frame || typeof frame.t !== "string") return;
    if (frame.t === MSG.HELLO) {
      // net 连上后第一帧：本端呼号；建房端附带房间元数据
      if (typeof frame.name === "string" && frame.name.trim())
        sock.p2p._displayName = frame.name.trim().slice(0, 24);
      if (frame.room && typeof frame.room === "object") adoptRoomMeta(frame.room, true);
      broadcastHello();
      return; // hello 是传输层元数据，绝不进 handleFrame
    }
    if (frame.t === MSG.LEAVE) {
      // net.disconnect 的礼貌离场帧：真正离开交给 close()
      return;
    }
    if (
      frame.t === MSG.CREATE_ROOM ||
      frame.t === MSG.JOIN_ROOM ||
      frame.t === MSG.QUICKJOIN
    )
      return; // p2p 下建房/加入由传输层自驱，信令帧不外发
    if (frame.t === MSG.START || frame.t === MSG.RESTART || frame.t === MSG.LOBBY) {
      if (hostId !== selfId) return; // 仅房主可广播 start/restart/lobby（对齐服务器校验）
      phase = frame.t === MSG.LOBBY ? "lobby" : "playing";
      broadcast(frame);
      return;
    }
    if (frame.t === MSG.ROOM_STATE || frame.t === MSG.PEER_EVENT) {
      // 服务器侧消息只由 host 传输实例合成；net 层不会外发这两类
      return;
    }
    if (frame.t === MSG.TO_HOST) {
      if (hostId === selfId) return; // 自己是 host：自己的 ps 走 playersState
      broadcast(frame);
      return;
    }
    if (frame.t === MSG.FROM_HOST) {
      if (hostId !== selfId) return; // 非房主不得发 fromHost（对齐服务器"伪造丢弃"）
      broadcast(frame);
      return;
    }
    // 其余（含未知 t）：原样广播——与服务器"未知消息忽略"相比这里更宽，
    // 但 handleFrame 对未知 t 本就不命中任何分支，等价无害
    broadcast(frame);
  };
  sock.close = function () {
    if (closed) return;
    closed = true;
    clearTimeout(settleTimer);
    try {
      if (room && typeof room.leave === "function")
        leavePromise = room.leave();
    } catch {}
    sock.readyState = 3;
    if (sock.onclose) {
      try {
        sock.onclose();
      } catch {}
    }
  };

  // ---- mesh 广播 / 定向 ----
  function broadcast(obj, target) {
    if (!sendM || closed) return;
    try {
      let p =
        target != null
          ? sendM(enc(obj), { target: target })
          : sendM(enc(obj), { target: null });
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch {}
  }
  function broadcastHello() {
    let hello = { t: MSG.HELLO, v: PROTOCOL_VERSION, name: sock.p2p._displayName || "队员" };
    if (roomMeta) hello.room = { mode: roomMeta.mode, visibility: roomMeta.visibility };
    // 建房者身份由传输层先发出；加入者收到后也会转发，避免迟到连接
    // 因为错过建房端的第一帧而各自选出不同房主。
    if (creatorId) hello.creatorId = creatorId;
    broadcast(hello);
  }
  function adoptRoomMeta(meta, fromSelf) {
    if (!meta || typeof meta !== "object") return;
    if (!roomMeta) {
      roomMeta = {
        mode: meta.mode === MODE_PVP ? MODE_PVP : MODE_COOP,
        visibility: meta.visibility === "public" ? "public" : "private",
      };
      sock.p2p.mode = roomMeta.mode;
      sock.p2p.visibility = roomMeta.visibility;
    } else if (fromSelf) {
      // 本端是建房端：以本端为准（自己是元数据之源）
      roomMeta.mode = meta.mode === MODE_PVP ? MODE_PVP : MODE_COOP;
      roomMeta.visibility = meta.visibility === "public" ? "public" : "private";
      sock.p2p.mode = roomMeta.mode;
      sock.p2p.visibility = roomMeta.visibility;
    }
  }

  // ---- 选举（私人房建房者优先；建房者不在场时最小 peerId 接管）----
  function scheduleElection() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(runElection, stabilityMs);
  }
  function peerCandidates() {
    let ids = [selfId];
    peers.forEach(function (id) {
      ids.push(id);
    });
    return ids;
  }
  function runElection() {
    if (closed || !room) return;
    if (phase !== "lobby") {
      // 对局中冻结选举（host 权威不迁移；迟到者由 GAME_STARTED 拒绝路径收口）
      return;
    }
    let ids = peerCandidates();
    let min = ids[0];
    for (let i = 1; i < ids.length; i++) if (ids[i] < min) min = ids[i];
    let prevHost = hostId;
    let creatorPresent = creatorId && !creatorConflict && ids.indexOf(creatorId) >= 0;
    hostId = creatorPresent ? creatorId : min;
    // 建房者排在花名册首位，其余成员用稳定 peerId 排序，保证两端同序。
    ids.sort(function (a, b) {
      if (creatorPresent && a === creatorId) return -1;
      if (creatorPresent && b === creatorId) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    roster = ids.slice();
    if (!elected) {
      elected = true;
      sock.readyState = 1;
      if (sock.onopen) {
        try {
          sock.onopen();
        } catch {}
      }
    }
    if (hostId === selfId) {
      // 我是房主：接管"虚拟服务器"职责
      if (prevHost !== selfId || !joinedSent) hostDutiesOnElect();
      else pushRoomState();
    } else {
      roster = []; // 非房主不持权威花名册
      if (prevHost !== hostId || !joinedSent) {
        // 房主易人（lobby 期迟到者更小 id）/首次：重发 joined 让 net 重对齐角色
        deliverJoined();
      }
    }
    joinedSent = true;
    // 重放选举前缓冲的房主帧（此时 hostId 已定，路由可判）
    if (inbox.length) {
      let queued = inbox;
      inbox = [];
      for (let i = 0; i < queued.length; i++) {
        let item = queued[i];
        onMeshMessage(enc(item[1]), { peerId: item[0] });
      }
    }
  }

  // ---- joined 帧合成（两端各自本地合成；字段与 server/rooms.js sendJoined 同形）----
  function rosterPlayers() {
    let mode = roomMeta ? roomMeta.mode : MODE_COOP;
    let ids = roster.length ? roster.slice() : peerCandidates().sort();
    let out = [];
    for (let i = 0; i < ids.length; i++) {
      let id = ids[i];
      out.push({
        id: id,
        name:
          id === selfId
            ? sock.p2p._displayName || "队员"
            : names.get(id) || "队员",
        ready: id === selfId || id === hostId,
        team: mode === MODE_PVP ? i % 2 : 0, // §10.1 同语义：加入序取模，0/2 蓝 1/3 红
      });
    }
    return out;
  }
  function deliverJoined() {
    deliver({
      t: MSG.JOINED,
      roomId: sock.p2p.roomName,
      code: displayCode != null ? displayCode : null,
      you: { id: selfId },
      hostId: hostId,
      seed: seedFromRoomName(sock.p2p.roomName),
      mode: roomMeta ? roomMeta.mode : MODE_COOP,
      visibility: roomMeta ? roomMeta.visibility : "private",
      players: rosterPlayers(),
    });
  }

  // ---- 房主职责：虚拟服务器（roomState/peerEvent 广播 + 满员/中局驱逐）----
  function hostDutiesOnElect() {
    deliverJoined();
    pushRoomState();
    broadcastHello();
  }
  function pushRoomState() {
    // 仅房主广播（§13.0：roomState 由 host 经同通道广播）；
    // 与中继服务器同款回声：广播同时也送本端 net（host 侧 roster 增减靠它刷新）
    if (hostId !== selfId) return;
    let frame = {
      t: MSG.ROOM_STATE,
      phase: phase,
      mode: roomMeta ? roomMeta.mode : MODE_COOP,
      visibility: roomMeta ? roomMeta.visibility : "private",
      players: rosterPlayers(),
      code: displayCode != null ? displayCode : null,
    };
    broadcast(frame);
    deliver(frame);
  }
  function hostAdmitPeer(id) {
    // 房主侧新连通 peer：lobby 期校验满员/中局，合法才入册
    if (hostId !== selfId) return;
    if (phase !== "lobby") {
      // 对局中接入：礼貌拒绝（对齐服务器 GAME_STARTED）
      broadcast({ t: MSG.ERROR, code: "GAME_STARTED", msg: "行动已经开始，禁止中途加入" }, id);
      return;
    }
    if (roster.length >= P2P_MAX_PLAYERS) {
      // §13.2：公共房满员礼貌驱逐（私人房同规则——4 人上限一致）
      broadcast({ t: MSG.ERROR, code: "ROOM_FULL", msg: "房间已满：4 人小队已就位" }, id);
      return;
    }
    roster.push(id);
    let ev = {
      t: MSG.PEER_EVENT,
      kind: "join",
      player: { id: id, name: names.get(id) || "队员" },
    };
    broadcast(ev);
    deliver(ev); // 本端 net 同步收（服务器不排异 host）
    pushRoomState();
  }
  function hostRemovePeer(id) {
    if (hostId !== selfId) return;
    let i = roster.indexOf(id);
    if (i < 0) return;
    roster.splice(i, 1);
    let ev = {
      t: MSG.PEER_EVENT,
      kind: "disconnect",
      player: { id: id, name: names.get(id) || "队员" },
    };
    broadcast(ev);
    deliver(ev);
    pushRoomState();
  }

  // ---- 入站路由（makeAction('m') onMessage）----
  function onMeshMessage(text, ctx) {
    if (closed) return;
    let from = ctx && ctx.peerId != null ? ctx.peerId : null;
    let frame = dec(text);
    if (!frame || typeof frame.t !== "string") return;
    if (frame.t === MSG.HELLO) {
      // mesh 级元数据：呼号 + （若有）建房端房间元数据
      if (from != null && typeof frame.name === "string" && frame.name.trim())
        names.set(from, frame.name.trim().slice(0, 24));
      if (frame.room && typeof frame.room === "object") adoptRoomMeta(frame.room, false);
      if (frame.creatorId != null) {
        let claimed = String(frame.creatorId);
        // 只接受当前 mesh 中确实存在的身份，避免任意帧伪造一个永远缺席的房主。
        if (claimed && (claimed === from || claimed === selfId || peers.has(claimed))) {
          if (!creatorId) creatorId = claimed;
          else if (creatorId !== claimed) creatorConflict = true;
          if (creatorId === claimed) scheduleElection();
        }
      }
      if (hostId === selfId && roster.indexOf(from) >= 0) pushRoomState();
      return;
    }
    if (from == null || from === selfId) return; // 自环/无名帧丢弃
    if (!elected && frame.t !== MSG.HELLO) {
      // 选举未定（hostId 未知）：房主帧先入缓冲，选举后按路由重放
      if (inbox.length < 256) inbox.push([from, frame]);
      return;
    }
    if (from !== hostId) {
      // 非房主帧只可能是 toHost（客户端上行）；其余（伪造 fromHost 等）丢弃
      if (frame.t === MSG.TO_HOST && hostId === selfId) {
        deliver({ t: MSG.TO_HOST, from: from, p: frame.p });
      }
      return;
    }
    // 房主帧：按服务器同形转交
    if (frame.t === MSG.TO_HOST) {
      if (hostId === selfId) return; // 不可能：房主不给自己发 toHost
      deliver({ t: MSG.TO_HOST, from: from, p: frame.p });
      return;
    }
    if (frame.t === MSG.FROM_HOST) {
      deliver({ t: MSG.FROM_HOST, p: frame.p });
      return;
    }
    if (frame.t === MSG.START || frame.t === MSG.RESTART || frame.t === MSG.LOBBY) {
      phase = frame.t === MSG.LOBBY ? "lobby" : "playing";
      deliver(frame);
      return;
    }
    if (frame.t === MSG.ROOM_STATE || frame.t === MSG.PEER_EVENT) {
      deliver(frame);
      return;
    }
    if (frame.t === MSG.ERROR) {
      deliver(frame); // 定向错误（ROOM_FULL/GAME_STARTED 驱逐等）
      return;
    }
    // 未知 t：与服务器一致，忽略
  }

  // ---- peer 生命周期 ----
  function onPeerJoin(ctx) {
    let id = ctx && ctx.peerId;
    if (id == null || closed) return;
    peers.add(id);
    names.has(id) || names.set(id, "队员");
    // 新 peer 在场：重播 hello 让对方学到我的呼号/房间元数据
    // （早期 hello 广播时对方尚未连上，迟到者只能靠此刻补发）
    if (elected) broadcastHello();
    if (hostId === selfId && elected) hostAdmitPeer(id);
    scheduleElection(); // 集合变化：重开稳定窗（迟到更小 id 会翻转房主）
  }
  function onPeerLeave(ctx) {
    let id = ctx && ctx.peerId;
    if (id == null || closed) return;
    peers.delete(id);
    names.delete(id);
    if (hostId === selfId && elected) {
      hostRemovePeer(id);
    } else if (elected && id === hostId) {
      // §13.0：host 掉线 v1 = 房间终局（HOST_GONE，同现架构语义）
      deliver({ t: MSG.ERROR, code: "HOST_GONE", msg: "房主已离开，行动终止" });
      return;
    }
    scheduleElection();
  }

  // ---- 策略装载（§13.0：nostr 起手，失败轮换；全败回落由上层提示）----
  async function loadStrategy() {
    if (joinFn) return { name: "injected", joinRoom: joinFn };
    let lastErr = null;
    for (let i = 0; i < STRATEGIES.length; i++) {
      let st = STRATEGIES[i];
      try {
        let joinRoom = await Promise.race([
          st.load(),
          new Promise(function (_, rej) {
            setTimeout(function () {
              rej(new Error("策略 " + st.name + " 装载超时"));
            }, strategyTimeoutMs);
          }),
        ]);
        if (typeof joinRoom === "function") return { name: st.name, joinRoom: joinRoom };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("无可用信令策略");
  }

  function roomConfig() {
    let cfg = { appId: appId, rtcConfig: { iceServers: iceServerList() } };
    if (o.relayUrls && o.relayUrls.length) cfg.relayConfig = { urls: o.relayUrls.slice() };
    if (o.rtcPolyfill) cfg.rtcPolyfill = o.rtcPolyfill;
    return cfg;
  }

  // 实测选型（2026-11-15 家宽全链路实测，工具 scripts/stun-probe.mjs）：
  // 国内秒应答（miwifi/bilibili，对国内玩家拿 srflx 最快）+ 国际备份（twilio 稳、
  // cloudflare 高丢包时通时断）+ Google（国内被墙但海外玩家可达）。ICE 并发查询
  // 全部服务器，死的不应答不拖累活的；Trystero 默认只有 Google+Cloudflare，
  // 对国内玩家等于零可用 STUN——这里显式替换掉。
  // 注意 trystero core: [...rtcConfig?.iceServers ?? defaults, ...turnConfig] ——
  // 传了就整体替换默认，所以海外可达的 Google 必须一并带上。
  function iceServerList() {
    const extra = (o.rtcConfig && o.rtcConfig.iceServers) || [];
    return [
      { urls: ["stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478"] },
      { urls: ["stun:global.stun.twilio.com:3478", "stun:stun.cloudflare.com:3478"] },
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ...extra,
    ];
  }

  async function joinOne(name) {
    let room = await strategy.joinRoom(roomConfig(), name);
    if (room.ready && typeof room.ready.then === "function") await room.ready;
    let self = await room.getSelf();
    return { room: room, selfId: self.peerId };
  }

  // ---- 公共分片探测（§13.2：<4 留驻；≥4 离房试下一片）----
  async function settleRoom() {
    if (!probe) {
      let got = await joinOne(o.roomName);
      room = got.room;
      selfId = got.selfId;
      return;
    }
    let pub = p2pParsePublicRoomName(o.roomName);
    let mode = pub ? pub.mode : MODE_COOP;
    let start = pub ? pub.shard : 1;
    for (let n = start; n <= P2P_PUBLIC_SHARDS; n++) {
      let name = p2pPublicRoomName(mode, n);
      let got = await joinOne(name);
      // 等一个稳定窗再数（首拍部分连接未就绪会低估 occupancy）
      await new Promise(function (resolve) {
        setTimeout(resolve, stabilityMs);
      });
      let count = 1 + countPeers(got.room);
      if (count < P2P_MAX_PLAYERS) {
        room = got.room;
        selfId = got.selfId;
        sock.p2p._label = "公共房 · 分片 " + n;
        sock.p2p.roomName = name;
        return;
      }
      // 满片：离房试下一片（此片的在场者只会看到一次短暂的进出）
      try {
        await got.room.leave();
      } catch {}
      peers.clear(); // 探测期 peer 集不跨片（room#1 的 join 已随离房作废）
      names.clear();
      clearTimeout(settleTimer);
    }
    throw new Error("公共房已满：" + P2P_PUBLIC_SHARDS + " 个分片均已满员，请稍后再试或改用房间码");
  }
  function countPeers(r) {
    try {
      return Object.keys(r.getPeers ? r.getPeers() : {}).length;
    } catch {
      return 0;
    }
  }

  // ---- 房间面挂接：makeAction('m') 单通道 + peer 生命周期 + 错误面 ----
  // room 身份守卫：公共探测换片后，被弃分片的迟到事件（迟到的 onPeerJoin/
  // 残留 onMessage）不得污染新片状态——回调一律先核对 r === room。
  function attach(r) {
    let action = r.makeAction("m");
    sendM = action.send;
    action.onMessage(function (data, ctx) {
      if (r !== room || closed) return;
      onMeshMessage(typeof data === "string" ? data : null, ctx);
    });
    r.onPeerJoin(function (ctx) {
      if (r !== room || closed) return;
      onPeerJoin(ctx);
    });
    r.onPeerLeave(function (ctx) {
      if (r !== room || closed) return;
      onPeerLeave(ctx);
    });
    if (r.onError)
      r.onError(function (err) {
        if (r !== room || closed) return;
        // 信令级致命错（relay-failed 等）：若无 peer 则等同链路断
        if (peers.size === 0 && !elected && sock.onerror) {
          try {
            sock.onerror(err);
          } catch {}
        }
      });
  }

  // 公共匹配会先等待分片稳定，再挂接事件监听。连接可能在这段等待期
  // 已经完成，单靠 onPeerJoin 会漏掉这批 peer，导致两端各自把自己选成房主。
  // 选举前从 Trystero 当前连接表补齐一次，后续增量仍由生命周期事件维护。
  function syncExistingPeers(r) {
    if (!r || typeof r.getPeers !== "function") return;
    let current;
    try {
      current = r.getPeers() || {};
    } catch {
      return;
    }
    for (let id of Object.keys(current)) {
      if (id === selfId) continue;
      peers.add(id);
      names.has(id) || names.set(id, "队员");
    }
  }

  // ---- 装配 ----
  let strategy = null;
  // Defer startup one microtask so callers can install onopen/onerror/onclose
  // immediately after createP2PSocket() returns, including fast environment
  // failures caught before the dynamic import reaches its first await.
  queueMicrotask(function () {
    (async function start() {
      try {
        let envError = p2pEnvironmentError();
        if (envError) throw envError;
        strategy = await loadStrategy();
        sock.p2p.strategy = strategy.name;
        if (o.displayName) sock.p2p._displayName = o.displayName;
        // 私人房：房间名即 slp-{code}，显示码取反解；公共房无码（label 呈现）
        let priv = p2pParsePrivateRoomName(o.roomName);
        displayCode = priv ? priv : null;
        sock.p2p.code = displayCode;
        sock.p2p.roomName = o.roomName;
        if (o.roomMeta) adoptRoomMeta(o.roomMeta, true);
        await settleRoom();
        if (closed) return;
        if (isCreator) creatorId = selfId;
        if (roomMeta) {
          sock.p2p.mode = roomMeta.mode;
          sock.p2p.visibility = roomMeta.visibility;
        }
        attach(room);
        syncExistingPeers(room);
        // 先发建房者身份，再开启稳定窗。收到 hello 的一端会重开稳定窗。
        broadcastHello();
        // 稳定窗后选举（§13.0）
        scheduleElection();
      } catch (e) {
        if (closed) return;
        // 全策略失败：以 close 收口（net 侧 pending 由超时/断链错误收口）
        sock.readyState = 3;
        sock._error = e;
        if (sock.onerror) {
          try {
            sock.onerror(e);
          } catch {}
        }
        if (sock.onclose) {
          try {
            sock.onclose();
          } catch {}
        }
      }
    })();
  });

  return sock;
}
