#!/usr/bin/env node
// scripts/test-trystero.mjs — §13 零服务器批次自测（无网络，内存假 Trystero）
// 覆盖：房间名工具（slp-/slpub- 反解、seed 散列、4 位码字符集）、
// 双端真连线时序（joinRoom 即进房 → 1.5s 稳定窗 → 建房者优先选举 →
// joined 合成字段：you/hostId/seed/mode/visibility/players/team 奇偶）、
// hello 呼号/元数据 mesh 传播（迟到者靠 peerJoin 补发学到）、
// toHost/fromHost 隧道（client.send → host.onClientPayload 带 from；
// host.broadcast → client.onHostPayload）、start 中继与 phase 推进、
// host 掉线 HOST_GONE 终局、公共分片探测（满片自动换片 + roomLabel）、
// 满员礼貌驱逐（第 5 人收 ROOM_FULL）、disconnect 清场。
// 手法：FakeRoom/FakeNet 仿真 trystero 0.27 房间面（makeAction('m')/
// onPeerJoin/onPeerLeave/getSelf/getPeers/leave），经 createNet 的
// env.p2pSocket 注入缝替换 createP2PSocket 的 joinFn——产品代码零改动。

import { createNet } from "../src/net/net.js";
import {
  createP2PDirectory,
  createP2PSocket,
  p2pPrivateRoomName,
  p2pPublicRoomName,
  p2pParsePublicRoomName,
  p2pParsePrivateRoomName,
  seedFromRoomName,
  makeP2PRoomCode,
  p2pEnvironmentError,
  P2P_APP_ID,
  P2P_DIRECTORY_ROOM,
  P2P_RELAY_REDUNDANCY,
} from "../src/net/trystero-transport.js";

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
async function until(fn, ms = 4000, every = 10) {
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

// ---------------- Fake Trystero（0.27 房间面仿真）----------------
class FakeRoom {
  constructor(net, name, selfId) {
    this.net = net;
    this.roomName = name;
    this.selfId = selfId;
    this.peers = new Map(); // peerId → FakeRoom
    this.joinHandlers = [];
    this.leaveHandlers = [];
    this.actionHandlers = new Map(); // ns → handler
    this.left = false;
    this.ready = Promise.resolve();
  }
  getSelf() {
    return Promise.resolve({ peerId: this.selfId });
  }
  getPeers() {
    let o = {};
    this.peers.forEach((_p, id) => {
      o[id] = { userId: id, connection: null, direct: true, hops: 1, roles: [] };
    });
    return o;
  }
  onPeerJoin(h) {
    this.joinHandlers.push(h);
    return () => {};
  }
  onPeerLeave(h) {
    this.leaveHandlers.push(h);
    return () => {};
  }
  onError() {
    return () => {};
  }
  makeAction(ns) {
    let self = this;
    return {
      send(text, opts) {
        let targets =
          opts && opts.target != null
            ? [opts.target]
            : [...self.peers.keys()];
        for (let t of targets) {
          let peer = self.peers.get(t);
          if (peer && !peer.left) peer.receive(ns, text, self.selfId);
        }
        return Promise.resolve();
      },
      onMessage(handler) {
        self.actionHandlers.set(ns, handler);
      },
    };
  }
  receive(ns, text, fromId) {
    // 惰性订阅快照：真实事件源在派发时取监听器（先触发后订阅的注册竞态由
    // macrotask 时序吸收——与真 trystero「连接建立远晚于回调注册」同语义）
    setTimeout(() => {
      if (this.left) return;
      let h = this.actionHandlers.get(ns);
      if (h) h(text, { peerId: fromId, userId: fromId });
    }, 0);
  }
  firePeerJoin(id) {
    setTimeout(() => {
      for (let h of [...this.joinHandlers]) h({ peerId: id, userId: id });
    }, 0);
  }
  firePeerLeave(id) {
    setTimeout(() => {
      for (let h of [...this.leaveHandlers]) h({ peerId: id, userId: id });
    }, 0);
  }
  async leave() {
    if (this.left) return;
    this.left = true;
    for (let [id, peer] of [...this.peers]) {
      this.peers.delete(id);
      peer.peers.delete(this.selfId);
      peer.firePeerLeave(this.selfId);
    }
    this.net.remove(this);
  }
}

class FakeNet {
  constructor(ids = null) {
    this.rooms = new Map(); // roomName → FakeRoom[]
    this.nextId = 1; // 加入序即 id 序：p0001 < p0002 …（先到者最小 id）
    this.ids = Array.isArray(ids) ? ids : null;
  }
  join(name) {
    let id = this.ids && this.ids[this.nextId - 1];
    this.nextId++;
    if (!id) id = "p" + String(this.nextId - 1).padStart(4, "0");
    let room = new FakeRoom(this, name, id);
    let existing = this.rooms.get(name) || [];
    for (let other of existing) {
      room.peers.set(other.selfId, other);
      other.peers.set(room.selfId, room);
      other.firePeerJoin(room.selfId);
      room.firePeerJoin(other.selfId);
    }
    existing.push(room);
    this.rooms.set(name, existing);
    return room;
  }
  remove(room) {
    let list = this.rooms.get(room.roomName) || [];
    let i = list.indexOf(room);
    if (i >= 0) {
      list.splice(i, 1);
      if (!list.length) this.rooms.delete(room.roomName);
    }
  }
}

// ---------------- 装配 ----------------
const STAB = 30; // 测试用选举稳定窗（ms）
function makeNetPair(ids = null) {
  let fake = new FakeNet(ids);
  let joinFn = (config, roomId) => {
    if (!config || config.appId !== P2P_APP_ID)
      throw new Error("joinRoom 配置缺 appId 命名空间");
    return Promise.resolve(fake.join(roomId));
  };
  let mk = () =>
    createNet(
      { events: { on: () => () => {}, emit: () => {} }, player: null },
      {
        p2pSocket: (opts) =>
          // 经注入缝替换策略装载（不触网）；stabilityMs 收短时序
          createP2PSocket({ ...opts, stabilityMs: STAB, joinFn }),
        handshakeTimeoutMs: 6000,
      },
    );
  return { fake, joinFn, mk };
}
async function tick(nets, dt = 0.04, times = 6) {
  // 每拍之间让出事件循环：假 mesh 的投递是 macrotask，同步连拍会饿死在途帧
  for (let i = 0; i < times; i++) {
    for (let n of nets) n.update(dt);
    await sleep(5);
  }
}

async function main() {
  console.log("§13 零服务器（Trystero P2P）— 房间名与工具");

  // ---------------- 运行环境前置条件 ----------------
  console.log("§13.0 Web Crypto 环境前置检查");
  {
    let insecure = p2pEnvironmentError({
      isSecureContext: false,
      crypto: { subtle: { generateKey() {} } },
    });
    ok(insecure && insecure.code === "P2P_INSECURE_CONTEXT", "HTTP 局域网地址给出安全上下文错误");

    let noCrypto = p2pEnvironmentError({ isSecureContext: true, crypto: {} });
    ok(noCrypto && noCrypto.code === "P2P_WEB_CRYPTO_UNAVAILABLE", "缺少 Web Crypto 给出明确错误");

    ok(
      p2pEnvironmentError({
        isSecureContext: true,
        crypto: { subtle: { generateKey() {} } },
      }) === null,
      "HTTPS/localhost 可用 Web Crypto 时通过环境检查",
    );
  }

  ok(p2pPrivateRoomName("ab3d") === "slp-AB3D", "私人房名：slp-{CODE} 大写归一");
  ok(p2pPublicRoomName("pvp", 2) === "slpub-pvp-2", "公共房名：slpub-{mode}-{n}");
  let pub = p2pParsePublicRoomName("slpub-coop-7");
  ok(pub && pub.mode === "coop" && pub.shard === 7, "公共房名反解 mode+n");
  ok(p2pParsePublicRoomName("slpub-pvp-0") === null, "分片 0 非法（1..9）");
  ok(p2pParsePrivateRoomName("slp-AB3D") === "AB3D", "私人房名反解 4 位码");
  ok(p2pParsePrivateRoomName("slpub-coop-1") === null, "公共名不误判为私人房");
  ok(
    seedFromRoomName("slp-AB3D") === seedFromRoomName("slp-AB3D") &&
      seedFromRoomName("slp-AB3D") !== seedFromRoomName("slp-AB3E"),
    "seed 房间名确定性散列（同房同值、异房异值）",
  );
  ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(makeP2PRoomCode()), "4 位码字符集去 0/O/1/I");

  // ---------------- 目录与游戏房间共享信令/ICE 配置 ----------------
  console.log("§13 目录启动与连接配置回归");
  for (const custom of [false, true]) {
    const fake = new FakeNet();
    const configs = new Map();
    const relayUrls = ["wss://relay.test.invalid"];
    const extraServer = { urls: "stun:extra.test.invalid:3478" };
    const rtcPolyfill = function TestPeerConnection() {};
    const overrides = custom ? {
      appId: "saltline-config-regression",
      relayUrls,
      rtcPolyfill,
      rtcConfig: { iceServers: [extraServer], iceTransportPolicy: "relay" },
    } : {};
    const options = {
      ...overrides,
      joinFn: (config, roomId) => {
        configs.set(roomId, config);
        return fake.join(roomId);
      },
    };
    const directory = createP2PDirectory(options);
    let socket;
    const label = custom ? "注入配置" : "默认配置";
    try {
      const ready = await directory.ready;
      ok(ready === directory && !!directory.selfId(), label + "目录 ready 成功并获得身份");
      const roomName = "slp-CFG1";
      socket = createP2PSocket({ ...options, roomName, stabilityMs: STAB, isCreator: true });
      ok(await until(() => socket.readyState === 1), label + "游戏房间启动成功");
      const directoryConfig = configs.get(P2P_DIRECTORY_ROOM);
      const gameConfig = configs.get(roomName);
      ok(!!directoryConfig && !!gameConfig, label + "目录/游戏调用各自房间 ID");
      ok(
        JSON.stringify(directoryConfig) === JSON.stringify(gameConfig),
        label + "目录和游戏的 appId、中继、ICE 完全一致",
      );
      ok(directoryConfig.appId === (custom ? overrides.appId : P2P_APP_ID), label + "appId 正确");
      const servers = directoryConfig.rtcConfig.iceServers;
      const urls = servers.flatMap((server) => server.urls);
      ok(
        urls.includes("stun:stun.miwifi.com:3478") && urls.includes("stun:stun.l.google.com:19302"),
        label + "保留国内与海外 STUN",
      );
      if (custom) {
        ok(
          directoryConfig.relayConfig.urls !== relayUrls &&
            directoryConfig.relayConfig.urls.join() === relayUrls.join() &&
            directoryConfig.relayConfig.redundancy === undefined,
          "显式 relayUrls 复制后覆盖默认中继选择",
        );
        ok(
          directoryConfig.rtcPolyfill === rtcPolyfill && gameConfig.rtcPolyfill === rtcPolyfill,
          "目录与游戏均保留 rtcPolyfill 注入",
        );
        ok(
          servers.includes(extraServer) && directoryConfig.rtcConfig.iceTransportPolicy === "relay",
          "额外 ICE 服务器和其他 rtcConfig 字段保留",
        );
        ok(overrides.rtcConfig.iceServers.length === 1, "构造配置不修改调用方 ICE 列表");
      } else {
        ok(
          directoryConfig.relayConfig.redundancy === P2P_RELAY_REDUNDANCY &&
            directoryConfig.relayConfig.redundancy === 8,
          "目录与游戏默认均采用 8 个中继",
        );
      }
      const record = directory.publish({ code: "CFG1", name: "配置回归房间", host: "房主", players: 1 });
      ok(record && directory.list().some((item) => item.code === "CFG1"), label + "目录可发布房间");
    } finally {
      if (socket) socket.close();
      await directory.close();
    }
  }

  // ---------------- 私人房：双端选举 + joined 合成 ----------------
  console.log("§13 私人房（slp-{code}）：createRoom/joinRoom → 选举 → joined");
  {
    let { fake, mk } = makeNetPair();
    let A = mk(),
      B = mk();
    let hostResolved = null;
    A.createRoom("甲", { mode: "coop", visibility: "private", transport: "p2p" }).then(
      (r) => (hostResolved = r),
    );
    ok(await until(() => hostResolved), "建房 promise 在选举后 resolve");
    let code = hostResolved && hostResolved.code;
    ok(/^[A-Z2-9]{4}$/.test(code || ""), "resolve 携带本地生成的 4 位码：" + code);
    ok(A.mode === "lobby-host", "单端在房：lobby-host（自选举即房主）");
    ok(A.transportKind() === "p2p", "transportKind = p2p");
    ok(A.p2pStrategy() === "injected", "信令策略名可查（注入策略）");
    ok(A.roomVisibility() === "private" && A.roomMode() === "coop", "mode/visibility 回显");
    ok(A.roomCode() === code, "roomCode 回显 4 位码");

    let joinResolved = null,
      joinErr = null;
    B.joinRoom(code, "乙", { transport: "p2p" }).then(
      (r) => (joinResolved = r),
      (e) => (joinErr = e),
    );
    ok(await until(() => joinResolved || joinErr), "加入 promise 收口");
    ok(!joinErr && joinResolved && "seed" in joinResolved, "加入 resolve 带 seed");
    ok(
      A.selfId() !== B.selfId() && (A.isHost() ? !B.isHost() : B.isHost()),
      "双端角色互补（恰好一个 host）",
    );
    // 建房者身份优先于随机 peerId
    ok(A.isHost(), "建房者当选房主");
    ok(await until(() => A.players().length === 2 && B.players().length === 2), "双端 players 收敛 2 人");
    // 呼号收敛等 hello/roomState 往返（host 端先齐，client 端靠广播追平）
    ok(
      await until(
        () =>
          A.players().map((p) => p.name).sort().join(",") === "乙,甲" &&
          B.players().map((p) => p.name).sort().join(",") === "乙,甲",
      ),
      "双端 roster 呼号齐（hello 传播 + roomState 广播）",
    );
    ok(
      A.players().every((p) => p.you === (p.id === A.selfId())) &&
        B.players().every((p) => p.you === (p.id === B.selfId())),
      "players[].you 双端各自正确",
    );
    ok(B.roomMode() === "coop" && B.roomVisibility() === "private", "加入端 mode/visibility 随 hello 采纳");
    await tick([A, B]);
    ok(A.roomLabel() === null, "私人房 roomLabel 为 null（码即门面）");

    // ---------------- toHost/fromHost 隧道 ----------------
    console.log("§13 隧道：toHost/fromHost 走 makeAction('m') 单通道");
    let hostGot = [];
    A.host.onClientPayload((from, payload) => hostGot.push([from, payload]));
    let clientGot = [];
    B.client.onHostPayload((payload) => clientGot.push(payload));
    B.client.send({ k: "ps", id: B.selfId(), seq: 1, pos: [1, 2, 3], fl: 8 });
    await tick([A, B], 0.04, 10);
    ok(
      hostGot.length === 1 && hostGot[0][0] === B.selfId() && hostGot[0][1].k === "ps",
      "client.send(ps) → host.onClientPayload(from=clientId)",
    );
    A.host.broadcast({ k: "peers", states: [{ id: B.selfId(), pos: [1, 2, 3] }] });
    await tick([A, B], 0.04, 10);
    ok(
      clientGot.some((p) => p.k === "peers" && Array.isArray(p.states)),
      "host.broadcast(peers) → client.onHostPayload",
    );

    // ---------------- start 中继 ----------------
    console.log("§13 start 中继与 phase");
    let bStarted = false;
    B.on("start", () => (bStarted = true));
    ok(A.startGame({}) === true, "房主 startGame 放行");
    await tick([A, B], 0.04, 10);
    ok(bStarted, "client 收到 start 事件");
    ok(await until(() => A.mode === "host" && B.mode === "client"), "双端 phase=playing");

    // ---------------- host 掉线终局 ----------------
    console.log("§13 host 掉线 = 房间终局（HOST_GONE）");
    let bGone = false;
    B.on("hostGone", () => (bGone = true));
    A.disconnect("离开房间");
    ok(await until(() => bGone && B.mode === "offline"), "client 收 hostGone 并回 offline");
    B.disconnect("清理");
  }

  // ---------------- pvp 私人房：team 奇偶 ----------------
  console.log("§13 pvp 私人房：加入序 team 0/1（与 §10.1 同语义）");
  {
    let { mk } = makeNetPair();
    let A = mk(),
      B = mk();
    let ra = null;
    A.createRoom("红队人", { mode: "pvp", transport: "p2p" }).then((r) => (ra = r));
    ok(await until(() => ra), "pvp 建房 resolve");
    let rb = null;
    B.joinRoom(ra.code, "蓝队人", { transport: "p2p" }).then((r) => (rb = r));
    ok(await until(() => rb), "pvp 加入 resolve");
    ok(await until(() => A.roomMode() === "pvp" && B.roomMode() === "pvp"), "双端 mode=pvp");
    ok(
      await until(() => {
        let t = A.players().map((p) => p.team).sort().join("");
        return t === "01";
      }),
      "host 端 team 按 id 序 0,1（蓝红各一）",
    );
    ok(
      await until(() => {
        let t = B.players().map((p) => p.team).sort().join("");
        return t === "01";
      }),
      "client 端 team 同序（roomState 广播一致）",
    );
    A.disconnect("清理");
    B.disconnect("清理");
  }

  // ---------------- P2P 选举回归：加入者 Peer ID 更小也不能抢建房者 ----------------
  console.log("§13 P2P 选举：加入者更小 peerId 仍由建房者主导");
  {
    let { mk } = makeNetPair(["p0002", "p0001"]);
    let A = mk(),
      B = mk();
    let created = null,
      joined = null;
    A.createRoom("甲", { mode: "coop", transport: "p2p" }).then((r) => (created = r));
    ok(await until(() => created), "反序 peerId 建房 promise 收口");
    B.joinRoom(created.code, "乙", { transport: "p2p" }).then((r) => (joined = r));
    ok(await until(() => joined), "反序 peerId 加入 promise 收口");
    ok(A.isHost() && !B.isHost(), "加入者 peerId 更小仍由建房者当选房主");
    A.disconnect("清理");
    B.disconnect("清理");
  }

  // ---------------- P2P 房间名：房主可指定 4 位房号 ----------------
  console.log("§13 P2P 房间名：自定义房号可被另一端加入");
  {
    let { mk } = makeNetPair();
    let H = mk();
    let created = null;
    H.createRoom("房主", { mode: "coop", transport: "p2p", roomCode: "ab7q" }).then(
      (r) => (created = r),
    );
    ok(await until(() => created), "自定义房号建房 promise 收口");
    ok(created && created.code === "AB7Q", "自定义房号统一大写并回显");
    H.disconnect("清理");
  }

  // ---------------- 公共匹配：分片探测 ----------------
  console.log("§13.2 公共匹配：slpub 分片探测（满片自动换片）");
  {
    let { fake, mk } = makeNetPair();
    // 预填分片 1：4 个裸房间（满员占位）
    for (let i = 0; i < 4; i++) fake.join("slpub-coop-1");
    let C = mk();
    let r = null,
      err = null;
    C.quickJoin("coop", { transport: "p2p" }).then(
      (x) => (r = x),
      (e) => (err = e),
    );
    ok(await until(() => r || err), "公共匹配 promise 收口");
    ok(!err && r, "公共匹配成功（未落入满片）");
    ok(await until(() => C.mode === "lobby-host"), "空片自选举房主进 lobby");
    ok(C.roomLabel() === "公共房 · 分片 2", "roomLabel = 公共房 · 分片 2（跳过满片 1）");
    ok(C.transportKind() === "p2p", "transportKind = p2p");
    ok(C.roomVisibility() === "public", "公共房 visibility=public");
    ok(C.roomCode() == null, "公共房无房码（roomCode null）");
    ok(fake.rooms.has("slpub-coop-2"), "真实驻留 slpub-coop-2 房");
    C.disconnect("清理");
  }

  // ---------------- 满员驱逐 ----------------
  console.log("§13.2 满员礼貌驱逐（第 5 人收 ROOM_FULL）");
  {
    let { fake, mk } = makeNetPair();
    let H = mk();
    let rh = null;
    H.createRoom("房主", { transport: "p2p" }).then((r) => (rh = r));
    ok(await until(() => rh), "建房 resolve");
    // 3 个裸 peer 补满 4 人
    for (let i = 0; i < 3; i++) fake.join("slp-" + rh.code);
    ok(await until(() => H.players().length === 4), "host roster 4/4");
    let E = mk();
    let evicted = null;
    let errEvt = null;
    E.on("error", (ev) => (errEvt = ev));
    E.joinRoom(rh.code, "第五人", { transport: "p2p" }).then(
      () => (evicted = false),
      (e) => (evicted = e),
    );
    ok(await until(() => evicted !== null || errEvt !== null), "第 5 人收到拒绝");
    ok(
      (evicted && /满/.test(evicted.message)) ||
        (errEvt && (errEvt.code === "ROOM_FULL" || /满/.test(errEvt.msg || ""))),
      "拒绝口径 = ROOM_FULL/房间已满",
    );
    ok(await until(() => E.mode === "offline"), "被驱逐端回 offline");
    H.disconnect("清理");
    E.disconnect("清理");
  }

  // ---------------- ws 通道零回归抽查 ----------------
  console.log("§13 ws 通道零回归（同签名缺 transport 键）");
  {
    // createRoom(name, {mode,visibility})（无 transport）→ 走 WS：注入假 WS 断言不触 p2p
    let wsUsed = false;
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        setTimeout(() => this.onopen && this.onopen(), 0);
      }
      send() {
        wsUsed = true;
      }
      close() {
        this.readyState = 3;
        this.onclose && this.onclose();
      }
    }
    let N = createNet(
      { events: { on: () => () => {}, emit: () => {} }, player: null },
      { WebSocket: FakeWS, url: "ws://127.0.0.1:8787/ws", handshakeTimeoutMs: 3000 },
    );
    let rej = null;
    N.createRoom("w", { mode: "coop", visibility: "public" }).catch((e) => (rej = e));
    await sleep(80);
    ok(wsUsed, "无 transport 键走 WS 通道（信令外发）");
    ok(N.transportKind() === "ws", "transportKind = ws");
    N.disconnect("清理");
  }

  console.log(
    "\n" + (failed ? `FAIL ${failed}` : "ALL PASS") + ` · ${passed} 断言`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("套件崩溃:", e);
  process.exit(1);
});
