#!/usr/bin/env node
// scripts/test-trystero-live.mjs — §13 真实信令链路 E2E（需联网，本机可跑）
//
// 拓扑：两个独立 Node 子进程 = 两个独立 trystero 客户端（trystero 0.27 以
// appId+roomId 去重房间——同进程双 joinRoom 会坍缩成同一客户端，必须分进程）。
// 父进程只做编排与断言，子进程经 stdout 行协议上报事件：
//   阶段 1（裸客户端）：互见 peer / makeAction('m') 双向 ping-pong / selfId 上报
//   阶段 2（产品传输层）：每进程一个 src/net/trystero-transport.js socket 跑在
//     同一真实房间（joinFn=真 trystero joinRoom），上报 joined 帧 hostId/seed 与
//     roomState 名单——断言两端选举一致（= min(peerId)，父进程独立核算）。
//
// Node 无原生 WebRTC：node-datachannel/polyfill 提供 RTCPeerConnection
// （全局挂载 + rtcPolyfill 双保险）；WebSocket 用 Node 24 全局。信令走 nostr
// 公共 relay（trystero 默认 30 个，redundancy 5）——不可达时 exit 2（环境不可用，
// 记 remaining 别硬卡），断言失败 exit 1。
//
// 跑法：node scripts/test-trystero-live.mjs   （结束杀净子进程，父进程自杀）

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const APP_ID = "saltline-p2p-v1";
// 房间名：父进程生成后经 argv 下发 worker（argv: [node, script, --worker, role, ROOM]；
// 子进程各自随机会进不同房，永不相见）
const ROOM =
  process.argv.length >= 5 && process.argv[2] === "--worker"
    ? process.argv[4]
    : "slp-TEST" +
      String((Math.random() * 90 + 10) | 0) +
      String(Date.now() % 100).padStart(2, "0");
const BUDGET_MS = 90000;

let passed = 0,
  failed = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
    console.log("  ok - " + name);
  } else {
    failed++;
    console.log("  FAIL - " + name);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, every = 200) {
  let t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(every);
  }
  try {
    return !!fn();
  } catch {
    return false;
  }
}

// ---------------- worker：单进程单客户端 ----------------
// Chrome 语义垫片（node-datachannel/polyfill 与 trystero 0.27 的三处错位）：
//  1. createDataChannel 后 polyfill 不发 negotiationneeded——而它是 trystero
//     offer 链的唯一起跑信号；补异步触发；
//  2. libdatachannel 在 createDataChannel 时自产 offer（signalingState 立即
//     have-local-offer），trystero 的 createOffer 见非 stable 即早退且不结算
//     initialOffer——在 trystero 首次显式 setLocalDescription 前把
//     signalingState 掩成 stable；
//  3. 隐式 setLocalDescription()（无参=浏览器自建 offer）遇本地 offer 已在 →
//     直接复用，不再二次要约。
// 仅测试链路使用；浏览器产品路径走原生 RTCPeerConnection，无此垫片。
function chromeSemanticsPC(RawPC) {
  const Desc = Object.getOwnPropertyDescriptor(RawPC.prototype, "signalingState");
  const SLD = RawPC.prototype.setLocalDescription;
  return class ChromePC extends RawPC {
    constructor(cfg) {
      super(cfg);
      this._sldStarted = false;
    }
    get signalingState() {
      const real = Desc.get.call(this);
      return !this._sldStarted && real === "have-local-offer" ? "stable" : real;
    }
    setLocalDescription(d) {
      this._sldStarted = true;
      if (d == null) {
        const ld = this.localDescription;
        if (ld && ld.type === "offer") return Promise.resolve();
      }
      return SLD.call(this, d);
    }
    createDataChannel(label, opts) {
      const dc = super.createDataChannel(label, opts);
      setTimeout(() => {
        try {
          if (typeof this.onnegotiationneeded === "function")
            this.onnegotiationneeded();
        } catch {}
      }, 20);
      return dc;
    }
  };
}

async function worker(role) {
  const say = (obj) => console.log(JSON.stringify({ role, ...obj }));
  const { RTCPeerConnection: RawPC } = await import("node-datachannel/polyfill");
  const PC = chromeSemanticsPC(RawPC);
  globalThis.RTCPeerConnection = PC;
  if (process.env.SALTLINE_P2P_TRACE) {
    // 信令流量透视：包装 WebSocket 打印 nostr 收发帧（x tag 前 10 字符即房间主题）
    const RawWS = globalThis.WebSocket;
    globalThis.WebSocket = class TracingWS extends RawWS {
      send(data) {
        try {
          const s = String(data);
          if (s.includes('["EVENT"') || s.includes('["REQ"'))
            console.error(`  [${role}->relay] ${s.slice(0, 200)}`);
        } catch {}
        return super.send(data);
      }
    };
    // 入向帧挂在原型上（trystero 经 makeSocket 建 socket 后再赋 onmessage）
    const origDesc = Object.getOwnPropertyDescriptor(RawWS.prototype, "onmessage");
    if (origDesc && origDesc.configurable) {
      Object.defineProperty(RawWS.prototype, "onmessage", {
        configurable: true,
        get() {
          return this._dbgHandler || (origDesc.get && origDesc.get.call(this));
        },
        set(fn) {
          this._dbgHandler = fn;
          const wrapped = fn
            ? function (ev) {
                try {
                  const s = String(ev.data);
                  if (s.includes('["EVENT"') || s.includes('["OK"') || s.includes('["CLOSED"'))
                    console.error(`  [relay->${role}] ${s.slice(0, 200)}`);
                } catch {}
                return fn.call(this, ev);
              }
            : fn;
          origDesc.set && origDesc.set.call(this, wrapped);
        },
      });
    }
  }
  const { joinRoom, getRelaySockets } = await import("trystero");

  // 信令 relay：缺省即产品同款（trystero 默认 30 池按 appId 确定性选 5——
  // 本机实测其中 3 个可达，配对成立）；SALTLINE_P2P_RELAYS 可显式钉可达集
  const RELAYS = (process.env.SALTLINE_P2P_RELAYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ---- 阶段 1：裸客户端 ----
  const room = joinRoom(
    {
      appId: APP_ID,
      rtcPolyfill: PC,
      ...(RELAYS.length ? { relayConfig: { urls: RELAYS, redundancy: RELAYS.length } } : {}),
    },
    ROOM,
  );
  const self = await room.getSelf();
  say({ ev: "self", phase: 1, id: self.peerId });
  const act = room.makeAction("m");
  act.onMessage((d, ctx) => {
    const text = typeof d === "string" ? d : null;
    say({ ev: "msg", phase: 1, from: ctx.peerId, data: text });
    // 回声：收到 ping 回 pong（双向链路即由 ping-pong 双侧到达证成）
    if (text && text.includes('"ping"'))
      act
        .send(JSON.stringify({ t: "pong", from: role, pt: Date.now() }))
        .catch(() => {});
  });
  room.onPeerJoin((ctx) => {
    say({ ev: "peer", phase: 1, id: ctx.peerId });
    if (role === "A")
      act.send(JSON.stringify({ t: "ping", from: role, pt: Date.now() })).catch(() => {});
  });
  room.onError((err) => say({ ev: "roomError", phase: 1, code: err && err.code, msg: err && err.message }));
  setInterval(() => {
    try {
      const socks = getRelaySockets();
      const states = {};
      for (const k of Object.keys(socks)) states[k.replace("wss://", "")] = socks[k].readyState;
      say({ ev: "diag", phase: 1, peers: Object.keys(room.getPeers()).length, relays: states });
    } catch {}
  }, 3000);

  // ---- 阶段 2：产品传输层（同进程同 joinRoom 真实件）----
  const { createP2PSocket } = await import(
    new URL("../src/net/trystero-transport.js", import.meta.url).href
  );
  const sock = createP2PSocket({
    roomName: ROOM + "P",
    displayName: role === "A" ? "甲" : "乙",
    stabilityMs: 1500,
    rtcPolyfill: PC,
    ...(RELAYS.length ? { relayUrls: RELAYS } : {}), // 缺省走产品同款默认 relay
    joinFn: (cfg, rid) => joinRoom(cfg, rid),
  });
  sock.onmessage = (ev) => {
    let f = null;
    try {
      f = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (f.t === "joined") say({ ev: "joined", phase: 2, frame: f });
    if (f.t === "roomState") say({ ev: "roomState", phase: 2, players: f.players });
  };
  sock.onopen = () => say({ ev: "open", phase: 2 });

  // 常驻上报直至父进程收队（父杀进程即终）
  setInterval(() => say({ ev: "tick" }), 2000);
}

// ---------------- parent：编排 + 断言 ----------------
function spawnWorker(role) {
  const child = spawn(
    process.execPath,
    [import.meta.filename ?? process.argv[1], "--worker", role, ROOM],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    },
  );
  child.lineBuf = "";
  child.events = [];
  child.stdout.on("data", (buf) => {
    child.lineBuf += buf.toString("utf8");
    let i;
    while ((i = child.lineBuf.indexOf("\n")) >= 0) {
      const line = child.lineBuf.slice(0, i).trim();
      child.lineBuf = child.lineBuf.slice(i + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        child.events.push(ev);
        if (
          (ev.ev === "diag" || ev.ev === "roomError") &&
          process.env.SALTLINE_P2P_TRACE
        )
          console.log(`  [${ev.role}] ${line.slice(0, 180)}`);
      } catch {}
    }
  });
  return child;
}

async function main() {
  if (process.argv.includes("--worker")) {
    await worker(process.argv[process.argv.indexOf("--worker") + 1]);
    return; // 常驻（interval 保活），父进程负责杀
  }

  console.log(`trystero live E2E · room=${ROOM} · appId=${APP_ID}（两子进程）`);
  const A = spawnWorker("A");
  const B = spawnWorker("B");
  const killAll = () => {
    for (const c of [A, B]) {
      try {
        c.kill();
      } catch {}
    }
  };

  // selfId 上报（两进程各自）
  const gotSelf = await until(
    () => A.events.some((e) => e.ev === "self") && B.events.some((e) => e.ev === "self"),
    25000,
  );
  if (!gotSelf) {
    console.error("SKIP：信令/身份不可达（nostr 公共 relay 未连上）");
    killAll();
    process.exit(2);
  }
  const idA = A.events.find((e) => e.ev === "self").id;
  const idB = B.events.find((e) => e.ev === "self").id;
  console.log(`  selfId A=${idA.slice(0, 10)}… B=${idB.slice(0, 10)}…`);

  // 互见 peer
  ok(
    await until(
      () => A.events.some((e) => e.ev === "peer" && e.id === idB) && B.events.some((e) => e.ev === "peer" && e.id === idA),
      BUDGET_MS,
    ),
    "双端互见 peer（nostr 信令 + WebRTC DataChannel 建立）",
  );

  // makeAction 双向：A 发 ping（onPeerJoin 即发）→ B 回 pong → 两方向到达
  ok(
    await until(
      () =>
        B.events.some((e) => e.ev === "msg" && e.from === idA && (e.data || "").includes('"ping"')) &&
        A.events.some((e) => e.ev === "msg" && e.from === idB && (e.data || "").includes('"pong"')),
      15000,
    ),
    "makeAction('m') 双向消息（A→B ping · B→A pong）",
  );

  // 最小 peerId（阶段 1）：父进程独立核算——两端各自可算同一 min 的基料
  const minId = idA < idB ? idA : idB;
  console.log(`  min(peerId) 阶段1 = ${minId === idA ? "A" : "B"}`);

  // ---- 阶段 2：产品传输层 joined 合成 ----
  // 注意：阶段 2 是独立新房间（ROOM+"P"），两端各持新 peerId——hostId 断言以
  // 阶段 2 joined 帧自带的 you.id 核算，不与阶段 1 的 selfId 混用
  ok(
    await until(
      () => A.events.some((e) => e.ev === "joined") && B.events.some((e) => e.ev === "joined"),
      BUDGET_MS,
    ),
    "两端传输层各自合成 joined 帧（真实链路选举完成）",
  );
  // 真实链路下对端连接可晚于本端稳定窗：首帧可能各自自选，等重选举收敛后取末帧
  const lastJoined = (c) => {
    const js = c.events.filter((e) => e.ev === "joined");
    return js.length ? js[js.length - 1].frame : null;
  };
  ok(
    await until(
      () => lastJoined(A) && lastJoined(B) && lastJoined(A).hostId === lastJoined(B).hostId,
      12000,
    ),
    "joined.hostId 两端一致（迟到 peer 触发重选举后收敛）",
  );
  const jA = lastJoined(A),
    jB = lastJoined(B);
  const min2 = [jA.you.id, jB.you.id].sort()[0];
  ok(
    jA.hostId === min2,
    "hostId = min(双端 selfId)（阶段 2 房间独立核算一致）",
  );
  ok(
    jA.seed === jB.seed && Number.isInteger(jA.seed),
    "两端 seed 一致（房间名确定性散列）",
  );
  ok(
    await until(
      () =>
        A.events.some((e) => e.ev === "roomState" && Array.isArray(e.players) && e.players.length === 2) &&
        B.events.some((e) => e.ev === "roomState" && Array.isArray(e.players) && e.players.length === 2),
      10000,
    ),
    "roomState 双端 2 人名单（host 广播 + 本地回声）",
  );
  ok(
    await until(() => {
      const last = (c) => {
        const rs = c.events.filter((e) => e.ev === "roomState");
        return rs.length ? rs[rs.length - 1].players.map((p) => p.name).sort().join(",") : "";
      };
      return last(A) === "乙,甲" && last(B) === "乙,甲";
    }, 10000),
    "hello 呼号经真实链路传播（名单收敛：乙,甲）",
  );

  killAll();
  console.log(`\n${failed ? `FAIL ${failed}` : "ALL PASS"} · ${passed} 断言 · room=${ROOM}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("套件崩溃:", e);
  process.exit(1);
});
