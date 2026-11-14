#!/usr/bin/env node
// scripts/test-lagcomp.mjs — PvP 回溯判定（lag compensation）无头断言
// 覆盖（docs/DEPLOY-NETWORK.md Phase 1 / protocol.js LAGCOMP）：
//   纯函数：环形缓冲进出（帧数上限/时效修剪/单调时基/坏输入）、插值（pos lerp /
//     yaw 最短弧 / crouch 取旧帧 / 新旧界外夹持不外推 / 空缓冲 null）、
//     clampShotT（窗内直通 / 上界 now-50 / 下界 now-1000 / NaN 与异时基按当下）
//   host-sim 集成：peers 载 ht 时钟回声、回溯命中（受击者 300ms 前在射线上、
//     现已离开）、命中后扣血作用于当前态（cb.hitPlayer）、当前态未命中、
//     作弊未来时间戳被夹（未夹则命中最新帧的构造用例）、墙体次序保留
//     （回溯命中距离 ≥ wallDist → 墙胜）、无缓冲玩家回退当前态 + 异时基 t 回退当下、
//     合作路径零回归（不炸不判）
//   net 集成：客户端 ht 回声记录 → sh.t 改写为主机时刻估计（无回声退 Date.now）
// 运行：node scripts/test-lagcomp.mjs（退出码 0/1）

import { createHostSim, lagcomp } from "../src/net/host-sim.js";
import { createNet } from "../src/net/net.js";
import { LAGCOMP } from "../src/net/protocol.js";
import { Vector3 } from "../src/vendor/three-r180.js";

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed.push(label);
}
function close(a, b, label, eps = 1e-9) {
  ok(Math.abs(a - b) <= eps, `${label} (${a} ≈ ${b})`);
}
const wrapPi = (r) => ((r % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

// ============ 一、纯函数：环形缓冲 ============

const TAU = Math.PI * 2;
const NOW = 1.76e12; // epoch 域毫秒（与 performance 相对域拉开数量级）

ok(
  LAGCOMP.rewindMinMs < LAGCOMP.rewindMaxMs &&
    LAGCOMP.rewindMaxMs <= LAGCOMP.historyMs &&
    LAGCOMP.historyCap >= Math.ceil((LAGCOMP.historyMs / 1000) * 15),
  "参数自洽：50 < 1000 ≤ 1500，缓冲容量盖住 15Hz×1.5s",
);

{
  const h = [];
  for (let i = 1; i <= 30; i++)
    lagcomp.histPush(h, i * 10, { x: i, y: 0, z: 0 }, 0, false);
  ok(h.length === LAGCOMP.historyCap, `帧数硬上限（30 进 → ${h.length} = cap 24）`);
  ok(h[0].ms === 70, "超限淘汰最旧帧（保留 ms 70..300）");
}
{
  const h = [];
  lagcomp.histPush(h, 1000, { x: 1, y: 0, z: 0 }, 0, false);
  lagcomp.histPush(h, 2600, { x: 2, y: 0, z: 0 }, 0, false);
  ok(
    h.length === 1 && h[0].ms === 2600,
    "时效修剪：historyMs(1500) 外的旧帧进帧时被清",
  );
  const before = h.length;
  lagcomp.histPush(h, 2600, { x: 3, y: 0, z: 0 }, 0, false);
  lagcomp.histPush(h, 2500, { x: 4, y: 0, z: 0 }, 0, false);
  ok(h.length === before && h[0].x === 2, "单调时基：同毫秒/回拨样本丢弃");
  let threw = false;
  try {
    lagcomp.histPush(null, 1, { x: 0, y: 0, z: 0 }, 0, false);
    lagcomp.histPush(h, NaN, { x: 0, y: 0, z: 0 }, 0, false);
  } catch {
    threw = true;
  }
  ok(!threw && h.length === before, "坏输入（非数组/NaN）静默无-op");
}

// ============ 二、纯函数：插值取态 ============

{
  const h = [];
  lagcomp.histPush(h, 1000, { x: 0, y: 0, z: 0 }, 0.1, false);
  lagcomp.histPush(h, 1100, { x: 10, y: 0, z: 5 }, 0.3, true);
  const exact = lagcomp.histAt(h, 1000);
  ok(
    exact && exact.x === 0 && exact.y === 0 && exact.z === 0 && exact.yaw === 0.1,
    "命中帧时刻 → 原值返回",
  );
  const mid = lagcomp.histAt(h, 1050);
  close(mid.x, 5, "pos 中点 lerp x");
  close(mid.z, 2.5, "pos 中点 lerp z");
  close(mid.yaw, 0.2, "yaw 普通插值（未跨 ±π）");
  ok(mid.crouch === false, "crouch 取旧帧（不猜过渡态）");
  ok(lagcomp.histAt(h, 1100).crouch === true, "crouch 新帧时刻取新值");
  const early = lagcomp.histAt(h, 900);
  ok(early && early.x === 0, "早于最旧帧 → 夹持最旧帧（不外推）");
  const late = lagcomp.histAt(h, 9999);
  ok(late && late.x === 10, "晚于最新帧 → 夹持最新帧（不外推）");
  ok(lagcomp.histAt([], 1000) === null, "空缓冲 → null（调用方回退当前态）");
}
{
  const h = [];
  lagcomp.histPush(h, 1000, { x: 0, y: 0, z: 0 }, 350 * (Math.PI / 180), false);
  lagcomp.histPush(h, 1100, { x: 0, y: 0, z: 0 }, 10 * (Math.PI / 180), false);
  const mid = lagcomp.histAt(h, 1050);
  close(
    wrapPi(mid.yaw),
    0,
    "yaw 最短弧：350°→10° 中点走 0°（不走 -340°）",
    1e-9,
  );
}

// ============ 三、纯函数：clampShotT ============

close(lagcomp.clampShotT(NOW - 400, NOW), NOW - 400, "窗内 shotT 直通");
close(lagcomp.clampShotT(NOW + 50, NOW), NOW - 50, "上界：未来戳夹到 now-50");
close(lagcomp.clampShotT(NOW - 99999, NOW), NOW - 1000, "下界：古老戳夹到 now-1000");
close(lagcomp.clampShotT(NaN, NOW), NOW - 50, "NaN → 按当下（即 now-50）");
close(lagcomp.clampShotT("abc", NOW), NOW - 50, "非数值 → 按当下");
close(lagcomp.clampShotT(83000, NOW), NOW - 50, "异时基（performance 相对域 83000）→ 按当下");

// ============ 四、host-sim 集成：回溯判定 ============

const T0 = 1.76e12 + 60000;
const clockRef = { v: T0 };
const wallRef = { on: false };

function makeCtx() {
  return {
    events: { on() {}, emit() {} },
    player: {
      name: "HOST",
      pos: new Vector3(0, 0, -10),
      vel: new Vector3(),
      yaw: 0,
      pitch: 0,
      health: 100,
      alive: true,
      crouching: false,
      sprinting: false,
      ads: 0,
      aboard: false,
    },
    physics: {
      raycast: () =>
        wallRef.on
          ? {
              dist: 2,
              point: new Vector3(0, 1.15, -8),
              normal: new Vector3(0, 0, -1),
              surface: "wall",
            }
          : null,
    },
    enemies: null,
    level: null,
  };
}
function makeNet() {
  const sent = [];
  let payloadHandler = null;
  const net = {
    selfId: () => "HOST",
    roomMode: () => "pvp",
    host: {
      onClientPayload(fn) {
        payloadHandler = fn;
      },
      broadcast(p) {
        sent.push(p);
        return true;
      },
      to(id, p) {
        sent.push(Object.assign({ __to: id }, p));
        return true;
      },
      hostMs: () => clockRef.v,
    },
  };
  net._feed = (id, p) => payloadHandler && payloadHandler(id, p);
  net._sent = sent;
  return net;
}

const ctx = makeCtx();
const net = makeNet();
const roomIds = ["HOST", "C1", "C2"]; // C3 到 S5 才进房（防止 ensureEntry 在原点造幽灵靶）
const api = {
  players: () => roomIds.map((id) => ({ id, name: id })),
};
const sim = createHostSim(ctx, net, api);

// T0 时刻：C1 在射线上（x=0, z=-5），C2 在射线外（x=50）
net._feed("C1", { k: "ps", id: "C1", seq: 1, name: "C1", pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
net._feed("C2", { k: "ps", id: "C2", seq: 1, name: "C2", pos: [50, 0, -5], yaw: 0, hp: 100, fl: 8 });
sim.update(0.07); // 15Hz 节拍：peers 广播 + 缓冲进帧 @T0
{
  const peers = net._sent.find((p) => p.k === "peers");
  ok(peers && peers.ht === T0, "peers 载荷带 ht 主机时钟回声（=hostMs）");
}
// T0+300：C1 离开射线（x=50），C2 走上射线（x=0）
clockRef.v = T0 + 300;
net._feed("C1", { k: "ps", id: "C1", seq: 2, pos: [50, 0, -5], yaw: 0, hp: 100, fl: 8 });
net._feed("C2", { k: "ps", id: "C2", seq: 2, pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
sim.update(0.08); // 缓冲第二帧 @T0+300；roster 当前态 = 新位置

const RAY_O = new Vector3(0, 1.15, -10); // 射线：x=0 直线上 +z 方向
const RAY_D = new Vector3(0, 0, 1);

// S1：回溯命中——受击者 300ms 前在射线上、现在已离开
let s1 = sim.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0);
ok(
  s1 && s1.surface === "player" && s1.part === "torso",
  "回溯命中：受击者 300ms 前在射线上（回溯到 T0 帧命中 torso）",
);
{
  const hit = net._sent.find(
    (p) => p.k === "cb" && p.e === "hitPlayer" && p.id === "C1",
  );
  ok(
    hit &&
      hit.amount === 28 &&
      hit.hp === 72 &&
      hit.part === "torso" &&
      hit.attacker === "HOST",
    "命中后扣血照旧作用于当前态（cb.hitPlayer 28 伤 / hp 100→72 / part）",
  );
}

sim.update(0.07); // 推进时钟过射速校验间隔（60ms）

// S2：当前态未命中——同一射线打“现在”，受击者已离开
let s2 = sim.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0 + 300);
ok(s2 == null, "当前态未命中：受击者已离开射线（夹到 now-50 后插值态仍在射线外）");

sim.update(0.07);

// S3：作弊未来时间戳被夹——C2 现在在射线上，谎报“未来时刻”不 rewarded 最新帧直中：
//     未夹（histAt 晚于最新 → 最新帧 = C2 当前在射线上 → 命中）；夹到 now-50 后
//     插值态在射线外 → 未命中。此用例只有在夹紧生效时才通过。
let s3 = sim.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0 + 300 + 99999);
ok(s3 == null, "作弊未来时间戳被夹：不能借“未来戳”白嫖最新帧命中");

sim.update(0.07);

// S4：墙体次序保留——回溯命中距离(4.8) ≥ wallDist(2) → 墙胜
wallRef.on = true;
let s4 = sim.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0);
wallRef.on = false;
ok(
  s4 && s4.surface === "wall",
  "墙体次序保留：回溯命中距离 < wallDist 才算中（此处墙更近 → wall）",
);

// S5：无缓冲玩家回退当前态 + 异时基 t 按当下——C3 刚入房（ps 后未经过采样节拍），
//     站在 x=10 平行射线上；t 用 performance 相对域小数值（旧语义残留）
roomIds.push("C3"); // 进房（此刻起 syncRosterFromApi 才认它，条目由 ps 直接 ensure）
net._feed("C3", { k: "ps", id: "C3", seq: 1, name: "C3", pos: [10, 0, -5], yaw: 0, hp: 100, fl: 8 });
let s5 = sim.onShot(
  "C1",
  new Vector3(10, 1.15, -10),
  RAY_D.clone(),
  83000,
);
ok(
  s5 && s5.surface === "player" && s5.part === "torso",
  "无缓冲玩家回退当前态 + 异时基 t 回退当下（仍命中当前射线上的 C3）",
);

// ============ 五、合作路径零回归 ============

{
  const clockRef2 = { v: T0 };
  const net2 = makeNet();
  net2.roomMode = () => "coop";
  const ctx2 = makeCtx();
  ctx2.physics.raycast = () => null;
  const sim2 = createHostSim(ctx2, net2, {
    players: () => [{ id: "HOST", name: "HOST" }, { id: "C1" }],
  });
  net2._feed("C1", { k: "ps", id: "C1", seq: 1, pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
  sim2.update(0.1);
  let r = null;
  let threw = false;
  try {
    r = sim2.onShot("HOST", RAY_O.clone(), RAY_D.clone(), Date.now());
  } catch {
    threw = true;
  }
  ok(!threw && r == null, "合作路径零回归：shotT 不消费、缺 physics/enemies 照旧 null");
}

// ============ 六、net 集成：ht 回声 → sh.t 主机时刻估计 ============

{
  const EPOCH = 1.7605e12;
  let fakeMs = 5000;
  const sockets = [];
  class FakeWS {
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.onopen && this.onopen());
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.readyState = 3;
    }
  }
  const netC = createNet(
    { events: { on() {} } },
    { WebSocket: FakeWS, url: "ws://t/ws", nowMs: () => fakeMs },
  );
  const joinP = netC.joinRoom("ABCD", "tester");
  await new Promise((r) => setTimeout(r, 0)); // 等 onopen → hello/joinRoom 发出
  sockets[0].onmessage({
    data: JSON.stringify({
      t: "joined",
      you: "C9",
      hostId: "H1",
      code: "ABCD",
      players: [{ id: "C9", name: "tester" }, { id: "H1", name: "host" }],
    }),
  });
  await joinP;
  ok(netC.mode === "lobby-client", "net 测试底座：mock 握手后进入 client 角色");

  // 无回声：退 Date.now() 跨机 epoch（combat.js 传的 123 必须被改写）
  netC.client.send({ k: "sh", o: [0, 0, 0], d: [0, 0, 1], t: 123 });
  // 回声抵达：ht=EPOCH @fakeMs=5000
  sockets[0].onmessage({
    data: JSON.stringify({
      t: "fromHost",
      p: { k: "peers", ht: EPOCH, states: [] },
    }),
  });
  fakeMs += 250; // 250ms 后开枪
  netC.client.send({ k: "sh", o: [0, 0, 0], d: [0, 0, 1], t: 123 });
  netC.update(1 / 30); // 30Hz 合批冲刷
  const toHost = sockets[0].sent.find((f) => f.t === "toHost");
  const batch = Array.isArray(toHost.p) ? toHost.p : [toHost.p];
  const shs = batch.filter((p) => p.k === "sh");
  ok(
    shs.length === 2 &&
      Math.abs(shs[0].t - Date.now()) < 5000 &&
      shs[0].t !== 123,
    "无回声兜底：sh.t 改写为 epoch 域（Date.now），不复用本地相对时基",
  );
  ok(
    Math.abs(shs[1].t - (EPOCH + 250)) <= 1,
    "ht 回声：sh.t = ht + 经过时间（EPOCH+250，客户端估计的主机时刻）",
  );
  ok(
    typeof netC.host.hostMs === "function" && isFinite(netC.host.hostMs()),
    "net.host.hostMs 面可用（host-sim 统一时基来源）",
  );
}

console.log(`PASS ${passed.length} 断言（lagcomp 回溯判定）`);
