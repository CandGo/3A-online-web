#!/usr/bin/env node
// scripts/test-team-pvp.mjs — §10 团队对抗无头断言（MP-PVP §10.0-§10.2）
// 覆盖：
//   host-sim：友军免伤 / 敌队命中 / 重生保护吞伤（cb.impact 表现照常）/ 收 sh 解除
//     保护（protEnd 广播）/ 队伍比分累计 / board 带 team / 20 杀团队终局 / 无时间上限
//     胜 / 平局 / 蓝队点集选点（闸门侧坐标带 + 离击杀者最远）/ 红队点集选点（码头带）
//   weapon：∞ 备弹 refillPlan（reload 后 reserve 不减）/ 合作 min 语义零回归 /
//     canStartReload 门（备弹空仅 pvp 放行）
//   pvp.js：teamscore→context.pvpTeams 黑板 / respawn-prot-protEnd 黑板生命周期 /
//     roundEnd 团队字段（run.teamResult）/ context.pvpMyTeam
//   player.js：重生落地 invulnerable 3s（伤害吞）/ weapon:fire 提前解除 / 计时到期
//   combat.js：pvpVisualHit 跳队友（无 hitmarker）/ 敌队视觉命中 / 保护期目标跳过
// 运行：node scripts/test-team-pvp.mjs（退出码 0/1）

import { createHostSim, PVP_TEAM_SPAWNS } from "../src/net/host-sim.js";
import { createCombat } from "../src/combat/combat.js";
import { createPlayer } from "../src/player/player.js";
import { refillPlan, canStartReload } from "../src/weapons/weapon.js";
import { createPvpFlow } from "../src/game/pvp.js";
import { Vector3 } from "../src/vendor/three-r180.js";

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

// ============ 一、host-sim：团队死斗权威链 ============

const T0 = 1.76e12 + 120000;
const clockRef = { v: T0 };
const wallRef = { hit: null };

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
        // 与真实 player.damage 同口径的极简替身（roster 层的门已挡保护期）
        ctx.player.health = Math.max(0, ctx.player.health - amount);
        if (ctx.player.health <= 0) ctx.player.alive = false;
      },
    },
    physics: {
      raycast: () => wallRef.hit,
      nav: null,
    },
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

const RAY_O = new Vector3(0, 1.15, -10); // HOST 眼位 → +z 射线
const RAY_D = new Vector3(0, 0, 1);

const ctx = makeCtx();
const net = makeNet();
const api = {
  players: () => [
    { id: "HOST", name: "HOST", team: 0 },
    { id: "B2", name: "B2", team: 0 },
    { id: "R1", name: "R1", team: 1 },
  ],
};
const sim = createHostSim(ctx, net, api);
const pv = sim.pvp();

function step(dt) {
  // sim.update 单帧夹 0.25s 上限（自兜），长等待拆帧推进——与产线逐帧节奏等价
  while (dt > 1e-9) {
    const d = Math.min(0.24, dt);
    sim.update(d);
    pv.tick(d);
    dt -= d;
  }
}
function lastPayload(k, e) {
  for (let i = net._sent.length - 1; i >= 0; i--) {
    const p = net._sent[i];
    if (p.k === k && (e === undefined || p.e === e)) return p;
  }
  return null;
}
function sentCount(k, e, pred) {
  let n = 0;
  for (const p of net._sent)
    if (p.k === k && p.e === e && (!pred || pred(p))) n++;
  return n;
}
function shootHost() {
  return sim.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0);
}
function shootR1AtHost() {
  // R1 眼位 (0,1.15,-5) → -z 打 HOST
  return sim.onShot("R1", new Vector3(0, 1.15, -5), new Vector3(0, 0, -1), T0);
}
function feedAlive(id, x, y, z) {
  net._feed(id, {
    k: "ps",
    id,
    seq: (feedAlive._s = (feedAlive._s || 0) + 1) + id.length * 1000 + (feedAlive[id] = (feedAlive[id] || 0) + 1) * 7,
    pos: [x, y, z],
    yaw: 0,
    hp: 100,
    fl: 8,
  });
}

// 底座：三人入房，R1/B2 就位（R1 在 HOST 射线上，B2 在旁）
feedAlive("R1", 0, 0, -5);
feedAlive("B2", 5, 0, -5);
sim.update(0.07);
pv.startRound();
pv.startPlay();
step(0.07);
ok(pv.active() === true, "底座：pvp 回合激活（startRound+startPlay）");
eq(pv.team("R1"), 1, "分队表：R1 归红队（服务器 team 字段）");
eq(pv.team("B2"), 0, "分队表：B2 归蓝队");
{
  const board = lastPayload("pvp", "score").board;
  ok(
    Array.isArray(board) && board.every((b) => b.team === 0 || b.team === 1),
    "§10.1 score board 每项带 team:0|1",
  );
}

// —— 友军免伤：HOST 打 B2（同队）零结算零载荷 ——
{
  net._sent.length = 0;
  const r = sim.onShot(
    "HOST",
    new Vector3(5, 1.15, -10),
    RAY_D.clone(),
    T0,
  );
  ok(
    r == null && sentCount("cb", "hitPlayer", (p) => p.id === "B2") === 0,
    "友军免伤：队友在射线上也无 cb.hitPlayer（射线穿过）",
  );
}

// —— 敌队命中 + 团队比分：HOST 四枪放倒 R1 ——
{
  step(0.07); // 过射速粗校验窗（上一发友军测试弹的 60ms shotGap）
  net._sent.length = 0;
  for (let i = 0; i < 4; i++) {
    shootHost();
    step(0.07);
  }
  const hits = net._sent.filter((p) => p.k === "cb" && p.e === "hitPlayer");
  ok(
    hits.length === 4 && hits.every((p) => p.id === "R1" && p.attacker === "HOST"),
    "敌队命中：4×28 伤全部 cb.hitPlayer（attacker=HOST）",
  );
  const killed = lastPayload("pvp", "killed");
  eq(
    { by: killed.by, victim: killed.victim },
    { by: "HOST", victim: "R1" },
    "击杀流：HOST 放倒 R1",
  );
  const ts = lastPayload("pvp", "teamscore");
  eq({ blue: ts.blue, red: ts.red }, { blue: 1, red: 0 }, "团队比分：击杀归队累计（蓝 1:0 红）");
  // 红队点集选点：击杀者 HOST 在 (0,0,-10)，红队点集内最远 = (27.4,22.4)
  step(1.1);
  const rs = net._sent.find(
    (p) => p.k === "pvp" && p.e === "respawn" && p.id === "R1",
  );
  ok(
    rs &&
      rs.in === 3 &&
      rs.prot === 3 &&
      rs.pos[0] === 27.4 &&
      rs.pos[2] === 22.4,
    "红队重生：码头点集内离击杀者最远 (27.4,22.4)，载荷 in:3/prot:3",
  );
  ok(
    PVP_TEAM_SPAWNS.red.some((s) => s[0] === rs.pos[0] && s[2] === rs.pos[2]) &&
      rs.pos[0] >= 20 && rs.pos[0] <= 28 && rs.pos[2] >= 5 && rs.pos[2] <= 23,
    "红队重生点恒在码头/撤离区坐标带内（x∈[20,28] z∈[5,23]）",
  );
}

// —— 重生保护吞伤：R1 重生后 3s 内 HOST 射线被吞，墙 impact 表现照常 ——
{
  feedAlive("R1", 0, 0, -5); // R1 落回射线（模拟 victim 端 ps 上报新位）
  step(0.07);
  net._sent.length = 0;
  wallRef.hit = { dist: 8, point: new Vector3(0, 1.15, -2), normal: new Vector3(0, 0, -1), surface: "wall" };
  const r = shootHost();
  wallRef.hit = null;
  const hitR1 = net._sent.find((p) => p.k === "cb" && p.e === "hitPlayer" && p.id === "R1");
  const impact = net._sent.find((p) => p.k === "cb" && p.e === "impact");
  ok(
    hitR1 == null && !!impact && impact.shooter === "HOST",
    "保护吞伤：重生保护期内无 cb.hitPlayer，cb.impact 表现照常（墙 8m）",
  );
  ok(r && r.surface === "wall", "保护吞伤：返回面为墙止点（子弹不被保护体截停）");
  // 保护 3s 过后照常掉血
  step(6.3);
  net._sent.length = 0;
  shootHost();
  step(0.07);
  const hit2 = net._sent.find((p) => p.k === "cb" && p.e === "hitPlayer" && p.id === "R1");
  ok(!!hit2 && hit2.hp === 72, "保护到期：3s 后同一射线恢复结算（100→72）");
}

// —— 收 sh 解除保护（HOST 侧）：R1 放倒 HOST → HOST 重生得保护 → 开火即解除 ——
{
  net._sent.length = 0;
  for (let i = 0; i < 4; i++) {
    shootR1AtHost();
    step(0.07);
  }
  step(1.1); // HOST 重生派单（蓝队点集 + 保护窗）
  const hs = net._sent.find(
    (p) => p.k === "pvp" && p.e === "respawn" && p.id === "HOST",
  );
  ok(
    hs &&
      hs.prot === 3 &&
      PVP_TEAM_SPAWNS.blue.some((s) => s[0] === hs.pos[0] && s[2] === hs.pos[2]) &&
      hs.pos[0] === -33.9 && hs.pos[2] === 3.8,
    "蓝队重生：闸门点集内离击杀者最远 (-33.9,3.8)，载荷 prot:3",
  );
  ok(
    hs.pos[0] >= -34.5 && hs.pos[0] <= -27 && hs.pos[2] >= 2 && hs.pos[2] <= 9.5,
    "蓝队重生点恒在闸门侧坐标带内（x∈[-34.5,-27] z∈[2,9.5]）",
  );
  const ts = lastPayload("pvp", "teamscore");
  eq({ blue: ts.blue, red: ts.red }, { blue: 1, red: 1 }, "团队比分：红队也开张（1:1，保护到期那发只伤不死）");
  // HOST 复活（victim 端落地）+ 保护期挨打不掉血
  ctx.player.health = 100;
  ctx.player.alive = true;
  step(0.07);
  net._sent.length = 0;
  shootR1AtHost();
  step(0.07);
  ok(
    sentCount("cb", "hitPlayer", (p) => p.id === "HOST") === 0 &&
      ctx.player.health === 100,
    "本地玩家保护期：invulnerable 挡伤（health 100 不动）",
  );
  // HOST 开火 → protEnd 广播 + 解除
  shootHost();
  step(0.07);
  const pe = net._sent.find((p) => p.k === "pvp" && p.e === "protEnd");
  ok(!!pe && pe.id === "HOST", "开火解除：保护期内收 sh → 广播 {k:pvp,e:protEnd,id}");
  net._sent.length = 0;
  shootR1AtHost();
  step(0.07);
  const hitH = net._sent.find((p) => p.k === "cb" && p.e === "hitPlayer" && p.id === "HOST");
  ok(!!hitH && hitH.hp === 72, "解除后：R1 同一射线恢复对 HOST 结算（100→72）");
}

// —— 20 杀团队终局：继续放倒 R1 至蓝队 20 杀 ——
{
  let guard = 0;
  while (!lastPayload("pvp", "roundEnd") && guard++ < 200) {
    feedAlive("R1", 0, 0, -5);
    step(0.07);
    for (let i = 0; i < 4 && !lastPayload("pvp", "roundEnd"); i++) {
      shootHost();
      step(0.07);
    }
    step(6.3); // 等 1s 派单 + 3s 落地 + 3s 保护全过
  }
  const re = lastPayload("pvp", "roundEnd");
  ok(!!re, "20 杀终局：roundEnd 载荷已发");
  eq(
    { winner: re.winner, blueKills: re.blueKills, timeUp: re.timeUp },
    { winner: "blue", blueKills: 20, timeUp: false },
    "20 杀终局：winner=blue / blueKills=20 / timeUp=false",
  );
  ok(re.redKills === 1, "20 杀终局：红队 1 杀入账（比分板留痕）");
  ok(pv.active() === false, "20 杀终局：回合不再 active");
}

// ============ 二、host-sim：无时间上限，只有 20 杀终局 ============

function freshRound(kills) {
  const c2 = makeCtx();
  const n2 = makeNet();
  const s2 = createHostSim(c2, n2, {
    players: () => [
      { id: "HOST", name: "HOST", team: 0 },
      { id: "R1", name: "R1", team: 1 },
    ],
  });
  const p2 = s2.pvp();
  const st = (dt) => {
    while (dt > 1e-9) {
      const d = Math.min(0.24, dt);
      s2.update(d);
      p2.tick(d);
      dt -= d;
    }
  };
  n2._feed("R1", { k: "ps", id: "R1", seq: 1, pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
  s2.update(0.07);
  p2.startRound();
  p2.startPlay();
  for (let k = 0; k < kills; k++) {
    n2._feed("R1", { k: "ps", id: "R1", seq: 10 + k, pos: [0, 0, -5], yaw: 0, hp: 100, fl: 8 });
    st(0.07);
    for (let i = 0; i < 4; i++) {
      s2.onShot("HOST", RAY_O.clone(), RAY_D.clone(), T0);
      st(0.07);
    }
    st(7.5); // 1s 派单 + 3s 落地 + 3s 保护全过
  }
  return { n2, p2, s2, st };
}
{
  const { n2, p2, s2, st } = freshRound(1);
  for (let i = 0; i < 320 && !n2._sent.some((p) => p.k === "pvp" && p.e === "roundEnd"); i++) {
    st(1);
  }
  ok(!n2._sent.some((p) => p.k === "pvp" && p.e === "roundEnd"), "对抗模式超过 320 秒仍不因时间结束");
  ok(p2.timeLeft() === Infinity, "对抗模式时间查询返回 Infinity");
}
{
  const { n2, p2, s2, st } = freshRound(0);
  for (let i = 0; i < 320 && !n2._sent.some((p) => p.k === "pvp" && p.e === "roundEnd"); i++) {
    st(1);
  }
  ok(!n2._sent.some((p) => p.k === "pvp" && p.e === "roundEnd"), "无击杀时也不会因时间到结束");
}

// ============ 三、weapon.js：∞ 备弹纯函数 ============

{
  const p1 = refillPlan(5, 30, 0, true);
  eq(p1, { take: 25, reserve: 0 }, "∞ 备弹：reserve=0 也能装满（30-5），reserve 不减");
  const p2 = refillPlan(0, 30, 120, true);
  eq(p2, { take: 30, reserve: 120 }, "∞ 备弹：空匣换弹装满，reserve 120 原样");
  eq(refillPlan(5, 30, 10, false), { take: 10, reserve: 0 }, "合作语义零回归：min(25,10)=10，reserve 尽");
  eq(refillPlan(0, 30, 150, false), { take: 30, reserve: 120 }, "合作语义零回归：30/150 起始换弹后 30/120");
  ok(canStartReload(29, 30, 0, true) === true, "换弹门：pvp 备弹空照常可换（∞）");
  ok(canStartReload(29, 30, 0, false) === false, "换弹门：合作备弹空不可换（原版）");
  ok(canStartReload(30, 30, 999, false) === false, "换弹门：弹匣满不换（两模式一致）");
}

// ============ 四、pvp.js：黑板与载荷翻译 ============

// Node 无头垫片：pvp 流程构造期注册 document/window 级监听（只挂不触发）
globalThis.document =
  globalThis.document || { addEventListener() {}, hidden: false };
globalThis.addEventListener = globalThis.addEventListener || (() => {});

{
  const bus = mkBus();
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
  const flow = createPvpFlow(ctx2, { menus });
  flow.start({ mp: true });
  ok(typeof hostPayloadFn === "function", "pvp 流程底座：client 载荷通道已挂");
  eq(ctx2.pvpTeamColors, { friendly: "#4da3ff", enemy: "#ff5a4d" }, "§10.2 队伍配色 context（队友蓝/敌红）");

  hostPayloadFn({ k: "pvp", e: "teamscore", blue: 7, red: 3 });
  eq(ctx2.pvpTeams, { blue: 7, red: 3 }, "teamscore 翻译 → context.pvpTeams={blue,red}");
  hostPayloadFn({
    k: "pvp",
    e: "score",
    board: [
      { id: "H1", name: "H1", kills: 0, deaths: 0, team: 0 },
      { id: "C1", name: "C1", kills: 0, deaths: 0, team: 1 },
    ],
  });
  eq(ctx2.pvpMyTeam, 1, "队伍配色数据源：context.pvpMyTeam=1（board team 归纳）");

  // 死亡 → 重生单（带 prot）→ 落地 → 保护黑板 → protEnd 撤除
  bus.emit("player:dead", {});
  hostPayloadFn({ k: "pvp", e: "respawn", id: "C1", pos: [1, 0, 2], yaw: 0.5, in: 3, prot: 3 });
  ok(
    !!ctx2.pvpRespawn && ctx2.pvpRespawn.deadline > nowMs() && !!ctx2.pvpProtMap && ctx2.pvpProtMap.C1 > nowMs(),
    "respawn 翻译：重生倒计时黑板 + 全员保护窗 protMap（in+prot 窗口）",
  );
  hostPayloadFn({ k: "pvp", e: "respawn", id: "H1", pos: [9, 0, 9], yaw: 0, in: 3, prot: 3 });
  ok(ctx2.pvpProtMap.H1 > nowMs(), "他人重生单也进 protMap（combat 视觉吞伤数据源）");
  bus.emit("player:respawned", { pos: { x: 1, y: 0, z: 2 } });
  ok(
    !!ctx2.pvpProt && ctx2.pvpProt.until > nowMs(),
    "落地瞬间：context.pvpProt={until}（HUD 重生保护倒计时黑板）",
  );
  hostPayloadFn({ k: "pvp", e: "protEnd", id: "C1" });
  ok(ctx2.pvpProt == null && ctx2.pvpProtMap.C1 === undefined, "protEnd 翻译：本人保护黑板撤除");
  hostPayloadFn({ k: "pvp", e: "protEnd", id: "H1" });
  ok(ctx2.pvpProtMap.H1 === undefined, "protEnd 翻译：他人保护窗同步清除");

  hostPayloadFn({
    k: "pvp",
    e: "roundEnd",
    board: [],
    timeUp: false,
    blueKills: 20,
    redKills: 12,
    winner: "blue",
  });
  eq(
    flow.run.teamResult,
    { blueKills: 20, redKills: 12, winner: "blue" },
    "roundEnd 团队字段：run.teamResult（蓝 20:12 红 / winner=blue）",
  );
}

// ============ 五、player.js：重生保护本地计时 ============

{
  const bus = mkBus();
  const ctx3 = {
    events: bus,
    camera: { position: new Vector3(), rotation: { set() {} }, fov: 75, updateProjectionMatrix() {} },
    render: { post: {} },
    weapon: {},
    input: {
      ads: false, look: { dx: 0, dy: 0 }, move: { x: 0, y: 0 },
      fire: false, sprint: false, crouch: false, pressed: () => false,
    },
    physics: { boxes: [], moveCapsule: () => ({ onGround: true }), bounds: null, raycast: () => null },
    level: { playerStart: { pos: new Vector3(), yaw: 0 } },
    params: {},
    net: {
      stub: false,
      mode: "client",
      roomMode: () => "pvp",
      selfId: () => "C1",
      players: () => [{ id: "C1", team: 0 }],
    },
  };
  const P = createPlayer(ctx3);
  P.alive = false;
  bus.emit("pvp:respawn", { id: "C1", pos: { x: 1, y: 0, z: 2 }, yaw: 0, in: 0.2, prot: 3 });
  P.update(0.25);
  ok(P.alive === true && P.invulnerable === true, "重生落地：invulnerable=true（pvpRespawnStep）");
  const st = P.pvpProtState();
  ok(!!st && st.left > 2 && st.left <= 3, "保护读数：pvpProtState().left≈3s");
  P.damage(50, null);
  ok(P.health === 100, "保护期伤害吞：damage(50) 后 health 仍 100");
  let protEndSeen = false;
  bus.on("pvp:protEnd", () => (protEndSeen = true));
  bus.emit("weapon:fire", {});
  ok(P.invulnerable === false && protEndSeen, "开火解除：weapon:fire → invulnerable 即撤 + pvp:protEnd 本地事件");
  // 计时到期路径
  P.alive = false;
  bus.emit("pvp:respawn", { id: "C1", pos: { x: 1, y: 0, z: 2 }, yaw: 0, in: 0.2, prot: 3 });
  P.update(0.25);
  P.update(1.6);
  P.update(1.6);
  ok(P.invulnerable === false, "计时到期：3s 后 invulnerable 自撤（内部计时器）");
}

// ============ 六、combat.js：视觉命中跳过 ============

{
  const bus = mkBus();
  const hits = [];
  bus.on("player:hitEnemy", (ev) => hits.push(ev));
  let remoteList = [];
  const ctx4 = {
    events: bus,
    physics: { raycast: () => null },
    remotePlayers: { list: () => remoteList },
    net: {
      stub: false,
      mode: "client",
      selfId: () => "C1",
      roomMode: () => "pvp",
      players: () => [
        { id: "C1", name: "C1", team: 0 },
        { id: "M8", name: "M8", team: 0 },
        { id: "R7", name: "R7", team: 1 },
      ],
      client: { send() {} },
    },
  };
  const combat = createCombat(ctx4);
  const shoot = () =>
    combat.playerShot(new Vector3(0, 1.15, -10), new Vector3(0, 0, 1));

  remoteList = [{ id: "R7", pos: new Vector3(0, 0, -5), yaw: 0, crouch: false, alive: true }];
  const r1 = shoot();
  ok(
    r1 && r1.surface === "player" && hits.length === 1 && hits[0].pvp === true && hits[0].victim === "R7",
    "视觉命中：敌队目标照常 hitmarker（player:hitEnemy pvp+victim）",
  );

  hits.length = 0;
  remoteList = [{ id: "M8", pos: new Vector3(0, 0, -5), yaw: 0, crouch: false, alive: true }];
  const r2 = shoot();
  ok(r2 == null && hits.length === 0, "队友跳过：无 hitmarker 无音效（player:hitEnemy 不发）");

  hits.length = 0;
  ctx4.pvpProtMap = { R7: nowMs() + 5000 };
  remoteList = [{ id: "R7", pos: new Vector3(0, 0, -5), yaw: 0, crouch: false, alive: true }];
  const r3 = shoot();
  ok(r3 == null && hits.length === 0, "保护期目标跳过：视觉命中吞掉（黑板 protMap 窗口内）");
  ctx4.pvpProtMap = { R7: nowMs() - 1 };
  hits.length = 0;
  const r4 = shoot();
  ok(!!r4 && hits.length === 1, "保护窗过期：视觉命中恢复（protMap 到点失效）");
}

// ============ 汇总 ============
console.log(`[test-team-pvp] ${passed.length} 项断言全绿`);
for (const p of passed) console.log("  ok -", p);
