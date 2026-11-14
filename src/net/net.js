// src/net/net.js — Saltline multiplayer transport & room client (MP-CONTRACT §2.2).
//
// Role: one WebSocket per client to ws(s)://location.host/ws
// (dev 5173 -> vite proxy /ws -> 8787; deployed build same-origin 8787).
// Topology is host-authoritative over a pure relay server (MP-BLUEPRINT ①):
//   client -> {t:"toHost",   p}   game payloads (ps/ix/sh/ev), batched at 30Hz
//   host   -> {t:"fromHost", p}   game payloads (peers/snap/ee/cb/ob/rs/rm/ev)
//   host   -> {t:"fromHost", p:{k:"__direct",to,d}} targeted send — the relay
//             (server/rooms.js) broadcasts fromHost to everyone and strips
//             frame-level fields, so addressing lives inside p and each
//             receiving net keeps only its own mail.
//
// IRON RULES enforced here:
//  * Inbound messages are NEVER emitted into context.events (contract §2.2
//    event-bridge rule). net only ever calls context.events.on() to observe
//    local events for outbound relay; consumers (host-sim / puppet /
//    remote-players) receive inbound payloads through their explicit
//    net.host.onClientPayload / net.client.onHostPayload entry points.
//  * update() is fully self-guarded: a transport fault degrades to
//    mode "offline" + local "error" event, it never breaks the frame loop.
//  * peers batch messages are handed to onHostPayload subscribers AS-IS;
//    the 100ms interpolation buffer lives in remote-players (§2.4), not here.
//  * PvP payloads ({k:"pvp", e:"score"|"killed"|"respawn"|"roundEnd"|"teamscore"},
//    MP-PVP §8.1/§10.1) get ZERO special handling: they match no branch below and
//    flow to client.onHostPayload subscribers untouched, e-fields included
//    (team/prot/teamscore/winner included — server relays, net never parses).
//  * Lag compensation clock echo (DEPLOY-NETWORK Phase 1): host-side peers/snap
//    batches carry ht (host epoch ms). A client net records {ht, localAt} per
//    echo and rewrites outbound sh.t to hostTimeEstimate() = ht + elapsed —
//    the shot's host-time estimate (shotT) consumed by host-sim pvpShot.
//    net.host.hostMs() exposes the host-side epoch clock source host-sim uses.
//
// fl bit layout for ps payloads (mirrors MP-BLUEPRINT ③ "ps"):
//   1 crouch | 2 sprint | 4 ads | 8 alive | 16 aboard | 32 fire
import {
  MSG,
  encode,
  decode,
  PROTOCOL_VERSION,
  MODE_COOP,
  MODE_PVP,
  VIS_PRIVATE,
  VIS_PUBLIC,
  normalizeMode,
  normalizeVisibility,
} from "./protocol.js";
// §13 零服务器传输层：本模块只静态依赖其纯函数与 socket 工厂；
// trystero 本体经动态 import 触达（trystero-transport 内部），ws 模式零加载。
import {
  createP2PSocket,
  createP2PDirectory,
  p2pPrivateRoomName,
  p2pPublicRoomName,
  makeP2PRoomCode,
} from "./trystero-transport.js";

// Courtesy export for remote-players.js (§2.4) to decode ps flags identically.
export const PS_FLAGS = {
  crouch: 1,
  sprint: 2,
  ads: 4,
  alive: 8,
  aboard: 16,
  fire: 32,
};

// Bind to src/net/protocol.js (canonical constants, MP-CONTRACT §2.1) with
// literal fallbacks so the frozen v1 wire values hold even if a key style
// differs. protocol.js ships UPPER_SNAKE keys (MSG.HELLO, MSG.TO_HOST, ...).
const M = MSG || {};
const T = {
  hello: M.hello || M.HELLO || "hello",
  createRoom: M.createRoom || M.CREATE_ROOM || "createRoom",
  joinRoom: M.joinRoom || M.JOIN_ROOM || "joinRoom",
  quickJoin: M.quickJoin || M.QUICKJOIN || "quickJoin",
  leave: M.leave || M.LEAVE || "leave",
  start: M.start || M.START || "start",
  restart: M.restart || M.RESTART || "restart",
  lobby: M.lobby || M.LOBBY || "lobby",
  joined: M.joined || M.JOINED || "joined",
  roomState: M.roomState || M.ROOM_STATE || "roomState",
  peerEvent: M.peerEvent || M.PEER_EVENT || "peerEvent",
  toHost: M.toHost || M.TO_HOST || "toHost",
  fromHost: M.fromHost || M.FROM_HOST || "fromHost",
  error: M.error || M.ERROR || "error",
};
const K = {
  ps: M.ps || M.PS || "ps",
  ix: M.ix || M.IX || "ix",
  sh: M.sh || M.SH || "sh",
  ev: M.ev || M.EV || "ev",
  peers: M.peers || M.PEERS || "peers",
};
const PROTO_V = typeof PROTOCOL_VERSION === "number" ? PROTOCOL_VERSION : 1;
const enc = typeof encode === "function" ? encode : JSON.stringify;
const dec = typeof decode === "function" ? decode : fallbackDecode;
// Room mode (MP-PVP §8.1): "coop" default, "pvp" opt-in at createRoom time.
const COOP = MODE_COOP || "coop";
const PVP = MODE_PVP || "pvp";
const normMode =
  typeof normalizeMode === "function"
    ? normalizeMode
    : function (v) {
        return v === PVP ? PVP : COOP;
      };
// Room visibility (MP-PVP §10.1): "private" default, "public" = quickJoin-able;
// orthogonal to mode. Old servers never echo visibility → falls back to private.
const PRIVATE = VIS_PRIVATE || "private";
const PUBLIC = VIS_PUBLIC || "public";
const normVis =
  typeof normalizeVisibility === "function"
    ? normalizeVisibility
    : function (v) {
        return v === PUBLIC ? PUBLIC : PRIVATE;
      };

const PS_INTERVAL = 1 / 15; // local playerState cadence (contract: 15Hz)
const FLUSH_INTERVAL = 1 / 30; // outbound batch flush (contract: 30Hz)
const PING_INTERVAL = 2; // RTT probe cadence (seconds)
const FIRE_FLAG_WINDOW = 0.12; // weapon:fire lights the ps fire bit this long
const QUEUE_CAP = 128; // outbound queue hard cap while the wire is down
const START_DEDUPE = 1.5; // collapse local-optimistic + server echo signals
const DEFAULT_TIMEOUT_MS = 8000; // createRoom/joinRoom handshake deadline
// §13 零服务器握手预算：策略装载+ICE 建连+1.5s 选举稳定窗（公共匹配另有逐片探测）
const P2P_TIMEOUT_MS = 30000;
const P2P_PUBLIC_TIMEOUT_MS = 60000;

const EV_FIRE = "weapon:fire";
const EV_RELOAD = "weapon:reload";
const EV_JUMP = "player:jump";
const EV_LAND = "player:land";

const ERROR_TEXT = {
  ROOM_FULL: "房间已满：4 人小队已就位",
  GAME_STARTED: "行动已经开始，禁止中途加入",
  BAD_CODE: "房间码无效",
  HOST_GONE: "房主已离开，行动终止",
};

function fallbackDecode(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanName(name) {
  let s = typeof name === "string" ? name.trim().slice(0, 24) : "";
  return s || "队员";
}

function r3(n) {
  return typeof n === "number" && isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function xyz(v) {
  if (v && typeof v.x === "number") return [r3(v.x), r3(v.y), r3(v.z)];
  if (Array.isArray(v)) return [r3(v[0]), r3(v[1]), r3(v[2])];
  return null;
}

/**
 * @param {object} context game context ({events, player, ...} per runtime.js)
 * @param {object=} inject test seams: {WebSocket, location, nowMs, url,
 *                    handshakeTimeoutMs, p2pSocket} — defaults resolve browser
 *                    globals. p2pSocket 替身用于 §13 零服务器链路的 Node 测试。
 */
function createNet(context, inject) {
  const env = inject || {};
  const WS =
    env.WebSocket !== undefined
      ? env.WebSocket
      : typeof WebSocket !== "undefined"
        ? WebSocket
        : null;
  const p2pSocketFactory =
    typeof env.p2pSocket === "function" ? env.p2pSocket : createP2PSocket;
  const loc =
    env.location !== undefined
      ? env.location
      : typeof location !== "undefined"
        ? location
        : null;
  const nowMs =
    env.nowMs ||
    function () {
      return typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    };
  const timeoutMs = env.handshakeTimeoutMs || DEFAULT_TIMEOUT_MS;

  // ---- state ---------------------------------------------------------------
  let mode = "offline"; // offline|connecting|lobby-host|lobby-client|host|client
  let role = null; // "host" | "client" — room role, stable across phases
  let ws = null;
  let transportKindValue = null; // null='ws'（服务器中继）| 'p2p'（§13 零服务器）
  let intentionalClose = false;
  let hostGoneEmitted = false;
  let pending = null; // { kind, seed, code, mode, resolve, reject, timer, sentAt }
  let roomCodeValue = null;
  let roomId = null;
  let seedValue = null;
  let roomModeValue = null; // 房间模式 'coop'|'pvp'（MP-PVP §8.1；null=未进房）
  let roomVisValue = null; // 房间可见性 'private'|'public'（MP-PVP §10.1；null=未进房）
  let selfIdValue = null;
  let hostId = null;
  let phase = null; // lobby|playing|debrief|ended (server roomState)
  let localName = "队员";
  let seq = 0;
  let clock = 0; // monotonic seconds accumulated from update(dt)
  let psTimer = 0;
  let flushTimer = 0;
  let pingTimer = 0;
  let lastFireAt = -1e9;
  let startSignalAt = -1e9;
  let rtt = 0; // smoothed round-trip ms
  let hostEcho = null; // {ht, localAt} 最新主机时钟回声（回溯判定时基，仅 client 消费）
  let p2pDirectory = null;
  let p2pDirectoryPromise = null;
  let p2pDirectoryRecordId = null;
  let p2pDirectoryError = null;
  const outQueue = []; // payload objects, flushed as one frame at 30Hz
  const roster = new Map(); // id -> {id,name,ready,alive,aboard,kills,deaths,lastSeen}
  const peerStates = new Map(); // id -> latest ps payload (host + self included)
  const handlers = new Map(); // local pub/sub, isolated from context.events
  const hostPayloadHandlers = []; // net.host.onClientPayload subscribers
  const clientPayloadHandlers = []; // net.client.onHostPayload subscribers
  let logged = 0;

  function netLog(where, err) {
    if (logged < 5) {
      logged++;
      console.error("[net] " + where + ": " + ((err && err.stack) || err));
    }
  }

  function directorySupported() {
    // 测试注入的 p2pSocket 是完整传输替身，不额外建立目录连接；真实浏览器
    // 传输才启用目录，避免旧测试和离线注入环境多出一条 Trystero 房间。
    return typeof env.p2pSocket !== "function" && typeof createP2PDirectory === "function";
  }
  function ensureP2PDirectory() {
    if (!directorySupported()) return Promise.resolve(null);
    if (p2pDirectoryPromise) return p2pDirectoryPromise;
    p2pDirectoryPromise = Promise.resolve()
      .then(() => {
        p2pDirectory = createP2PDirectory({ displayName: localName });
        return p2pDirectory.ready;
      })
      .then((dir) => {
        p2pDirectoryError = null;
        syncP2PDirectoryRecord();
        return dir;
      })
      .catch((err) => {
        p2pDirectoryError = err || new Error("零服务器房间目录连接失败");
        p2pDirectoryPromise = null;
        p2pDirectory = null;
        throw err;
      });
    return p2pDirectoryPromise;
  }
  function syncP2PDirectoryRecord() {
    if (!p2pDirectory || transportKindValue !== "p2p") return;
    if (role !== "host" || !roomCodeValue || !selfIdValue) {
      clearP2PDirectoryRecord();
      return;
    }
    const id = p2pDirectoryRecordId || "slp-" + roomCodeValue;
    p2pDirectoryRecordId = id;
    p2pDirectory.publish({
      id,
      code: roomCodeValue,
      name: "房间 " + roomCodeValue,
      host: localName,
      hostId: selfIdValue,
      mode: roomModeValue || COOP,
      phase: phase || "lobby",
      players: players().length,
    });
  }
  function clearP2PDirectoryRecord() {
    if (p2pDirectory && p2pDirectoryRecordId) p2pDirectory.withdraw(p2pDirectoryRecordId);
    p2pDirectoryRecordId = null;
  }

  // ---- local pub/sub (net's own bus; never wired into context.events) ------
  function on(evt, fn) {
    if (typeof fn !== "function") return function () {};
    let list = handlers.get(evt) || [];
    handlers.set(evt, list);
    list.push(fn);
    return function () {
      off(evt, fn);
    };
  }
  function off(evt, fn) {
    let list = handlers.get(evt);
    if (!list) return;
    let i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  function emitLocal(evt, arg) {
    let list = handlers.get(evt);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](arg);
      } catch (e) {
        netLog('local handler "' + evt + '"', e);
      }
    }
  }

  // ---- wire ----------------------------------------------------------------
  function wsUrl() {
    if (env.url) return env.url;
    if (!loc || !loc.host) return "ws://127.0.0.1:8787/ws"; // headless guard
    return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host + "/ws";
  }
  function wireOpen() {
    return !!(ws && ws.readyState === 1);
  }
  function sendRaw(frame) {
    if (!wireOpen()) return false;
    try {
      ws.send(enc(frame));
      return true;
    } catch (e) {
      netLog("send", e);
      return false;
    }
  }
  function ensureSocket() {
    // §13 零服务器链路：p2p socket 与 WS 同形（readyState/send/close/on*），
    // joined/roomState/peerEvent 由传输层合成喂进 handleFrame，下游零改
    if (transportKindValue === "p2p") {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      intentionalClose = false;
      hostGoneEmitted = false;
      let meta = pending && pending.p2p ? pending.p2p.meta : null;
      ws = p2pSocketFactory({
        roomName:
          pending && pending.p2p ? pending.p2p.roomName : p2pPrivateRoomName(""),
        displayName: localName,
        roomMeta: meta || null,
        probe: !!(pending && pending.p2p && pending.p2p.probe),
        isCreator: !!(pending && pending.p2p && pending.p2p.isCreator),
      });
      ws.onopen = function () {
        // hello 携带呼号；建房端附带房间元数据（mode/visibility 随 mesh 广播）
        let frame = { t: T.hello, v: PROTO_V, name: localName };
        if (meta) frame.room = { mode: meta.mode, visibility: meta.visibility };
        sendRaw(frame);
        ensureP2PDirectory().catch((err) => {
          p2pDirectoryError = err || new Error("零服务器房间目录连接失败");
          netLog("p2p directory", p2pDirectoryError);
        });
        // p2p 无 create/join 请求帧：进房即 joinRoom，joined 待选举后合成
      };
      ws.onmessage = function (ev) {
        try {
          let text = typeof ev.data === "string" ? ev.data : null;
          if (!text) return;
          handleFrame(dec(text));
        } catch (e) {
          netLog("onmessage", e);
        }
      };
      ws.onerror = function () {}; // close() always follows an error
      ws.onclose = function () {
        handleClose();
      };
      return;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    intentionalClose = false;
    hostGoneEmitted = false;
    ws = new WS(wsUrl());
    ws.onopen = function () {
      sendRaw({ t: T.hello, v: PROTO_V, name: localName });
      if (pending) requestRoom(pending);
    };
    ws.onmessage = function (ev) {
      try {
        let text = typeof ev.data === "string" ? ev.data : null;
        if (!text) return;
        handleFrame(dec(text));
      } catch (e) {
        netLog("onmessage", e);
      }
    };
    ws.onerror = function () {}; // close() always follows an error
    ws.onclose = function () {
      handleClose();
    };
  }

  function resetRoomState() {
    role = null;
    mode = "offline";
    roomCodeValue = null;
    roomId = null;
    seedValue = null;
    roomModeValue = null;
    roomVisValue = null;
    selfIdValue = null;
    hostId = null;
    phase = null;
    seq = 0;
    startSignalAt = -1e9;
    hostEcho = null;
    transportKindValue = null;
    roster.clear();
    peerStates.clear();
  }

  function teardown(msg, code) {
    if (pending) {
      let p = pending;
      pending = null;
      clearTimeout(p.timer);
      let err = new Error(msg);
      err.code = code || "ROOM_OP_FAILED";
      p.reject(err);
    }
    intentionalClose = true;
    clearP2PDirectoryRecord();
    if (p2pDirectory) p2pDirectory.close().catch(() => {});
    p2pDirectory = null;
    p2pDirectoryPromise = null;
    try {
      if (ws) ws.close();
    } catch {}
    ws = null;
    outQueue.length = 0;
    resetRoomState();
  }

  function handleClose() {
    let wasP2p = transportKindValue === "p2p";
    // §13：传输层自带具体失败原因（如公共房全满）优先于笼统断链文案
    let p2pWhy =
      wasP2p && ws && ws._error && ws._error.message ? ws._error.message : null;
    clearP2PDirectoryRecord();
    if (p2pDirectory) p2pDirectory.close().catch(() => {});
    p2pDirectory = null;
    p2pDirectoryPromise = null;
    ws = null;
    outQueue.length = 0;
    if (pending) {
      let p = pending;
      pending = null;
      clearTimeout(p.timer);
      let err = new Error(
        p2pWhy ||
          (wasP2p
            ? "零服务器链路中断：公共信令不可达，可回落服务器模式"
            : "信号中断：与港区中继站的链路已断开"),
      );
      err.code = "DISCONNECT";
      p.reject(err);
    }
    resetRoomState();
    if (intentionalClose) return;
    if (hostGoneEmitted) return; // hostGone already told the story
    emitLocal("error", {
      code: "DISCONNECT",
      msg: p2pWhy ||
        (wasP2p
          ? "零服务器链路中断：公共信令不可达，可回落服务器模式"
          : "信号中断：与港区中继站的链路已断开"),
    });
  }

  // ---- room operations -----------------------------------------------------
  // kind: "host" 建房 | "client" 按码加入 | "quick" 免码快速加入（MP-PVP §10.1）
  // p2p（§13）: {roomName, meta, probe} —— 传输层走 Trystero；roomName 为
  // 完整目标房名（私人 slp-{code} / 公共首片 slpub-{mode}-1），probe=true
  // 时传输层按 §13.2 依次探测公共分片
  function roomOp(kind, name, seed, code, roomMode, roomVis, p2p) {
    localName = cleanName(name);
    return new Promise(function (resolve, reject) {
      if (!WS && !p2p) {
        let err = new Error("当前环境不支持 WebSocket，无法建立联机链路");
        err.code = "NO_WS";
        emitLocal("error", { code: "NO_WS", msg: err.message });
        reject(err);
        return;
      }
      if (pending) {
        // supersede: a stale request must not block a fresh menu action
        let old = pending;
        pending = null;
        clearTimeout(old.timer);
        let sup = new Error("上一次房间请求已被取代");
        sup.code = "SUPERSEDED";
        old.reject(sup);
      }
      if (role) {
        // switching rooms: leave quietly, keep the socket if it is alive
        sendRaw({ t: T.leave });
        if (ws && ws.p2p) {
          // p2p 房是传输层私产：换房必须销毁重建（Trystero room 不可改名）
          try {
            ws.close();
          } catch {}
          ws = null;
        }
        resetRoomState();
      }
      // §13 握手预算：策略装载 + ICE 建连 + 1.5s 选举（公共匹配再加逐片探测）
      let tMs = timeoutMs;
      if (p2p)
        tMs =
          env.handshakeTimeoutMs ||
          (p2p.probe ? P2P_PUBLIC_TIMEOUT_MS : P2P_TIMEOUT_MS);
      transportKindValue = p2p ? "p2p" : "ws";
      pending = {
        kind: kind,
        seed: seed,
        code: code,
        mode: roomMode || null,
        vis: roomVis || PRIVATE,
        p2p: p2p || null,
        resolve: resolve,
        reject: reject,
        sentAt: 0,
        timer: setTimeout(function () {
          let msg = p2p
            ? "零服务器链路建立超时：公共信令不可达或对端未出现，可回落服务器模式"
            : kind === "host"
              ? "创建房间超时：港区中继站未应答"
              : kind === "quick"
                ? "快速加入超时：港区中继站未应答"
                : "加入房间超时：港区中继站未应答";
          teardown(msg, "TIMEOUT");
          emitLocal("error", { code: "TIMEOUT", msg: msg });
        }, tMs),
      };
      mode = "connecting";
      ensureSocket();
      if (wireOpen()) requestRoom(pending);
    });
  }

  function requestRoom(p) {
    if (p.p2p) return; // §13：进房即 joinRoom，joined 由选举后合成，无请求帧
    p.sentAt = nowMs();
    if (p.kind === "host") {
      let frame = {
        t: T.createRoom,
        name: localName,
        mode: normMode(p.mode),
        visibility: normVis(p.vis), // §10.1：公开/私密（旧服务器忽略未知字段，零影响）
      };
      if (p.seed != null) frame.seed = p.seed;
      sendRaw(frame);
    } else if (p.kind === "quick") {
      // §10.1：{t:"quickJoin", mode?} —— 服务器匹配公开 lobby 未满房，无则自动建公开房
      let frame = { t: T.quickJoin, name: localName };
      if (p.mode != null) frame.mode = normMode(p.mode);
      sendRaw(frame);
    } else {
      let codeStr = typeof p.code === "string" ? p.code.trim().toUpperCase() : "";
      if (!codeStr) {
        teardown("请输入房间码", "BAD_CODE");
        return;
      }
      sendRaw({ t: T.joinRoom, code: codeStr, name: localName });
    }
  }

  // createRoom(name, {mode, visibility, transport}) — MP-PVP §8.1/§10.1/§13。
  // 兼容旧签名 createRoom(name, seed)：第二参为数字时视为 seed、mode 缺省 coop、
  // visibility 缺省 private，单机/合作路径零变化。
  // §13：transport:'p2p' → 零服务器私人房——本地生成 4 位码（slp-{code} 即
  // Trystero 房名），joinRoom 即建房，无 create/join 信令（§13.2 私人房轨道）。
  function createRoom(name, seedOrOpts) {
    let seed = null;
    let roomMode = COOP;
    let vis = PRIVATE;
    let p2p = null;
    if (typeof seedOrOpts === "number") {
      seed = seedOrOpts;
    } else if (seedOrOpts && typeof seedOrOpts === "object") {
      if (seedOrOpts.seed != null) seed = seedOrOpts.seed;
      if (seedOrOpts.mode != null) roomMode = normMode(seedOrOpts.mode);
      if (seedOrOpts.visibility != null) vis = normVis(seedOrOpts.visibility);
      if (seedOrOpts.transport === "p2p") {
        let requestedCode =
          typeof seedOrOpts.roomCode === "string"
            ? seedOrOpts.roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)
            : "";
        let code = /^[A-Z0-9]{4}$/.test(requestedCode)
          ? requestedCode
          : makeP2PRoomCode();
        p2p = {
          roomName: p2pPrivateRoomName(code),
          meta: { mode: roomMode, visibility: PRIVATE }, // 码房恒私密（§13.2）
          isCreator: true,
        };
        return roomOp("host", name, null, code, roomMode, PRIVATE, p2p);
      }
    }
    return roomOp("host", name, seed, null, roomMode, vis);
  }
  // joinRoom(code, name, opts?) — opts.transport:'p2p' 走 §13 私人房：
  // 输码 joinRoom（slp-{code}），与 ws 模式的码体验一致
  function joinRoom(code, name, opts) {
    if (opts && opts.transport === "p2p") {
      let codeStr = typeof code === "string" ? code.trim().toUpperCase() : "";
      return roomOp("client", name, null, codeStr, null, null, {
        roomName: p2pPrivateRoomName(codeStr),
      });
    }
    return roomOp("client", name, null, code);
  }
  // quickJoin(mode?, opts?) — MP-PVP §10.1/§10.2：免码快速加入。服务器匹配
  // 「公开 + lobby + 未满」房（mode 给了则优先同模式），无命中自动建公开房。
  // §13.2：opts.transport:'p2p' → 零服务器公共匹配：依次探测 slpub-{mode}-{n}
  // 分片（<4 人留驻，≥4 人试下一片），满员驱逐由 host 侧礼貌广播。
  // 8s 握手超时与 createRoom/joinRoom 同源（DEFAULT_TIMEOUT_MS；p2p 见
  // P2P_*_TIMEOUT_MS）。resolve 两种角色统一 {code, seed, players}。
  function quickJoin(mode, opts) {
    let roomMode = mode == null ? null : normMode(mode);
    if (opts && opts.transport === "p2p") {
      let m = roomMode || COOP;
      let shard = Number.isFinite(+opts.shard)
        ? Math.max(1, Math.min(9, (+opts.shard) | 0))
        : 1;
      return roomOp("quick", localName, null, null, m, PUBLIC, {
        roomName: p2pPublicRoomName(m, shard),
        meta: { mode: m, visibility: PUBLIC },
        probe: true,
      });
    }
    return roomOp("quick", localName, null, null, roomMode, PUBLIC);
  }

  function mergePlayers(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      let src = list[i];
      if (!src || src.id == null) continue;
      let r =
        roster.get(src.id) ||
        {
          id: src.id,
          name: "队员",
          ready: false,
          alive: true,
          aboard: false,
          kills: 0,
          deaths: 0,
          team: 0,
          lastSeen: clock,
        };
      if (typeof src.name === "string") r.name = src.name;
      if (typeof src.ready === "boolean") r.ready = src.ready;
      if (typeof src.alive === "boolean") r.alive = src.alive;
      if (typeof src.aboard === "boolean") r.aboard = src.aboard;
      if (typeof src.kills === "number") r.kills = src.kills;
      if (typeof src.deaths === "number") r.deaths = src.deaths;
      // 队伍序号（§10.1）：pvp 0=蓝 1=红；coop 恒 0；旧服务器不带字段保持现值
      if (typeof src.team === "number") r.team = src.team === 1 ? 1 : 0;
      r.lastSeen = clock;
      roster.set(src.id, r);
    }
  }

  function touchRoster(id, ps) {
    if (id == null) return;
    let r = roster.get(id);
    if (!r) {
      r = {
        id: id,
        name: "队员",
        ready: false,
        alive: true,
        aboard: false,
        kills: 0,
        deaths: 0,
        team: 0,
        lastSeen: clock,
      };
      roster.set(id, r);
    }
    r.lastSeen = clock;
    if (ps && typeof ps.fl === "number") {
      r.alive = !!(ps.fl & PS_FLAGS.alive);
      r.aboard = !!(ps.fl & PS_FLAGS.aboard);
    }
  }

  function players() {
    let out = [];
    roster.forEach(function (r) {
      out.push({
        id: r.id,
        name: r.name,
        you: r.id === selfIdValue,
        ready: !!r.ready,
        alive: r.alive !== false,
        aboard: !!r.aboard,
        kills: r.kills || 0,
        deaths: r.deaths || 0,
        team: r.team === 1 ? 1 : 0, // §10.1：pvp 蓝红序号（coop 恒 0），lobby 分组数据源
        lastSeen: r.lastSeen,
      });
    });
    return out;
  }

  // ---- inbound frame routing ----------------------------------------------
  function handleFrame(f) {
    if (!f || typeof f !== "object" || !f.t) return;
    switch (f.t) {
      case T.joined:
        onJoined(f);
        break;
      case T.roomState:
        onRoomState(f);
        break;
      case T.peerEvent:
        onPeerEvent(f);
        break;
      case T.fromHost:
        onFromHost(f);
        break;
      case T.toHost:
        onToHost(f);
        break;
      case T.start:
        onExplicitStart("start");
        break;
      case T.restart:
        onExplicitStart("restart");
        break;
      case T.lobby:
        onExplicitLobby();
        break;
      case T.error:
        onError(f);
        break;
    }
  }

  function onJoined(f) {
    selfIdValue =
      f.you && typeof f.you === "object"
        ? f.you.id != null
          ? f.you.id
          : null
        : f.you != null
          ? f.you
          : null;
    hostId = f.hostId != null ? f.hostId : null;
    roomId = f.roomId != null ? f.roomId : null;
    roomCodeValue = f.code != null ? String(f.code) : null;
    seedValue = f.seed != null ? f.seed : null;
    // 房间模式（MP-PVP §8.1）：服务器回显优先；旧服务器不回显时建房端退回请求值
    roomModeValue =
      f.mode === PVP || f.mode === COOP
        ? f.mode
        : pending && (pending.kind === "host" || pending.kind === "quick")
          ? normMode(pending.mode)
          : COOP;
    // 房间可见性（MP-PVP §10.1）：服务器回显优先；旧服务器不回显时退回请求值
    // （quickJoin 恒 public —— 自动建房必公开，匹配房必有服务器回显）
    roomVisValue =
      f.visibility === PUBLIC || f.visibility === PRIVATE
        ? f.visibility
        : pending
          ? normVis(pending.vis)
          : PRIVATE;
    phase = "lobby";
    hostGoneEmitted = false;
    roster.clear();
    peerStates.clear();
    mergePlayers(f.players);
    if (selfIdValue != null && !roster.has(selfIdValue)) {
      roster.set(selfIdValue, {
        id: selfIdValue,
        name: localName,
        ready: true,
        alive: true,
        aboard: false,
        kills: 0,
        deaths: 0,
        team: 0,
        lastSeen: clock,
      });
    }
    let p = pending;
    if (p) {
      if (p.sentAt && wireOpen()) {
        let measured = nowMs() - p.sentAt;
        if (measured >= 0 && measured < 10000) rtt = measured;
      }
      // P2P 房间没有服务器的 create/join 角色：Trystero 选举出的 hostId
      // 才是唯一房主。WS 房间继续沿用请求类型与服务器回显的旧语义。
      role = p.p2p
        ? hostId === selfIdValue
          ? "host"
          : "client"
        : p.kind === "host" || (p.kind === "quick" && hostId === selfIdValue)
          ? "host"
          : "client";
      mode = role === "host" ? "lobby-host" : "lobby-client";
      clearTimeout(p.timer);
      pending = null;
      p.resolve(
        p.kind === "host"
          ? { code: roomCodeValue, seed: seedValue }
          : p.kind === "quick"
            ? { code: roomCodeValue, seed: seedValue, players: players() }
            : { seed: seedValue, players: players() },
      );
    } else {
      role = selfIdValue != null && hostId === selfIdValue ? "host" : "client";
      mode = role === "host" ? "lobby-host" : "lobby-client";
    }
    emitLocal("roomState", {
      players: players(),
      code: roomCodeValue,
      phase: phase,
      mode: roomModeValue || COOP,
      visibility: roomVisValue || PRIVATE,
    });
    syncP2PDirectoryRecord();
  }

  function applyPhase(next, forceKind) {
    let prev = phase;
    phase = next;
    if (role === "host") mode = next === "playing" ? "host" : "lobby-host";
    else if (role === "client")
      mode = next === "playing" ? "client" : "lobby-client";
    syncP2PDirectoryRecord();
    emitLocal("phase", { phase: next, prev: prev, mode: mode });
    if (next === "playing") {
      let kind = forceKind || (prev === "lobby" || prev == null ? "start" : "restart");
      signalStart(kind);
    } else if (next === "lobby" && prev !== "lobby") {
      signalStart("lobby");
    }
  }

  function signalStart(kind) {
    if (clock - startSignalAt < START_DEDUPE) return;
    startSignalAt = clock;
    emitLocal(kind, { at: clock });
  }

  function onExplicitStart(kind) {
    if (phase !== "playing") applyPhase("playing", kind);
    else signalStart(kind);
  }

  function onExplicitLobby() {
    if (phase !== "lobby") applyPhase("lobby", "lobby");
    else signalStart("lobby");
  }

  function onRoomState(f) {
    if (f.code != null && roomCodeValue == null)
      roomCodeValue = String(f.code);
    // 模式只认合法回显（创建后不可改）；旧服务器不带 mode 字段时保持现值
    if (f.mode === PVP || f.mode === COOP) roomModeValue = f.mode;
    // 可见性同理（§10.1）：只认合法回显，旧服务器不带字段时保持现值
    if (f.visibility === PUBLIC || f.visibility === PRIVATE)
      roomVisValue = f.visibility;
    mergePlayers(f.players);
    emitLocal("roomState", {
      players: players(),
      code: roomCodeValue,
      phase: f.phase || null,
      mode: roomModeValue || COOP,
      visibility: roomVisValue || PRIVATE,
      raw: f,
    });
    syncP2PDirectoryRecord();
    let next = f.phase || null;
    if (next && next !== phase) applyPhase(next);
  }

  function onPeerEvent(f) {
    let pl = (f.player && typeof f.player === "object" ? f.player : {}) || {};
    let kind = typeof f.kind === "string" ? f.kind : "join";
    if (kind === "join") {
      mergePlayers([pl]);
      emitLocal("peerJoin", { player: pl, kind: kind });
    } else {
      if (pl.id != null) {
        roster.delete(pl.id);
        peerStates.delete(pl.id);
      }
      emitLocal("peerLeave", { player: pl, kind: kind });
    }
    syncP2PDirectoryRecord();
  }

  function onError(f) {
    let code = f.code || "UNKNOWN";
    let msg = f.msg || ERROR_TEXT[code] || "联机链路错误";
    if (code === "HOST_GONE") {
      hostGoneEmitted = true;
      resetRoomState(); // room is over: back to offline, roster cleared
      emitLocal("hostGone", { code: code, msg: ERROR_TEXT.HOST_GONE });
      return;
    }
    if (code === "ROOM_FULL" || code === "GAME_STARTED") {
      // §13.2 礼貌驱逐（竞态第 5 人满员 / 对局中接入）：ws 服务器只在加入
      // 握手期发这两码（pending 分支已兜住）；p2p 下驱逐帧可能在 joined
      // 之后才到——已进房也必须退房回 offline，不能留在幽灵大厅
      if (pending) {
        teardown(msg, code);
        emitLocal("error", { code: code, msg: msg });
        return;
      }
      intentionalClose = true;
      try {
        if (ws) ws.close();
      } catch {}
      ws = null;
      outQueue.length = 0;
      resetRoomState();
      emitLocal("error", { code: code, msg: msg });
      return;
    }
    if (pending) {
      teardown(msg, code);
      emitLocal("error", { code: code, msg: msg });
      return;
    }
    emitLocal("error", { code: code, msg: msg });
  }

  // host side: client payloads arrived through the toHost tunnel
  function onToHost(f) {
    let from =
      f.id != null
        ? f.id
        : f.from != null
          ? f.from
          : f.sender != null
            ? f.sender
            : f.playerId != null
              ? f.playerId
              : null;
    let p = f.p;
    let list = Array.isArray(p) ? p : [p];
    for (let i = 0; i < list.length; i++) {
      let item = list[i];
      if (!item || typeof item !== "object") continue;
      if (item.k === K.ev && (item.e === "__ping" || item.e === "ping")) {
        // RTT plumbing only — never surfaced to HostSim. The relay broadcasts
        // fromHost to everyone, so the reply addresses the requester inside
        // the payload (`to`) and every other client drops it.
        enqueue({ k: K.ev, e: "__pong", pt: item.pt, to: from });
        continue;
      }
      if (item.k === K.ps) {
        let pid = item.id != null ? item.id : from;
        let prev = peerStates.get(pid);
        // WS is ordered per connection, but guard anyway: a stale ps must not
        // clobber a newer sample (contract §2.2 "ps 带 seq 丢弃乱序").
        if (
          !prev ||
          typeof item.seq !== "number" ||
          typeof prev.seq !== "number" ||
          item.seq > prev.seq
        ) {
          let norm = Object.assign({}, item, { id: pid });
          peerStates.set(pid, norm);
          touchRoster(pid, norm);
        }
      } else if (item.k === K.peers && Array.isArray(item.states)) {
        // host receiving a peers echo (relay server): bookkeeping only
        for (let s = 0; s < item.states.length; s++) {
          let st = item.states[s];
          if (st && st.id != null && !peerStates.has(st.id))
            peerStates.set(st.id, st);
        }
      }
      for (let h = 0; h < hostPayloadHandlers.length; h++) {
        try {
          hostPayloadHandlers[h](from, item);
        } catch (e) {
          netLog("onClientPayload handler", e);
        }
      }
    }
  }

  // client side: host payloads arrived through the fromHost tunnel
  function onFromHost(f) {
    if (
      f.to != null &&
      f.to !== "*" &&
      selfIdValue != null &&
      f.to !== selfIdValue
    )
      return; // targeted at another player (pure-relay servers broadcast)
    let p = f.p;
    let list = Array.isArray(p) ? p : [p];
    for (let i = 0; i < list.length; i++) {
      let item = list[i];
      if (!item || typeof item !== "object") continue;
      if (item.k === K.ev && (item.e === "__pong" || item.e === "pong")) {
        if (item.to == null || item.to === selfIdValue) recordPong(item.pt);
        continue;
      }
      if (item.k === "__direct") {
        // targeted host send over a broadcast relay: unwrap for its target only
        if (
          item.to == null ||
          selfIdValue == null ||
          item.to !== selfIdValue
        )
          continue;
        if (!item.d || typeof item.d !== "object") continue;
        item = item.d;
      }
      if (typeof item.ht === "number" && isFinite(item.ht))
        hostEcho = { ht: item.ht, localAt: nowMs() }; // 主机时钟回声（peers/snap 批量载荷）
      if (item.k === K.peers && Array.isArray(item.states)) {
        // bookkeeping only; the peers message itself still flows through raw
        for (let s = 0; s < item.states.length; s++) {
          let st = item.states[s];
          if (st && st.id != null) {
            peerStates.set(st.id, st);
            touchRoster(st.id, st);
          }
        }
      }
      // MP-PVP §8.1：pvp 载荷（{k:"pvp", e:"score"|"killed"|"respawn"|"roundEnd"}）
      // 刻意不命中上面任何分支 —— 零特殊处理，连同 e 字段原样交给订阅者。
      for (let h = 0; h < clientPayloadHandlers.length; h++) {
        try {
          clientPayloadHandlers[h](item);
        } catch (e) {
          netLog("onHostPayload handler", e);
        }
      }
    }
  }

  // ---- outbound cadence ----------------------------------------------------
  function enqueue(payload) {
    if (!payload) return false;
    outQueue.push(payload);
    if (outQueue.length > QUEUE_CAP) outQueue.shift();
    return true;
  }

  function flush() {
    if (!outQueue.length) return;
    if (!ws) {
      outQueue.length = 0; // dead wire: time-sensitive payloads are dropped
      return;
    }
    if (ws.readyState !== 1) return; // connecting: keep queued, retry next beat
    let batch = outQueue.length === 1 ? outQueue[0] : outQueue.slice();
    outQueue.length = 0;
    sendRaw(role === "host" ? { t: T.fromHost, p: batch } : { t: T.toHost, p: batch });
  }

  function samplePs() {
    let pl = context && context.player;
    if (!pl || !pl.pos || selfIdValue == null) return null;
    let fl = 0;
    if (pl.crouching) fl |= PS_FLAGS.crouch;
    if (pl.sprinting) fl |= PS_FLAGS.sprint;
    if (typeof pl.ads === "number" ? pl.ads >= 0.35 : !!pl.ads)
      fl |= PS_FLAGS.ads;
    if (pl.alive !== false) fl |= PS_FLAGS.alive;
    if (pl.aboard === true) fl |= PS_FLAGS.aboard;
    if (clock - lastFireAt < FIRE_FLAG_WINDOW) fl |= PS_FLAGS.fire;
    seq = (seq + 1) >>> 0;
    return {
      k: K.ps,
      id: selfIdValue,
      seq: seq,
      t: r3(clock),
      pos: xyz(pl.pos) || [0, 0, 0],
      yaw: r3(pl.yaw),
      pitch: r3(pl.pitch),
      vel: pl.vel ? xyz(pl.vel) || [0, 0, 0] : [0, 0, 0],
      fl: fl,
      hp:
        typeof pl.health === "number"
          ? pl.health
          : typeof pl.hp === "number"
            ? pl.hp
            : 100,
    };
  }

  function probe() {
    if (role !== "client" || !wireOpen()) return;
    enqueue({ k: K.ev, e: "__ping", pt: nowMs() });
  }

  function recordPong(pt) {
    if (typeof pt !== "number") return;
    let sample = nowMs() - pt;
    if (sample >= 0 && sample < 10000) rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
  }

  // ---- lag compensation 时钟（主机回声 → shotT 估计，DEPLOY-NETWORK Phase 1）----
  function epochMs() {
    // epoch 域毫秒：nowMs()（测试可注入）经 timeOrigin 抬到 epoch 域；兜底 Date.now
    try {
      if (
        typeof performance !== "undefined" &&
        performance.now &&
        isFinite(performance.timeOrigin)
      )
        return performance.timeOrigin + nowMs();
    } catch {}
    return Date.now();
  }
  function hostTimeEstimate() {
    // 客户端对“当前主机时刻”的估计：ht + 自回声抵达经过的时间（前向外推）。
    // 无回声时退 Date.now() 跨机 epoch——host 侧 clampShotT 的信任窗 + 夹紧窗
    // 能兜住正常量级的机器钟差。
    if (hostEcho) {
      let est = hostEcho.ht + (nowMs() - hostEcho.localAt);
      if (isFinite(est)) return est;
    }
    return Date.now();
  }

  /**
   * Frame-tick. Order: outbound ps sampling (15Hz) -> batch flush (30Hz) ->
   * RTT probe. Reconnect: v1 has none by contract §0 — a dropped link parks
   * the net in "offline" and lets the UI decide the next move.
   */
  function update(dt) {
    try {
      let step = typeof dt === "number" && dt > 0 ? Math.min(dt, 0.25) : 0;
      clock += step;
      if (!role) return;
      psTimer += step;
      flushTimer += step;
      pingTimer += step;
      if (psTimer >= PS_INTERVAL) {
        psTimer = 0;
        let ps = samplePs();
        if (ps) {
          peerStates.set(selfIdValue, ps);
          touchRoster(selfIdValue, ps);
          if (role === "client") enqueue(ps); // host's own ps is pulled via playersState()
        }
      }
      if (flushTimer >= FLUSH_INTERVAL) {
        flushTimer = 0;
        flush();
      }
      if (pingTimer >= PING_INTERVAL) {
        pingTimer = 0;
        probe();
      }
    } catch (e) {
      netLog("update", e); // never break the frame loop
    }
  }

  // ---- event bridge: local events OUT only (iron rule, §2.2) ---------------
  function bridgeEvent(name, payload) {
    if (name === EV_FIRE) lastFireAt = clock; // lights the ps fire bit (both roles)
    if (!wireOpen()) return;
    let ev = null;
    if (name === EV_FIRE) {
      ev = {
        k: K.ev,
        e: "fire",
        o: xyz(payload && payload.origin) || undefined,
        d: xyz(payload && payload.dir) || undefined,
        ads: payload && typeof payload.ads === "number" ? payload.ads : undefined,
      };
    } else if (name === EV_RELOAD) {
      ev = {
        k: K.ev,
        e: "reload",
        phase: payload ? payload.phase : undefined,
        empty: !!(payload && payload.empty),
      };
    } else if (name === EV_JUMP) {
      ev = { k: K.ev, e: "jump" };
    } else if (name === EV_LAND) {
      ev = {
        k: K.ev,
        e: "land",
        s: payload && typeof payload.speed === "number" ? payload.speed : 0,
      };
    }
    if (!ev) return;
    if (role === "client") {
      // Client events travel up the toHost tunnel; host-sim stamps the sender id
      // and broadcasts them back down to every other client.
      enqueue(ev);
    } else if (role === "host" && net && net.host && typeof net.host.broadcast === "function") {
      // The host does not receive its own fromHost echo, but other clients need
      // the exact origin/direction for remote tracers and impact timing.
      net.host.broadcast(Object.assign(ev, { id: selfIdValue }));
    }
  }

  let bus = context && context.events;
  if (bus && typeof bus.on === "function") {
    // NOTE: subscribe-only. Nothing in this module ever calls bus.emit —
    // inbound network traffic must not re-enter context.events (loop guard).
    bus.on(EV_FIRE, function (p) {
      bridgeEvent(EV_FIRE, p);
    });
    bus.on(EV_RELOAD, function (p) {
      bridgeEvent(EV_RELOAD, p);
    });
    bus.on(EV_JUMP, function (p) {
      bridgeEvent(EV_JUMP, p);
    });
    bus.on(EV_LAND, function (p) {
      bridgeEvent(EV_LAND, p);
    });
  }

  async function discoverP2PRooms(opts) {
    if (!directorySupported()) return [];
    const waitMs =
      opts && Number.isFinite(+opts.waitMs) ? Math.max(500, Math.min(10_000, +opts.waitMs)) : 10_000;
    const active = !!(p2pDirectory && transportKindValue === "p2p");
    const dir = await ensureP2PDirectory();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (dir && dir.list().length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const found = dir ? dir.list() : [];
    if (!active && !(transportKindValue === "p2p" && ws)) {
      dir && dir.close().catch(() => {});
      p2pDirectory = null;
      p2pDirectoryPromise = null;
    }
    return found;
  }

  async function p2pDirectoryStats(opts) {
    if (!directorySupported()) return { online: 0, rooms: [] };
    const waitMs =
      opts && Number.isFinite(+opts.waitMs) ? Math.max(500, Math.min(10_000, +opts.waitMs)) : 2_500;
    const dir = await ensureP2PDirectory();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (dir && (dir.list().length || (typeof dir.peerCount === "function" && dir.peerCount() > 1))) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return {
      online: dir && typeof dir.peerCount === "function" ? dir.peerCount() : 0,
      rooms: dir ? dir.list() : [],
    };
  }

  // ---- public surface (MP-CONTRACT §2.2) -----------------------------------
  let net = {
    // getter keeps the exposed mode in lockstep with every internal
    // transition (teardown / resetRoomState never skip through events)
    get mode() {
      return mode;
    },
    update: update,
    connected: function () {
      return wireOpen();
    },
    roomCode: function () {
      return roomCodeValue;
    },
    // 房间模式（MP-PVP §8.2）：'coop'|'pvp'；未进房恒为 'coop'
    // （单机/合作装配层可无条件按非 pvp 分支处理，零回归）
    roomMode: function () {
      return roomModeValue === PVP ? PVP : COOP;
    },
    // 房间可见性（MP-PVP §10.2）：'private'|'public'；未进房恒为 'private'（缺省语义）
    roomVisibility: function () {
      return roomVisValue === PUBLIC ? PUBLIC : PRIVATE;
    },
    // 传输通道（§13）：null|'ws' = 服务器中继；'p2p' = 零服务器（Trystero）
    transportKind: function () {
      return transportKindValue === "p2p" ? "p2p" : "ws";
    },
    // §13.2 公共房显示标签（「公共房 · 分片 n」；私人房/ws 房恒 null）
    roomLabel: function () {
      if (transportKindValue !== "p2p" || !ws || !ws.p2p) return null;
      return ws.p2p.label || null;
    },
    // §13 信令策略名（nostr…；ws 房恒 null）——UI 提示与诊断用
    p2pStrategy: function () {
      if (transportKindValue !== "p2p" || !ws || !ws.p2p) return null;
      return ws.p2p.strategy || null;
    },
    // 我的队伍序号（MP-PVP §10.2）：pvp 房 0=蓝 1=红；coop 恒 0；未进房 0
    myTeam: function () {
      if (selfIdValue == null) return 0;
      let r = roster.get(selfIdValue);
      return r && r.team === 1 ? 1 : 0;
    },
    selfId: function () {
      return selfIdValue;
    },
    isHost: function () {
      return role === "host";
    },
    players: players,
    latency: function () {
      return role === "host" ? 0 : Math.round(rtt);
    },
    createRoom: createRoom,
    joinRoom: joinRoom,
    quickJoin: quickJoin,
    discoverP2PRooms: discoverP2PRooms,
    p2pDirectoryStats: p2pDirectoryStats,
    p2pDirectoryLeader: function () {
      return p2pDirectory && typeof p2pDirectory.leaderId === "function"
        ? p2pDirectory.leaderId()
        : null;
    },
    setName: function (name) {
      localName = cleanName(name);
      let self = roster.get(selfIdValue);
      if (self) self.name = localName;
    },
    disconnect: function (reason) {
      if (pending) {
        let p = pending;
        pending = null;
        clearTimeout(p.timer);
        let err = new Error(reason || "联机链路已主动断开");
        err.code = "LOCAL_LEAVE";
        p.reject(err);
      }
      if (ws && ws.readyState === 1) {
        try {
          sendRaw({ t: T.leave });
        } catch {}
      }
      intentionalClose = true;
      try {
        if (ws) ws.close();
      } catch {}
      ws = null;
      outQueue.length = 0;
      resetRoomState();
    },
    // match control — host-only, validated here
    startGame: function (opts) {
      if (role !== "host") {
        console.warn("[net] startGame denied: 只有房主可以开始行动");
        return false;
      }
      let frame = { t: T.start };
      if (opts && typeof opts === "object")
        for (let k in opts) frame[k] = opts[k];
      sendRaw(frame);
      applyPhase("playing", "start"); // optimistic; server echo dedupes
      return true;
    },
    restartGame: function (opts) {
      if (role !== "host") {
        console.warn("[net] restartGame denied: 只有房主可以重新部署");
        return false;
      }
      let frame = { t: T.restart };
      if (opts && typeof opts === "object")
        for (let k in opts) frame[k] = opts[k];
      sendRaw(frame);
      applyPhase("playing", "restart");
      return true;
    },
    returnLobby: function () {
      if (role !== "host") {
        console.warn("[net] returnLobby denied: 只有房主可以返回房间");
        return false;
      }
      let frame = { t: T.lobby };
      sendRaw(frame);
      applyPhase("lobby", "lobby");
      return true;
    },
    // host-side face for HostSim
    host: {
      onClientPayload: function (fn) {
        if (typeof fn === "function") hostPayloadHandlers.push(fn);
        return function () {
          let i = hostPayloadHandlers.indexOf(fn);
          if (i >= 0) hostPayloadHandlers.splice(i, 1);
        };
      },
      broadcast: function (payload) {
        if (role !== "host" || !payload) return false;
        return enqueue(payload);
      },
      to: function (playerId, payload) {
        return hostTo(playerId, payload);
      },
      playersState: function () {
        let out = [];
        peerStates.forEach(function (s) {
          out.push({
            k: K.ps,
            id: s.id,
            seq: s.seq,
            t: s.t,
            pos: Array.isArray(s.pos) ? s.pos.slice() : s.pos,
            yaw: s.yaw,
            pitch: s.pitch,
            vel: Array.isArray(s.vel) ? s.vel.slice() : s.vel,
            fl: s.fl,
            hp: s.hp,
          });
        });
        return out;
      },
      // host 权威 epoch 毫秒（回溯判定统一时基）：host-sim 的 ht 回声/缓冲帧/
      // shotT 夹紧共用此时钟；缺注入时 performance.timeOrigin+now / Date.now 兜底
      hostMs: function () {
        return epochMs();
      },
    },
    // client-side face for puppet / remote-players
    client: {
      onHostPayload: function (fn) {
        if (typeof fn === "function") clientPayloadHandlers.push(fn);
        return function () {
          let i = clientPayloadHandlers.indexOf(fn);
          if (i >= 0) clientPayloadHandlers.splice(i, 1);
        };
      },
      send: function (payload) {
        if (role !== "client" || !payload) return false;
        // 回溯判定：sh.t 改写为主机时刻估计（shotT）。t 原为客户端本地时间戳
        // （combat.js performance.now 域），host 侧从未消费——语义收编见
        // protocol.js LAGCOMP 注释；载荷对象为 combat.js 每发新建字面量，改写安全。
        if (payload.k === K.sh) payload.t = hostTimeEstimate();
        return enqueue(payload);
      },
    },
    on: on,
    off: off,
  };

  function hostTo(playerId, payload) {
    if (role !== "host" || !payload || playerId == null) return false;
    // The relay strips frame-level fields and broadcasts fromHost to everyone,
    // so targeted sends travel as a net-internal __direct envelope inside p;
    // receiving nets unwrap it and hand the inner payload only to its target.
    return sendRaw({
      t: T.fromHost,
      p: { k: "__direct", to: playerId, d: payload },
    });
  }

  return net;
}

export { createNet };
export default createNet;
