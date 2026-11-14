#!/usr/bin/env node
// scripts/test-threat-ind.mjs — §11 敌方坐标提醒（火力暴露 + 受击方向）无头断言
// （MP-PVP §11.0-§11.1）。覆盖：
//   host-sim：sh 权威结算广播 {k:"pvp",e:"fire",id,pos} 字段形状（roster 最新
//     pos+眼高，crouch 取低头眼位）/ 每射 4/s 限频（同 shooter 250ms 内第二发合并
//     丢弃，窗口锚在最后一次已播发）/ 250ms 后恢复播发 / shotGap 拒收的射不播 /
//     保护期开火（解除保护那一枪）同样播发 / coop 房零播发 / host 本机
//     emitLocal("pvp:enemyFire") 单次且不回环（无新射不增生）
//   pvp.js：client 载荷翻译 pvp:enemyFire{id,pos}（数组 pos→{x,y,z}，单次）/
//     黑板 context.pvpLastFire={id,pos,at}（HUD 兜底读数，恒为最新一发）
//   combat.js：本地 player:hit → context.pvpLastHitFrom={pos,at}（攻击者按 fromPos
//     水平就近反查 remote-players）/ 查无攻击者（远位/缺 fromPos/死条目）跳过不写 /
//     coop 模式不写
// 运行：node scripts/test-threat-ind.mjs（退出码 0/1）

import { createHostSim } from "../src/net/host-sim.js";
import { createCombat } from "../src/combat/combat.js";
import { createPvpFlow } from "../src/game/pvp.js";
import { Vector3 } from "../src/vendor/three-r180.js";
import { PLAYER_DIMENSIONS } from "../src/core/config.js";

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed.push(label);
}
function eq(a, b, label) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${label} (${JSON.stringify(a)} === ${JSON.stringify(b)})`,
  );
}

function mkBus() {
  const m = new Map();
  const bus = {
    on(n, f) {
      if (!m.has(n)) m.set(n, []);
      m.get(n).push(f);
    },
    emit(n, p) {
      for (const f of m.get(n) || []) f(p);
    },
  };
  bus._handlers = m;
  return bus;
}
const nowMs = () =>
  typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();

// ============ 一、host-sim：开火暴露广播 + 限频 ============

const T0 = 1.76e12 + 340000;
const clockRef = { v: T0 }; // hostMs 注入（限频时基与产线同源）
let wallHit = null;

function makeCtx() {
  const ctx = {
    events: mkBus(),
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
      damage(amount) {
        ctx.player.health = Math.max(0, ctx.player.health - amount);
        if (ctx.player.health <= 0) ctx.player.alive = false;
      },
    },
    physics: { raycast: () => wallHit, nav: null },
    enemies: null,
    level: null,
  };
  return ctx;
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
const sim = createHostSim(ctx, net, {
  players: () => [
    { id: "HOST", name: "HOST", team: 0 },
    { id: "R1", name: "R1", team: 1 },
  ],
});
const pv = sim.pvp();

function step(dt) {
  // 产线口径：hostMs（epoch 毫秒）与房间时钟（秒）同一真实时间流——同步推进，
  // 否则回溯缓冲 histPush 的单调时基会拒收同刻样本（位姿更新进不了判定窗）
  while (dt > 1e-9) {
    const d = Math.min(0.24, dt);
    clockRef.v += d * 1000;
    sim.update(d);
    pv.tick(d);
    dt -= d;
  }
}
function fires(byId) {
  return net._sent.filter(
    (p) => p.k === "pvp" && p.e === "fire" && (byId === undefined || p.id === byId),
  );
}
const enemyFireEvents = [];
ctx.events.on("pvp:enemyFire", (ev) => enemyFireEvents.push(ev));
function shoot(id, x, y, z, dx, dy, dz) {
  return sim.onShot(id, new Vector3(x, y, z), new Vector3(dx, dy, dz), clockRef.v);
}
function feedAlive(id, x, y, z, fl = 8) {
  net._feed(id, {
    k: "ps",
    id,
    seq: (feedAlive._s = (feedAlive._s || 0) + 1),
    pos: [x, y, z],
    yaw: 0,
    hp: 100,
    fl,
  });
}

feedAlive("R1", 0, 0, -5); // 红队敌人在 (0,0,-5)
step(0.07);
pv.startRound();
pv.startPlay();
step(0.07);

// —— 1. 字段形状：站立眼高位（roster pos + PLAYER_DIMENSIONS.eye），n2 取整 ——
{
  const r = shoot("R1", 0, 1.68, -5, 1, 0, 0); // 朝 +x 空射（不打 HOST）
  const f = fires("R1");
  ok(
    r !== undefined && f.length === 1,
    "sh 权威结算：开火即广播一发 {k:pvp,e:fire}",
  );
  eq(
    { k: f[0].k, e: f[0].e, id: f[0].id, pos: f[0].pos },
    { k: "pvp", e: "fire", id: "R1", pos: [0, PLAYER_DIMENSIONS.eye, -5] },
    "字段形状：id=shooter / pos=[x, y+眼高, z]（roster 最新位姿）",
  );
  ok(
    f[0].pos.length === 3 && f[0].pos.every((n) => typeof n === "number" && isFinite(n)),
    "字段形状：pos 恒为三维有限数数组",
  );
}

// —— 2. 限频：同 shooter 250ms 内第二发合并丢弃（窗口锚在最后一次已播发）——
{
  step(0.1); // 房间时钟 +0.1s 过 shotGap 60ms；hostMs 同步 +100ms
  shoot("R1", 0, 1.68, -5, 1, 0, 0);
  ok(fires("R1").length === 1, "限频：250ms 内第二射合并丢弃（不新增播发）");
  // —— 3. 250ms 窗口过后恢复播发 ——
  step(0.3); // +300ms > 250ms 窗口
  shoot("R1", 0, 1.68, -5, 1, 0, 0);
  ok(fires("R1").length === 2, "限频恢复：距上次播发 >250ms 的新射照常播发（累计 2）");
  // —— 4. shotGap 拒收的射不播（射速粗校验在前，作弊流零暴露）——
  shoot("R1", 0, 1.68, -5, 1, 0, 0); // 房间时钟零推进（<60ms），onShot 整体拒收
  ok(fires("R1").length === 2, "shotGap 拒收：粗校验拦下的射不产生 fire 播发");
}

// —— 5. 蹲伏眼位：ps 报 crouch 后取低头眼高 ——
{
  step(0.3); // 过限频窗（上一播发在 300ms 前）
  feedAlive("R1", 2, 0, -5, 1 | 8); // crouch + alive
  step(0.08); // 新位姿进回溯缓冲
  shoot("R1", 2, 1.05, -5, 1, 0, 0);
  const f = fires("R1");
  eq(
    f[f.length - 1].pos,
    [2, PLAYER_DIMENSIONS.crouchEye, -5],
    "蹲伏眼位：crouch 态 pos.y 取 crouchEye（低头位）",
  );
}

// —— 6. 保护期开火（解除保护那一枪）同样播发 ——
{
  feedAlive("R1", 0, 0, -5); // R1 回到 HOST 射线上（站立）
  step(0.08);
  step(0.3); // 过 R1 限频窗
  for (let i = 0; i < 4; i++) {
    // HOST 四枪放倒 R1（躯干 28×4）
    shoot("HOST", 0, 1.15, -10, 0, 0, 1);
    step(0.08);
  }
  step(1.1); // 重生派单（1s）：R1 得 in 3s + prot 3s 保护窗
  feedAlive("R1", 27.4, 0, 22.4); // R1 落红队出生点（保护期内）
  step(0.3); // 过限频窗；房间时钟 ≈ 派单后 +0.5s，仍在 6s 保护窗内
  net._sent.length = 0;
  shoot("R1", 27.4, 1.68, 22.4, 0, 0, -1); // 保护期内开火
  const f = fires("R1");
  const pe = net._sent.find((p) => p.k === "pvp" && p.e === "protEnd");
  ok(
    f.length === 1 && f[0].pos[0] === 27.4 && f[0].pos[2] === 22.4,
    "保护期开火：解除保护那一枪同样广播 fire（pos=重生落点眼位）",
  );
  ok(!!pe && pe.id === "R1", "保护期开火：protEnd 照常随 sh 播发（语义不变）");
}

// —— 7. host 本机 emitLocal 单次 + 不回环：无新射不增生 ——
{
  enemyFireEvents.length = 0;
  const before = fires().length;
  step(0.08);
  shoot("HOST", 0, 1.68, -10, 0, 0, -1); // host 自身开火（combat 房主路径同入口）
  ok(
    enemyFireEvents.length === 1 && enemyFireEvents[0].id === "HOST",
    "host 本机：自身开火 emitLocal pvp:enemyFire 恰一次（不经中继回声）",
  );
  eq(
    enemyFireEvents[0].pos,
    { x: 0, y: PLAYER_DIMENSIONS.eye, z: -10 },
    "host 本机：emitLocal 载荷 {id,pos:{x,y,z}} 与广播字段同源",
  );
  for (let i = 0; i < 6; i++) step(0.07); // 空转多帧：无回环、无重播
  ok(
    enemyFireEvents.length === 1 && fires().length === before + 1,
    "不回环：本地事件/广播不诱发新射（计数稳定）",
  );
}

// —— 8. coop 房零播发（pvpMode 门，合作模式零回归）——
{
  const c2 = makeCtx();
  const n2 = makeNet();
  n2.roomMode = () => "coop";
  const s2 = createHostSim(c2, n2, {
    players: () => [
      { id: "HOST", name: "HOST", team: 0 },
      { id: "B2", name: "B2", team: 0 },
    ],
  });
  n2._feed("B2", { k: "ps", id: "B2", seq: 1, pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
  s2.update(0.07);
  s2.onShot("B2", new Vector3(0, 1.68, -5), new Vector3(1, 0, 0), T0);
  ok(
    !n2._sent.some((p) => p.k === "pvp"),
    "coop 门：合作房开火零 pvp 播发（单机/合作零回归）",
  );
}

// ============ 二、pvp.js：client 翻译 + 黑板 ============

// Node 无头垫片：pvp 流程构造期注册 document/window 级监听（只挂不触发）
globalThis.document =
  globalThis.document || { addEventListener() {}, hidden: false };
globalThis.addEventListener = globalThis.addEventListener || (() => {});

{
  const bus = mkBus();
  const seen = [];
  bus.on("pvp:enemyFire", (ev) => seen.push(ev));
  const ctx2 = {
    events: bus,
    render: { post: {} },
    player: {
      enabled: false,
      pos: new Vector3(),
      aboard: false,
      reset() {},
      cancelPvpRespawn() {},
    },
    level: { cinematicPath: [], playerStart: { pos: new Vector3(), yaw: 0 } },
    hud: { message() {}, show() {}, setObjective() {}, radio() {}, setPrompt() {}, reset() {} },
    input: { setGameplay() {}, exitLock() {}, mode: "lock", locked: false, pressed: () => false },
    camera: { position: new Vector3(), lookAt() {}, rotation: { z: 0 }, fov: 70, updateProjectionMatrix() {} },
    time: { t: 0 },
    params: {},
    audio: {},
    weapon: {},
    fx: { clear() {} },
    combat: { reset() {} },
    enemies: { clear() {} },
  };
  let hostPayloadFn = null;
  ctx2.net = {
    stub: false,
    mode: "client",
    on() {},
    isHost: () => false,
    selfId: () => "C1",
    roomMode: () => "pvp",
    players: () => [
      { id: "H1", name: "H1", team: 0 },
      { id: "C1", name: "C1", team: 1 },
    ],
    client: { onHostPayload(fn) { hostPayloadFn = fn; } },
    disconnect() {},
  };
  const menus = {
    applySettings() {}, show() {}, locationCard() {}, setRoundEnd() {}, setDebrief() {}, setDead() {},
    screen: "none", panelOpen: false,
  };
  createPvpFlow(ctx2, { menus }).start({ mp: !0 });
  ok(typeof hostPayloadFn === "function", "client 底座：载荷翻译通道已挂");

  // —— 9. 翻译单次 + 字段：数组 pos → {x,y,z} ——
  hostPayloadFn({ k: "pvp", e: "fire", id: "H1", pos: [3.5, 1.68, -2] });
  ok(
    seen.length === 1 && seen[0].id === "H1",
    "client 翻译：fire 载荷 → pvp:enemyFire 恰一次",
  );
  eq(seen[0].pos, { x: 3.5, y: 1.68, z: -2 }, "client 翻译：pos 数组规整为 {x,y,z}");

  // —— 10. 黑板 pvpLastFire：HUD 兜底读数，恒为最新一发 ——
  ok(
    !!ctx2.pvpLastFire &&
      ctx2.pvpLastFire.id === "H1" &&
      ctx2.pvpLastFire.at > nowMs() - 2000 &&
      ctx2.pvpLastFire.pos.x === 3.5,
    "黑板：context.pvpLastFire={id,pos,at}（HUD 兜底读数）",
  );
  hostPayloadFn({ k: "pvp", e: "fire", id: "H9", pos: [-1, 1, 4] });
  ok(
    ctx2.pvpLastFire.id === "H9" && ctx2.pvpLastFire.pos.z === 4,
    "黑板：续射续曝——黑板恒为最近一发（latest-wins）",
  );
  // 未知 e 字段静默（向前兼容）：不炸、不误发事件
  hostPayloadFn({ k: "pvp", e: "nope" });
  ok(seen.length === 2, "向前兼容：未知 pvp.e 字段零事件零异常");
}

// ============ 三、combat.js：受击方向黑板 ============

function combatCtx(roomMode) {
  const bus = mkBus();
  let remoteList = [];
  const ctx3 = {
    events: bus,
    physics: { raycast: () => null },
    remotePlayers: {
      list: () => remoteList,
      byId: (id) => remoteList.find((p) => p.id === id) || null,
    },
    net: {
      stub: false,
      mode: "client",
      selfId: () => "C1",
      roomMode: () => roomMode,
      players: () => [
        { id: "C1", name: "C1", team: 0 },
        { id: "R7", name: "R7", team: 1 },
      ],
      client: { send() {} },
    },
  };
  ctx3._bus = bus;
  ctx3._remotes = (l) => (remoteList = l);
  return ctx3;
}
const ATTACKER_POS = new Vector3(3, 0, 7); // 攻击者脚位
const ATTACKER_EYE = new Vector3(3, PLAYER_DIMENSIONS.eye, 7.2); // 射击眼位（含插值时差）

// —— 11. 本地 player:hit → 黑板 {pos,at}（攻击者位姿取自 remote-players 条目）——
{
  const ctx3 = combatCtx("pvp");
  createCombat(ctx3);
  ctx3._remotes([{ id: "R7", pos: ATTACKER_POS.clone(), yaw: 0, crouch: false, alive: true }]);
  ctx3._bus.emit("player:hit", { amount: 28, fromPos: ATTACKER_EYE.clone() });
  ok(
    !!ctx3.pvpLastHitFrom && ctx3.pvpLastHitFrom.at > nowMs() - 2000,
    "受击黑板：player:hit 瞬间写入 context.pvpLastHitFrom={pos,at}",
  );
  eq(
    ctx3.pvpLastHitFrom.pos,
    { x: 3, y: 0, z: 7 },
    "受击黑板：pos=攻击者 remote-players 条目脚位快照（HUD 扇形数据源）",
  );

  // —— 12. 查无攻击者：远位 fromPos 跳过不写（黑板保持上一发）——
  const stamp = JSON.stringify(ctx3.pvpLastHitFrom);
  ctx3._bus.emit("player:hit", { amount: 6, fromPos: new Vector3(50, 1.68, 50) });
  ok(
    JSON.stringify(ctx3.pvpLastHitFrom) === stamp,
    "查无跳过：fromPos 就近反查失败（50m 外）不写黑板",
  );

  // —— 13. 环境伤缺 fromPos：跳过不写 ——
  ctx3._bus.emit("player:hit", { amount: 10, fromPos: null });
  ok(
    JSON.stringify(ctx3.pvpLastHitFrom) === stamp,
    "查无跳过：fromPos 缺失（坠落等环境伤）不写黑板",
  );

  // —— 14. 死亡攻击者条目跳过 ——
  ctx3._remotes([{ id: "R7", pos: ATTACKER_POS.clone(), yaw: 0, crouch: false, alive: false }]);
  ctx3._bus.emit("player:hit", { amount: 28, fromPos: ATTACKER_EYE.clone() });
  ok(
    JSON.stringify(ctx3.pvpLastHitFrom) === stamp,
    "查无跳过：已阵亡条目不认作攻击者（黑板不被旧值污染为死位姿）",
  );
}

// —— 15. coop 模式：player:hit 不写黑板（pvpMode 门）——
{
  const ctx3 = combatCtx("coop");
  createCombat(ctx3);
  ctx3._remotes([{ id: "R7", pos: ATTACKER_POS.clone(), yaw: 0, crouch: false, alive: true }]);
  ctx3._bus.emit("player:hit", { amount: 28, fromPos: ATTACKER_EYE.clone() });
  ok(
    ctx3.pvpLastHitFrom === undefined,
    "coop 门：合作受击不写 pvpLastHitFrom（单机/合作零回归）",
  );
}

// ============ 汇总 ============
console.log(`[test-threat-ind] ${passed.length} 项断言全绿`);
for (const p of passed) console.log("  ok -", p);
