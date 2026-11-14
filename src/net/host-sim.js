// Host-authoritative multiplayer simulation glue (MP-CONTRACT §2.3, owner: H).
// 装配：仅 host 端（runtime 按 net.mode === "host" 装配）。
//
// 职责：
//  - 维护统一玩家表（本地玩家每帧从 context.player 刷新；远端玩家由客户端 ps 载荷驱动）
//  - 收 net.host.onClientPayload 分派：ps / ix / sh / ev
//  - 15Hz 合 peers 广播（不含接收者自己）、10Hz 敌快照 snap 广播（活敌 nid/ty/pos/yaw/hp）
//  - 权威判定：onShot（复刻 combat.js:18 playerShot 判定链）、onEnemyFire（复刻
//    combat.js:66-79 圆柱判定）、onExplode（复刻 combat.js:95-121 半额+LOS）、
//    onInteract（复刻 flow.js $() 距离≤2.2/朝向≥0.45 校验 + ue() 多人叠加切割）
//  - 敌人 nid 注册表与 ee.spawn/retire/killed 广播；ob/rs/rm/cb/game:state 广播
//  - 房间权威时钟 roomTime（联机时 c.time 的替身）
//  - 对抗模式（MP-PVP §8.1/§8.2 + §9.1 host-sim 行 + §10.0/§10.2 host-sim 行）：
//    房间 mode==='pvp'（net.roomMode()）时 onShot 对 players[] 做 hitbox.js 分部位
//    判定（头×2.2/躯干×1.0/四肢×0.7）、击杀/重生排程/score 心跳/roundEnd 判定；
//    pvp 下跳过切割/敌快照/持有者复验全部协作逻辑，回合节拍经 sim.pvp().tick(dt)
//    由 pvp 流程（src/game/pvp.js）驱动。
//    §10 团队死斗增量：roster 分队表（net.players() team 字段，§10.0 序位奇偶兜底）；
//    pvpShot 友军免伤门 + 重生保护吞伤（射线照常打墙回 cb.impact 表现）；队伍总分
//    （kills 归队累计）队伍先到 20 杀终局；重生限本队固定点集
//    （PVP_TEAM_SPAWNS）内离击杀者最远；respawn 载 prot:3.0；收 sh 即除保护（protEnd）；
//    teamscore 广播（变化即发+1Hz）；roundEnd 附 blueKills/redKills/winner
//  - §11.1 敌方开火暴露：权威处理 sh（pvp）时广播 {k:"pvp",e:"fire",id,pos}——
//    pos=roster 开火者最新 pos+眼高（crouch 取低头眼位）；限频每射 4/s（同 shooter
//    250ms 内合并丢弃，防连射刷屏，窗口锚在最后一次已播发）；命中与否都播（暴露的
//    是"谁在哪开的枪"）；保护期开火（解除保护那一枪）同样播发；host 本机
//    emitLocal("pvp:enemyFire") 同名事件（中继不回声房主自身广播），client 端由
//    src/game/pvp.js 从载荷翻译，两端各单次
//  - 回溯判定（lag compensation，docs/DEPLOY-NETWORK.md Phase 1）：仅 pvp 玩家侧。
//    每玩家 ps 态进 {hostMs,pos,yaw,crouch} 环形缓冲（15Hz×1.5s≤24 帧）；peers/snap
//    广播附 ht（host epoch ms 时钟回声）；pvpShot 按 sh.t（客户端估计的主机时刻
//    shotT，夹到 [now-1000, now-50]）取缓冲插值态喂 raycastPlayerParts——打的是
//    “射击者屏幕上看到的过去”；命中后扣血/击杀链路照旧作用于当前态。墙判定用
//    当前静态几何（次序保留：回溯命中距离 < wallDist 才算中）。合作 PvE 敌人不
//    回溯（v1 范围：PvE 容错高 + 敌人回溯需动 enemies.js 内部）
//
// 防回环铁律（events.js 同步派发、无 once）：
//  - 本模块绝不 emit "game:state"（broadcastState 只外发，本地事件由 flow M() 负责）
//  - 入站载荷不直接进 context.events，全部走本模块显式入口
//  - 本地 emit 仅限 impact / player:hitEnemy / player:hit(经 player.damage) /
//    objective:* / pvp:*（host 本机表现，与单人版/客户端翻译事件语义一致，
//    pvp:* 由 src/game/pvp.js 在 client 端从 fromHost 载荷做等价翻译，各端单次）
//
// 不触碰：combat.stats 归属（combat.js 集成负责）；net 事件桥（net.js 负责）。
import { Vector3 } from "../vendor/three-r180.js";
import { raycastPlayerParts } from "./hitbox.js";
import { LAGCOMP } from "./protocol.js";
import { PLAYER_DIMENSIONS } from "../core/config.js";

// —— 调参常量（复刻锚点：flow.js GAME_FLOW:6-38 / combat.js:18-121 / MP-CONTRACT §0）——
var TUNE = {
  peersHz: 15, // ps 合批广播频率
  snapHz: 10, // 敌快照广播频率
  obProgressHz: 10, // 切割进度 ob 广播频率（本地 objective:progress 仍逐帧）
  interactRange: 2.2, // flow.js:9 interactRange
  interactFacing: 0.45, // flow.js:10 interactFacing
  interactNear: 0.9, // flow.js:611 距离近于该值时免朝向校验
  interactDY: 2.5, // flow.js:610 高度差上限
  cutSeconds: 2.4, // flow.js:11 单人满速切割时长
  cutDecay: 1.6, // flow.js:632 松手倒扣（归一化/秒）
  cutStackStep: 0.5, // 契约 §0：速率 = 1 + 0.5×(人数−1)
  cutStackMax: 2.0, // 契约 §0：叠加速率上限
  shotDamage: 28, // combat.js:21 playerShot 默认伤害
  shotRange: 300, // combat.js:21
  weakMult: 2.2, // combat.js:28 弱点倍率
  enemyShotDamage: 6, // combat.js:67 enemyShot 默认伤害
  enemyShotRange: 200, // combat.js:67
  explodeRadius: 5, // combat.js:95
  explodeDamage: 80, // combat.js:95
  explodePlayerHalf: 0.5, // combat.js:119 玩家半额
  cylRadius: 0.38, // combat.js:77 玩家命中圆柱半径
  cylHalf: 0.95, // combat.js:77 半高
  cylLift: 0.95, // combat.js:76 中心线高度（pos.y + 0.95）
  aimLift: 1, // combat.js:71 投影基准（pos.y + 1）
  shotGap: 0.06, // 射速粗校验：同玩家间隔 <60ms 丢弃（契约 §3 combat 行）
  holderRecheck: 0.25, // 持有者距离/朝向/存活复验周期
  // 契约 §0 难度缩放基数（flow.js:16-38 waves 副本，flow.js 未导出 GAME_FLOW）
  baseWaves: [
    { gull: 3, hound: 1 },
    { gull: 3, hound: 2 },
    { gull: 4, hound: 3 },
  ],
  waveStep: 0.4, // 波次 ×(1+0.4×(n−1))
  maxAliveBase: 9, // maxAlive = 9+3×(n−1)
  maxAliveStep: 3,
  pursuitBase: 5, // pursuitExtra = 5+3×(n−1)
  pursuitStep: 3,
  defaultHp: 100, // player.js:97 maxHealth
};

// —— 对抗模式调参（MP-PVP §8.0 + §10.0 产品决策，全部已定死）——
var PVP = {
  teamKillLimit: 20, // §10.0 团队死斗：队伍总分先到 20 杀（个人 kills 只进板面展示）
  respawnDelay: 1.0, // 击杀后 1s 排程 pvp.respawn 广播
  respawnIn: 3.0, // 受害端重生倒计时（载荷 in 字段）
  protSeconds: 3.0, // §10.0 重生保护：落地后 3 秒免疫一切伤害（开火立即解除，CF 语义）
  scoreHz: 1, // score/teamscore 心跳频率（变化即发另行触发）
  fireIndGapMs: 250, // §11.1 开火暴露限频：每射 4/s（同 shooter 250ms 内合并丢弃）
};

// —— §10.0 队伍出生点（硬编码常量，锚点取自 level/placement 真实坐标）——
// 蓝队=闸门区 playerStart 周围：playerStart(-32,0,6)（level.js:139-142）+ 闸门走廊
// nav 校准 cover 点（level.js coverPoints -33.9,3.8 / -27.3,2.3，均经 E() 可走化）；
// 红队=码头/撤离区周围：extraction(29,0,20)（placement.js cb → level.js:377-380）+
// 码头区 nav 校准 cover 点（27.4,22.4 / 20.6,21.2 / 26.8,14.4 / 25.6,6）。
// 重生选点：本队点集内离击杀者最远（nav 软校验剔除不可走点，全否决退整集防卡死）。
var PVP_TEAM_SPAWNS = {
  blue: [
    [-32, 0, 6], // playerStart 本位
    [-33.9, 0, 3.8], // 闸门内 cover（nav 校准）
    [-27.3, 0, 2.3], // 闸门走廊 cover（nav 校准）
    [-29.5, 0, 7.5], // 走廊北侧（jersey barrier -30.6,10.4 让位）
  ],
  red: [
    [27.4, 0, 22.4], // 撤离点旁（nav 校准 cover）
    [20.6, 0, 21.2], // 撤离点西侧（nav 校准 cover）
    [26.8, 0, 14.4], // 码头中北（nav 校准 cover）
    [25.6, 0, 6], // 码头中南（nav 校准 cover）
  ],
};

// ps 载荷 fl 位集（BLUEPRINT ③ 顺序：crouch|sprint|ads|alive|aboard|fire）
var FL = { crouch: 1, sprint: 2, ads: 4, alive: 8, aboard: 16, fire: 32 };

// 模块级临时向量（本模块调用帧内即用即弃；enemy.damage 内部用各自文件的自有临时量）
var _vA = new Vector3();
var _vB = new Vector3();
var _vC = new Vector3();
var _vD = new Vector3();
var _histPos = new Vector3(); // 回溯插值态的落点容器（pvpShot 调用帧内即用即弃）

// ============ 回溯判定纯函数（lag compensation，无状态可无头直测） ============

function lerpAngle(a, b, f) {
  // 角度插值（最短弧）：350°→10° 走 20° 而不是 -340°
  var d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

function histPush(frames, ms, pos, yaw, crouch) {
  // 环形缓冲进帧：单调时基（同毫秒/时钟回拨样本丢弃）+ 时效修剪（historyMs 外全删）
  // + 帧数硬上限（historyCap）。帧为 {ms,x,y,z,yaw,crouch} 纯值，无 Vector3 负担。
  if (!Array.isArray(frames) || !isFinite(+ms)) return;
  ms = +ms;
  if (frames.length && ms <= frames[frames.length - 1].ms) return;
  var cutoff = ms - LAGCOMP.historyMs;
  while (frames.length && frames[0].ms < cutoff) frames.shift();
  frames.push({
    ms: ms,
    x: +pos.x || 0,
    y: +pos.y || 0,
    z: +pos.z || 0,
    yaw: +yaw || 0,
    crouch: !!crouch,
  });
  if (frames.length > LAGCOMP.historyCap)
    frames.splice(0, frames.length - LAGCOMP.historyCap);
}

function frameOf(fr) {
  return { x: fr.x, y: fr.y, z: fr.z, yaw: fr.yaw, crouch: fr.crouch };
}

function histAt(frames, ms) {
  // 取 ms 时刻的插值态：两邻近帧 lerp pos / yaw 最短弧，crouch 取旧帧（保守，
  // hitbox 不猜过渡态）；早于最旧/晚于最新 → 就近夹持不外推；空缓冲 → null
  // （调用方回退 roster 当前态）。返回纯值 {x,y,z,yaw,crouch}。
  if (!Array.isArray(frames) || !frames.length) return null;
  if (ms <= frames[0].ms) return frameOf(frames[0]);
  var last = frames[frames.length - 1];
  if (ms >= last.ms) return frameOf(last);
  for (var i = 1; i < frames.length; i++) {
    if (frames[i].ms >= ms) {
      var a = frames[i - 1],
        b = frames[i];
      var f = (ms - a.ms) / Math.max(1, b.ms - a.ms);
      f = Math.min(1, Math.max(0, f));
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        yaw: lerpAngle(a.yaw, b.yaw, f),
        crouch: a.crouch,
      };
    }
  }
  return frameOf(last);
}

function clampShotT(t, nowMs) {
  // shotT 夹紧：非有限数/落在信任窗外（异时基，如 performance.now 相对域或离谱
  // 作弊值）→ 视为无时间戳按当下处理；再夹到 [now-rewindMaxMs, now-rewindMinMs]。
  var v = +t;
  if (!isFinite(v) || Math.abs(v - nowMs) > LAGCOMP.trustWindowMs) v = nowMs;
  var lo = nowMs - LAGCOMP.rewindMaxMs,
    hi = nowMs - LAGCOMP.rewindMinMs;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 回溯判定纯函数面（scripts/test-lagcomp.mjs 无头直测复用） */
const lagcomp = Object.freeze({
  histPush: histPush,
  histAt: histAt,
  clampShotT: clampShotT,
  lerpAngle: lerpAngle,
});

function n2(v) {
  return Math.round(v * 100) / 100;
}
function n3(v) {
  return Math.round(v * 1000) / 1000;
}
function arr3(v, r) {
  if (!v || typeof v !== "object") return [0, 0, 0];
  return [r(v.x), r(v.y), r(v.z)];
}
function toV3(x, out) {
  // 容错接收 Vector3 / [x,y,z] / {x,y,z}
  if (!x) return null;
  if (x.isVector3) return out.copy(x);
  if (Array.isArray(x) && x.length >= 3) {
    var a = +x[0],
      b = +x[1],
      c = +x[2];
    if (x.every((n) => isFinite(+n)))
      return out.set(isFinite(a) ? a : 0, isFinite(b) ? b : 0, isFinite(c) ? c : 0);
    return null;
  }
  if (isFinite(+x.x) && isFinite(+x.y) && isFinite(+x.z))
    return out.set(+x.x, +x.y, +x.z);
  return null;
}
function serializeOpts(o) {
  // ee.spawn 的 opts 原样可序列化下发（BLUEPRINT ③：target→[x,y,z]）
  if (!o || typeof o !== "object") return undefined;
  try {
    var out = {};
    for (var k in o) {
      var v = o[k];
      if (v && v.isVector3) out[k] = [n3(v.x), n3(v.y), n3(v.z)];
      else if (v === undefined || typeof v === "function") continue;
      else out[k] = v;
    }
    return out;
  } catch {
    return undefined;
  }
}

function createHostSim(context, net, api) {
  var events = (context && context.events) || null;

  // —— 房间状态 ——
  var clock = 0; // 房间权威时钟（c.time 替身）
  var hostSeq = 1; // 本地玩家 ps 序号
  var nextNid = 1; // 敌人网络 id 自增
  var allAnnounced = false; // objective:all 已广播（防重复本地 emit）
  var pendingSpawnOpts = null; // onSpawnRequest → enemy:spawn 订阅取用
  var currentAttacker = null; // enemy.damage 调用期间的击杀归属
  var errCooldown = 0; // 自兜日志限频

  // —— 玩家表：id → 条目（本地每帧刷新 / 远端 ps 驱动）——
  var roster = new Map();

  // —— 敌 nid 注册表：enemy对象 → {nid, ty}（池复用=新身份，见 onEnemySpawn）——
  var nidMap = new Map();

  // —— 切割目标表：relayId → {id,pos,object,t,cut,cutting,holders,dirty} ——
  var relays = new Map();
  var relayOrder = [];

  // —— 节拍累加器 ——
  var peersT = 0;
  var snapT = 0;
  var obT = 0;
  var recheckT = 0;
  var histT = 0; // 回溯缓冲采样节拍（仅 pvp；15Hz 与 peers 同频）

  // —— 对抗模式房间状态（pvp 房间首轮 startRound 前为 null）——
  var pvp = null; // {active,ended,playStarted,kills:Map,deaths:Map,respawnQ:[],scoreT,dirty,lastKey}
  var pvpApi = null; // sim.pvp() 子对象（懒建；getter 见 getPvpFace，勿与状态变量同名）

  function pvpMode() {
    // 房间模式（MP-PVP §8.1）：net.roomMode() 缺席（N 通道未就绪）视为合作，零回归
    try {
      return !!(net && typeof net.roomMode == "function" && net.roomMode() === "pvp");
    } catch {
      return false;
    }
  }

  function selfId() {
    try {
      return net && net.selfId ? net.selfId() : null;
    } catch {
      return null;
    }
  }
  function isLocalId(id) {
    return id != null && id === selfId();
  }
  function b(payload) {
    // 广播自兜：net/host 缺席或断线时静默
    try {
      var h = net && net.host;
      if (h && typeof h.broadcast == "function") h.broadcast(payload);
    } catch (e) {
      logErr("broadcast", e);
    }
  }
  function sendTo(playerId, payload) {
    try {
      var h = net && net.host;
      if (h && typeof h.to == "function") return h.to(playerId, payload);
      b(payload); // 无定向能力时降级全量（客户端按 id 过滤自己）
    } catch (e) {
      logErr("to", e);
    }
  }
  function emitLocal(name, payload) {
    try {
      events && events.emit && events.emit(name, payload);
    } catch (e) {
      logErr("emit " + name, e);
    }
  }
  function logErr(where, e) {
    if (errCooldown > 0) return;
    errCooldown = 1;
    try {
      console.error("[host-sim] " + where + " threw", e);
    } catch {}
  }
  function hostMs() {
    // host 权威 epoch 毫秒（回溯判定统一时基）：优先 net.host.hostMs（net 注入
    // 时基，可测），缺失时 performance.timeOrigin+performance.now()（单调），
    // 再兜底 Date.now()——host 单进程内自洽即可（shotT/ht/缓冲帧共用此时基）。
    try {
      if (net && net.host && typeof net.host.hostMs == "function") {
        var v = +net.host.hostMs();
        if (isFinite(v)) return v;
      }
    } catch {}
    try {
      if (
        typeof performance !== "undefined" &&
        performance.now &&
        isFinite(performance.timeOrigin)
      )
        return performance.timeOrigin + performance.now();
    } catch {}
    return Date.now();
  }

  // ============ 玩家表 ============

  function ensureEntry(id, name) {
    var e = roster.get(id);
    if (e) {
      if (name && e.name !== name) e.name = name;
      return e;
    }
    e = {
      id: id,
      name: name || "",
      isLocal: isLocalId(id),
      pos: new Vector3(),
      vel: new Vector3(),
      yaw: 0,
      pitch: 0,
      hp: TUNE.defaultHp,
      alive: true,
      aboard: false,
      crouch: false,
      sprint: false,
      ads: false,
      fire: false,
      team: 0, // §10.0 分队表：0=蓝 1=红（syncRosterFromApi 维护）
      protUntil: 0, // §10.0 重生保护到期（房间权威 clock 秒；0=无保护）
      lastSeen: clock,
      lastSeq: null,
      lastShot: -1,
      lastFireMs: 0, // §11.1 fire 广播限频时标（hostMs 域；0=本局未播过）
      hist: [], // 回溯环形缓冲（仅 pvp 采样进帧；判定外一切用途仍走本条目最新态）
    };
    roster.set(id, e);
    return e;
  }

  function refreshLocalPlayer() {
    var p = context && context.player;
    if (!p || !p.pos) return;
    var id = selfId();
    if (id == null) return;
    var e = ensureEntry(id, p.name || "");
    e.isLocal = true;
    e.pos.copy(p.pos);
    e.yaw = +p.yaw || 0;
    e.pitch = +p.pitch || 0;
    e.hp = isFinite(+p.health) ? +p.health : e.hp;
    e.alive = p.alive !== false;
    if (p.vel) e.vel.copy(p.vel);
    e.crouch = !!p.crouching;
    e.sprint = !!p.sprinting;
    e.ads = isFinite(+p.ads) ? +p.ads >= 0.5 : !!p.ads;
    e.aboard = !!p.aboard; // §3 player.js 改造新增的 aboard 标志
    e.lastSeen = clock;
  }

  function syncRosterFromApi() {
    // api.players() = net 提供的房间成员统一视图（成员增删的唯一事实源）
    var list;
    try {
      list = api && typeof api.players == "function" ? api.players() : null;
    } catch {
      return;
    }
    if (!Array.isArray(list) || !list.length) return;
    var seen = new Set();
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || m.id == null) continue;
      seen.add(m.id);
      var e = ensureEntry(m.id, m.name);
      // §10.1 分队表：服务器 team 字段优先（0=蓝 1=红）；缺字段按 §10.0 加入序
      // 奇偶兜底（0,2→蓝 1,3→红）——host 权威分队不依赖服务器升级节奏
      e.team = m.team === 1 ? 1 : m.team === 0 ? 0 : i % 2;
      if (m.alive === false && e.alive) e.alive = false;
    }
    var local = selfId();
    for (var id of Array.from(roster.keys()))
      if (!seen.has(id) && id !== local) roster.delete(id); // 掉线清位（host 恒留）
  }

  function teamOf(id) {
    // 权威分队表读数（pvp 房 0=蓝 1=红；coop 恒 0）：roster 条目缺失退蓝侧
    var e = roster.get(id);
    return e && e.team === 1 ? 1 : 0;
  }

  // ============ 入站载荷分派（net.host.onClientPayload → 此处） ============

  function handleClientPayload(playerId, payload) {
    try {
      if (playerId == null || !payload || typeof payload !== "object") return;
      switch (payload.k) {
        case "ps":
          handlePs(playerId, payload);
          break;
        case "ix":
          onInteract(playerId, payload.relay, payload.on === true || payload.on === 1);
          break;
        case "sh": {
          var o = toV3(payload.o, _vA);
          var d = toV3(payload.d, _vB);
          if (o && d && d.lengthSq() > 1e-8) onShot(playerId, o.clone(), d.normalize(), payload.t);
          break;
        }
        case "ev":
          // 表现事件原样转发（强制 id=发送者，防伪造他人）
          b(Object.assign({}, payload, { id: playerId }));
          break;
      }
    } catch (e) {
      logErr("clientPayload", e);
    }
  }

  function handlePs(playerId, payload) {
    if (isLocalId(playerId)) return; // host 自身不收 ps
    var e = ensureEntry(playerId, payload.name);
    if (payload.seq != null) {
      if (e.lastSeq != null && !(+payload.seq > e.lastSeq)) return; // 丢乱序
      e.lastSeq = +payload.seq;
    }
    var p = toV3(payload.pos, _vA);
    if (p) e.pos.copy(p);
    var v = toV3(payload.vel, _vB);
    if (v) e.vel.copy(v);
    if (isFinite(+payload.yaw)) e.yaw = +payload.yaw;
    if (isFinite(+payload.pitch)) e.pitch = +payload.pitch;
    if (isFinite(+payload.hp) && +payload.hp > 0) e.hp = Math.min(e.hp, +payload.hp); // 自报只降不升（权威结算优先）
    var fl = +payload.fl || 0;
    e.crouch = !!(fl & FL.crouch);
    e.sprint = !!(fl & FL.sprint);
    e.ads = !!(fl & FL.ads);
    e.aboard = !!(fl & FL.aboard);
    e.fire = !!(fl & FL.fire);
    if (fl & FL.alive) e.alive = e.hp > 0;
    else if (fl) e.alive = false; // fl=0 视为未提供，不误杀
    e.lastSeen = clock;
  }

  // ============ 15Hz peers / 10Hz snap ============

  function serializeState(e) {
    return {
      k: "ps",
      id: e.id,
      seq: e.isLocal ? hostSeq++ : e.lastSeq == null ? 0 : e.lastSeq,
      t: n3(clock),
      pos: arr3(e.pos, n2),
      yaw: n3(e.yaw),
      pitch: n3(e.pitch),
      vel: arr3(e.vel, n2),
      hp: Math.round(e.hp),
      fl:
        (e.crouch ? FL.crouch : 0) |
        (e.sprint ? FL.sprint : 0) |
        (e.ads ? FL.ads : 0) |
        (e.alive ? FL.alive : 0) |
        (e.aboard ? FL.aboard : 0) |
        (e.fire && !e.isLocal ? FL.fire : 0),
    };
  }

  function flushPeers() {
    if (roster.size < 2) return;
    var ht = Math.round(hostMs()); // 主机时钟回声（回溯判定时基，客户端据此估主机时刻）
    var states = [];
    for (var e of roster.values()) states.push(serializeState(e));
    for (var r of roster.values()) {
      if (r.isLocal) continue;
      sendTo(r.id, {
        k: "peers",
        t: n3(clock),
        ht: ht,
        states: states.filter((s) => s.id !== r.id), // 不含接收者自己
      });
    }
  }

  function registerEnemy(en) {
    var reg = nidMap.get(en);
    if (reg) return reg;
    reg = { nid: nextNid++, ty: en.type || "gull" };
    nidMap.set(en, reg);
    return reg;
  }

  function flushSnap() {
    var list = context && context.enemies && context.enemies.list;
    if (!Array.isArray(list)) return;
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var en = list[i];
      if (!en || !en.alive || !en.pos) continue; // 死亡无者（ee.killed 负责表现）
      var reg = registerEnemy(en);
      arr.push({
        nid: reg.nid,
        ty: reg.ty, // 逻辑名：gull=飞行体(walker.js造) / hound=地面体(drone.js造)
        pos: arr3(en.pos, n3),
        yaw: n3(en.yaw || 0),
        vel: en.vel ? arr3(en.vel, n2) : undefined,
        hp: Math.round(en.hp || 0),
        md: en.mode || null,
      });
    }
    b({
      k: "snap",
      t: n3(clock),
      ht: Math.round(hostMs()), // 主机时钟回声（pvp 用不到 snap，字段对称无害）
      cut: relayOrder.map((id) => (relays.get(id) ? relays.get(id).cut : false)),
      relayT: relayOrder.map((id) => {
        var r = relays.get(id);
        return r ? n3(Math.min(1, r.t)) : 0;
      }),
      enemies: arr,
    });
  }

  // ============ 敌人生命周期（ee 广播） ============

  function onEnemySpawn(evt) {
    // enemies.spawn 内部同步 emit（enemies.js:456）——所有激活路径（含池复用）都经此
    try {
      var en = evt && evt.enemy;
      if (!en) return;
      var prev = nidMap.get(en);
      if (prev)
        b({ k: "ee", e: "retire", nid: prev.nid }); // 池复用：先注销旧身份，防客户端幽灵木偶
      var reg = { nid: nextNid++, ty: en.type || "gull" };
      nidMap.set(en, reg);
      b({
        k: "ee",
        e: "spawn",
        nid: reg.nid,
        ty: reg.ty,
        pos: arr3(en.pos, n3),
        opts: serializeOpts(pendingSpawnOpts), // flow 刷怪走 onSpawnRequest 时携带
      });
    } catch (e) {
      logErr("enemy:spawn", e);
    }
  }

  function onEnemyRetireEvt(evt) {
    // enemies.js:286 改造后补发的 enemy:retire（R4）；onRetire 为主入口
    try {
      onRetire(evt && evt.enemy);
    } catch (e) {
      logErr("enemy:retire", e);
    }
  }

  function onEnemyKilledEvt(evt) {
    // walker.js:291 / drone.js 同步 emit；这里补 by 归属（§3 combat 行）并广播 ee.killed
    try {
      var en = evt && evt.enemy;
      if (evt && evt.by === undefined && currentAttacker != null) evt.by = currentAttacker;
      var reg = en ? nidMap.get(en) : null;
      if (reg)
        b({
          k: "ee",
          e: "killed",
          nid: reg.nid,
          by: (evt && evt.by) || currentAttacker || null,
          ds:
            (evt && evt.ds) != null
              ? evt.ds
              : (reg.nid * 2654435761) >>> 0, // 死亡动画随机种（缺省以 nid 做种，BLUEPRINT R14）
        });
    } catch (e) {
      logErr("enemy:killed", e);
    }
  }

  // ============ 切割目标（flow.js $()/ue()/me() 的多人权威版） ============

  function buildRelays() {
    var objectives = context && context.level && context.level.objectives;
    relays.clear();
    relayOrder.length = 0;
    if (!Array.isArray(objectives)) return;
    for (var i = 0; i < objectives.length; i++) {
      var o = objectives[i];
      if (!o) continue;
      var id = o.id || "relay_" + i;
      relayOrder.push(id);
      relays.set(id, {
        id: id,
        pos: o.pos || new Vector3(),
        object: o.object || null,
        t: 0,
        cut: false,
        cutting: false,
        holders: new Set(),
        dirty: false,
      });
    }
  }

  function resolveRelay(relayId) {
    if (!relays.size) buildRelays();
    if (relayId == null) return null;
    if (relays.has(relayId)) return relays.get(relayId);
    if (typeof relayId == "number" && relayOrder[relayId])
      return relays.get(relayOrder[relayId]);
    return null;
  }

  function forwardOf(e, out) {
    // 远端玩家 forward 从 yaw 推导（player.js:482 同式：forward=(0,0,-1) 绕 Y 旋 yaw）
    if (e.isLocal && context.player && context.player.forward && context.player.forward.isVector3)
      return out.copy(context.player.forward);
    return out.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
  }

  function validateInteract(e, relay) {
    // 复刻 flow.js:601-618 $()：水平距≤2.2 / 高度差≤2.5 / 距离>0.9 时朝向≥0.45
    var dx = relay.pos.x - e.pos.x,
      dz = relay.pos.z - e.pos.z,
      dist = Math.hypot(dx, dz);
    if (dist > TUNE.interactRange) return false;
    if (Math.abs((relay.pos.y || 0) - e.pos.y) > TUNE.interactDY) return false;
    if (dist > TUNE.interactNear) {
      var f = forwardOf(e, _vC);
      var dot =
        (dx * f.x + dz * f.z) /
        (dist * Math.max(0.2, Math.hypot(f.x, f.z)));
      if (dot < TUNE.interactFacing) return false;
    }
    return true;
  }

  function setRelayVisual(relay, state) {
    // 复刻 flow.js:289-296 O()：relay.object.userData.setState
    try {
      var u = relay.object && relay.object.userData;
      u && typeof u.setState == "function" && u.setState(state);
    } catch (e) {
      logErr("relay setState", e);
    }
  }

  function setCutting(relay, on) {
    relay.cutting = on;
    setRelayVisual(relay, on ? "cutting" : "live");
    b({ k: "rs", relay: relay.id, s: on ? "cutting" : "live" });
  }

  function finishRelay(relay) {
    // 复刻 flow.js:660-682 me() 的房级语义
    relay.t = 1;
    relay.cut = true;
    relay.cutting = false;
    relay.dirty = false;
    relay.holders.clear();
    setRelayVisual(relay, "cut");
    var cutCount = 0,
      total = relays.size;
    for (var r of relays.values()) r.cut && cutCount++;
    emitLocal("objective:done", { id: relay.id, index: cutCount, total: total });
    b({ k: "ob", e: "done", relay: relay.id });
    b({ k: "rs", relay: relay.id, s: "cut" });
    if (cutCount >= total && total > 0) {
      allAnnounced = true;
      emitLocal("objective:all", {});
      b({ k: "ob", e: "all" });
    }
  }

  function advanceRelays(dt) {
    if (!relays.size) buildRelays();
    for (var relay of relays.values()) {
      if (relay.cut) continue;
      if (relay.holders.size > 0) {
        // 契约 §0：速率 = 1 + 0.5×(人数−1)，上限 2.0
        var rate = Math.min(
          TUNE.cutStackMax,
          1 + TUNE.cutStackStep * (relay.holders.size - 1),
        );
        if (!relay.cutting) setCutting(relay, true);
        relay.t += (dt / TUNE.cutSeconds) * rate;
        relay.dirty = true;
        // 本地逐帧 emit（HUD 进度环/音频与单人版完全一致）
        emitLocal("objective:progress", {
          id: relay.id,
          t: Math.min(1, relay.t),
        });
        if (relay.t >= 1) {
          finishRelay(relay);
          continue;
        }
      } else if (relay.t > 0) {
        relay.t = Math.max(0, relay.t - dt * TUNE.cutDecay); // 松手倒扣 1.6×
        if (relay.cutting) {
          setCutting(relay, false);
          emitLocal("objective:progress", { id: relay.id, t: 0 }); // 复刻 flow.js:636-638
          relay.dirty = true;
        }
      }
    }
    // ob.progress 网络侧 10Hz 合批（本地已逐帧）
    obT -= dt;
    if (obT <= 0) {
      obT = 1 / TUNE.obProgressHz;
      for (var r2 of relays.values()) {
        if (r2.cut || !r2.dirty) continue;
        r2.dirty = false;
        b({ k: "ob", e: "progress", relay: r2.id, t: n3(Math.min(1, r2.t)) });
      }
    }
  }

  function recheckHolders() {
    // 持有者走远/转身/阵亡即松手（等价单人版 $() 逐帧再校验）
    for (var relay of relays.values()) {
      if (relay.cut || !relay.holders.size) continue;
      for (var id of Array.from(relay.holders)) {
        var e = roster.get(id);
        if (!e || !e.alive || !validateInteract(e, relay)) relay.holders.delete(id);
      }
    }
  }

  function resetForNewRun() {
    clock = 0;
    allAnnounced = false;
    nidMap.clear();
    peersT = snapT = obT = recheckT = histT = 0;
    relays.clear();
    relayOrder.length = 0;
    pvp = null; // 对抗回合状态一并清场（pvp 流程随后的 startRound 重建）
    for (var e of roster.values()) {
      e.aboard = false;
      e.lastShot = -1;
      e.lastFireMs = 0; // §11.1 旧局限频时标不泄漏进新局（首枪必播）
      e.lastSeq = null;
      e.protUntil = 0; // §10.0 旧局保护窗不泄漏进新局
      e.hist.length = 0; // 旧局位姿不泄漏进新局回溯判定
      if (!e.isLocal) {
        e.hp = TUNE.defaultHp;
        e.alive = true;
      }
    }
  }

  function sampleHistory() {
    // 回溯缓冲进帧（仅 pvp 调用）：全员统一时刻采样本帧 roster 态——本地玩家
    // 来自 refreshLocalPlayer 的最新帧，远端玩家来自 ps 驱动的最新态；判定外的
    // 一切用途（HUD/朝向/重生选点）仍直接读 roster，不经缓冲。
    var ms = hostMs();
    for (var e of roster.values()) histPush(e.hist, ms, e.pos, e.yaw, e.crouch);
  }

  // ============ 权威伤害结算（cb.hitPlayer 广播 + 本地直走 player.damage） ============

  function applyPlayerDamage(e, dmg, kind, fromPos, attacker, part) {
    if (!e || !e.alive || !(dmg > 0)) return false;
    var oldHp = e.hp;
    if (e.isLocal && context.player && typeof context.player.damage == "function") {
      // 本地玩家直走 damage 保持手感（player:hit/dead 事件由 player.js 内部 emit）
      try {
        context.player.damage(dmg, fromPos || null);
      } catch (err) {
        logErr("player.damage", err);
      }
      e.hp = isFinite(+context.player.health) ? +context.player.health : e.hp;
      e.alive = context.player.alive !== false;
    } else {
      e.hp = Math.max(0, e.hp - dmg);
      if (e.hp <= 0) e.alive = false;
    }
    if (e.hp >= oldHp && e.alive) return false; // invulnerable/无效伤害：不打扰客户端
    var hit = {
      k: "cb",
      e: "hitPlayer",
      id: e.id,
      amount: Math.round(dmg * 10) / 10,
      hp: Math.round(e.hp),
      kind: kind || "enemy",
      from: fromPos ? arr3(fromPos, n2) : undefined,
    };
    if (attacker != null) hit.attacker = attacker; // pvp：击杀归属（合作调用不携带，载荷零变化）
    if (part) hit.part = String(part); // pvp 分部位（§9.1 hitPlayer 落点）；合作调用不携带，载荷零变化
    b(hit);
    if (!e.alive) b({ k: "cb", e: "playerDead", id: e.id });
    return true;
  }

  function resolveAttacker(source) {
    return typeof source == "string" && roster.has(source) ? source : null;
  }

  // ============ 主循环 ============

  function update(dt) {
    try {
      dt = isFinite(+dt) ? Math.min(0.25, Math.max(0, +dt)) : 0;
      clock += dt;
      if (errCooldown > 0) errCooldown -= dt;
      refreshLocalPlayer();
      syncRosterFromApi();
      if (pvpMode()) {
        // pvp：只保留位姿面（peers 15Hz）+ 回溯缓冲采样；切割/敌快照/持有者复验
        // 全跳过——回合计时/重生队列/score 心跳走 pvp().tick(dt)（由 pvp 流程驱动）
        peersT -= dt;
        if (peersT <= 0) {
          peersT = 1 / TUNE.peersHz;
          flushPeers();
        }
        histT -= dt;
        if (histT <= 0) {
          histT = 1 / TUNE.peersHz;
          sampleHistory();
        }
        return;
      }
      advanceRelays(dt);
      recheckT -= dt;
      if (recheckT <= 0) {
        recheckT = TUNE.holderRecheck;
        recheckHolders();
      }
      peersT -= dt;
      if (peersT <= 0) {
        peersT = 1 / TUNE.peersHz;
        flushPeers();
      }
      snapT -= dt;
      if (snapT <= 0) {
        snapT = 1 / TUNE.snapHz;
        flushSnap();
      }
    } catch (e) {
      logErr("update", e);
    }
  }

  // ============ 对抗模式（MP-PVP §8.1/§8.2 host-sim 行） ============

  function buildPvpBoard() {
    var arr = [];
    for (var e of roster.values())
      arr.push({
        id: e.id,
        name: e.name || "队员",
        kills: (pvp && pvp.kills.get(e.id)) || 0,
        deaths: (pvp && pvp.deaths.get(e.id)) || 0,
        team: teamOf(e.id), // §10.1：board 每项 + team（0=蓝 1=红，Tab 板按队分组）
      });
    arr.sort(function (a, b2) {
      return (
        b2.kills - a.kills ||
        a.deaths - b2.deaths ||
        String(a.name).localeCompare(String(b2.name))
      ); // 杀数降/死亡升/名字兜底：并列即并列胜（§8.0）
    });
    return arr;
  }

  function flushPvpScore() {
    var board = buildPvpBoard();
    var key = "";
    for (var i = 0; i < board.length; i++)
      key += board[i].id + ":" + board[i].kills + "/" + board[i].deaths + ";";
    pvp.lastKey = key;
    pvp.dirty = false;
    pvp.scoreT = 1 / PVP.scoreHz; // 心跳复位
    b({ k: "pvp", e: "score", board: board });
    emitLocal("pvp:score", { board: board });
    // §10.1 teamscore：变化即发 + 1Hz 心跳——随 score 同拍（队伍分只随击杀变，
    // score 的 lastKey 去重已覆盖“变化即发”，心跳节拍由 scoreT 覆盖）
    b({
      k: "pvp",
      e: "teamscore",
      blue: pvp.teamKills.blue,
      red: pvp.teamKills.red,
    });
    emitLocal("pvp:teamscore", {
      blue: pvp.teamKills.blue,
      red: pvp.teamKills.red,
    });
  }

  function pvpStartRound() {
    // 回合复位（pvp 流程 U() 于倒计时开始时调用；broadcastState("countdown") 已先行清场）
    pvp = {
      active: true,
      ended: false,
      playStarted: false, // 倒计时结束（pvp 流程 T() → startPlay）后进入战斗
      kills: new Map(),
      deaths: new Map(),
      teamKills: { blue: 0, red: 0 }, // §10.0 队伍总分（kills 归队累计，先到 20 杀）
      respawnQ: [],
      scoreT: 0,
      dirty: false,
      lastKey: "",
    };
    for (var e of roster.values()) {
      e.aboard = false;
      e.protUntil = 0; // §10.0 新回合无保护窗
      e.hist.length = 0; // 新回合重开：旧回合位姿不作回溯靶
      if (!e.isLocal) {
        e.hp = TUNE.defaultHp;
        e.alive = true;
      }
    }
    flushPvpScore(); // 初始板立即下发
  }

  function pvpStartPlay() {
    if (pvp) pvp.playStarted = true;
    // 注：开局不加保护窗（CF 语义：保护只属于“重生”——开局双方各在己方半场，
    // 距离天然拉开；开局 3s 免疫反而护送抢中路，不做）
  }

  function pvpEndRound(timeUp) {
    if (!pvp || pvp.ended) return;
    pvp.ended = true;
    pvp.respawnQ.length = 0; // 终局未决重生单全废
    for (var e of roster.values()) e.protUntil = 0; // §10.0 终局撤全员保护窗
    // §10.1 终局增量：blueKills/redKills/winner（队伍先达 20 杀）
    var blue = pvp.teamKills.blue,
      red = pvp.teamKills.red;
    var winner = blue === red ? "draw" : blue > red ? "blue" : "red";
    var board = buildPvpBoard();
    b({
      k: "pvp",
      e: "roundEnd",
      board: board,
      timeUp: timeUp === true,
      blueKills: blue,
      redKills: red,
      winner: winner,
    });
    emitLocal("pvp:roundEnd", {
      board: board,
      timeUp: timeUp === true,
      blueKills: blue,
      redKills: red,
      winner: winner,
    });
  }

  function pvpTick(dt) {
    // 回合节拍（仅房主 pvp 流程每帧调用；含自身 dead/倒计时态——重生队列不停摆）
    if (!pvp || pvp.ended) return;
    dt = isFinite(+dt) ? Math.max(0, +dt) : 0;
    for (var i = 0; i < pvp.respawnQ.length; i++) {
      var q = pvp.respawnQ[i];
      if (clock < q.at) continue;
      pvp.respawnQ.splice(i--, 1);
      if (!roster.has(q.id)) continue; // 受害者已离房：弃单
      var ent = roster.get(q.id);
      ent.hp = TUNE.defaultHp;
      ent.alive = true; // 倒计时期间受害端 ps 仍报 dead，真实复活后再翻回（免得打空气）
      ent.hist.length = 0; // 重生即传送：死亡前的旧位姿不作回溯靶
      // §10.0 重生保护：受害端 in 秒后落地、再 prot 秒免疫——host 权威窗口从派单
      // 时刻起算 in+prot（与 player.js 本地计时同口径；开火即解除见 onShot protEnd）
      ent.protUntil = clock + PVP.respawnIn + PVP.protSeconds;
      var pos = Array.isArray(q.pos) ? q.pos : [0, 0, 0];
      var pl = {
        k: "pvp",
        e: "respawn",
        id: q.id,
        pos: [n3(pos[0]), n3(pos[1]), n3(pos[2])],
        yaw: n3(q.yaw || 0),
        in: PVP.respawnIn,
        prot: PVP.protSeconds, // §10.1：保护秒数（受害端 HUD 倒计时/视觉吞伤数据源）
      };
      b(pl);
      emitLocal("pvp:respawn", {
        id: q.id,
        pos: new Vector3(pos[0], pos[1], pos[2]),
        yaw: q.yaw || 0,
        in: PVP.respawnIn,
        prot: PVP.protSeconds,
      });
    }
    pvp.scoreT -= dt;
    if (pvp.scoreT <= 0 || pvp.dirty) flushPvpScore();
  }

  function pickPvpSpawn(fromPos, team) {
    // §10.0 队伍出生点：victim 本队固定点集（PVP_TEAM_SPAWNS）内选离击杀者最远者；
    // nav 软校验剔除不可走点（全否决时退整集——宁可硬点复活也不卡重生链路）。
    // 坐标带：蓝=闸门区 x∈[-34,-27]/z∈[2,9]（playerStart 侧），红=码头撤离区
    // x∈[20,28]/z∈[5,23]（extraction 侧）——点集溯源见 PVP_TEAM_SPAWNS 注释。
    var set = team === 1 ? PVP_TEAM_SPAWNS.red : PVP_TEAM_SPAWNS.blue;
    var nav = context.physics && context.physics.nav;
    var pool = [];
    for (var i = 0; i < set.length; i++) {
      var ok = true;
      try {
        if (nav && typeof nav.isWalkable == "function")
          ok = !!nav.isWalkable(set[i][0], set[i][2]);
      } catch {
        ok = true; // nav 异常时宽松放行（与 v1 出生点同态度）
      }
      if (ok) pool.push(set[i]);
    }
    if (!pool.length) pool = set.slice();
    var best = pool[0],
      bd = -1;
    for (var j = 0; j < pool.length; j++) {
      var d = Math.hypot(pool[j][0] - fromPos.x, pool[j][2] - fromPos.z);
      if (d > bd) {
        bd = d;
        best = pool[j];
      }
    }
    return best; // [x, y, z]
  }

  function pvpYawToward(from, to) {
    // forward=(0,0,-1) 绕 Y 旋 yaw（player.js:482 同式）→ 朝 to 指向；
    // from/to 容错 [x,y,z] 与 {x,z}（本队点集是数组，击杀者位姿是 Vector3）
    var fx = Array.isArray(from) ? +from[0] : +from.x,
      fz = Array.isArray(from) ? +from[2] : +from.z,
      tx = Array.isArray(to) ? +to[0] : +to.x,
      tz = Array.isArray(to) ? +to[2] : +to.z;
    var dx = tx - fx,
      dz = tz - fz;
    if (!isFinite(dx) || !isFinite(dz) || Math.hypot(dx, dz) < 1e-3) return 0;
    return Math.atan2(-dx, -dz);
  }

  function pvpOnKill(attackerId, victim, headshot) {
    if (!pvp || pvp.ended) return;
    var kid =
      attackerId != null && attackerId !== victim.id && roster.has(attackerId)
        ? attackerId
        : null; // 环境致死/自伤无人认领
    if (kid != null) {
      pvp.kills.set(kid, (pvp.kills.get(kid) || 0) + 1);
      // §10.0 队伍总分：kills 归击杀者队伍累计（自杀/环境死无人认领不记队分）
      pvp.teamKills[teamOf(kid) === 1 ? "red" : "blue"]++;
    }
    pvp.deaths.set(victim.id, (pvp.deaths.get(victim.id) || 0) + 1);
    // headshot:bool（§9.1 击杀流增量）：致死弹命中部位==head；killfeed 爆头行/
    // 死亡屏变体由 UI 侧消费，此处只补载荷字段（缺省 false，向后兼容）
    b({
      k: "pvp",
      e: "killed",
      by: kid,
      victim: victim.id,
      headshot: headshot === true,
    });
    emitLocal("pvp:killed", {
      by: kid,
      victim: victim.id,
      headshot: headshot === true,
    });
    pvp.dirty = true; // 变化即发 score/teamscore
    // §10.0 终局门：队伍总分先到 20 杀（个人板面只做展示，不单独终局）
    if (
      pvp.teamKills.blue >= PVP.teamKillLimit ||
      pvp.teamKills.red >= PVP.teamKillLimit
    ) {
      pvpEndRound(false);
      return;
    }
    // 重生排程：§10.0 出生点限本队点集内离击杀者最远；朝向击杀者（复活的
    // situational awareness）
    var from =
      kid != null && roster.get(kid) ? roster.get(kid).pos : victim.pos;
    var sp = pickPvpSpawn(from, teamOf(victim.id));
    pvp.respawnQ.push({
      id: victim.id,
      at: clock + PVP.respawnDelay,
      pos: [n3(sp[0]), n3(sp[1]), n3(sp[2])],
      yaw: n3(pvpYawToward(sp, from)),
    });
  }

  function pvpShot(o, s, shooter, shotT) {
    // 权威 hitscan + 回溯判定（pvp，MP-PVP §9.1 + DEPLOY-NETWORK Phase 1）：
    // shotT（客户端估计的主机时刻）先过 clampShotT——非法/异时基按当下，再夹到
    // [now-1000, now-50]（防作弊翻旧账/防零延迟回溯）；对每个候选受击者取缓冲中
    // shotT 时刻的插值态（两邻近帧 lerp pos/yaw 最短弧，crouch 取旧帧；无缓冲
    // 回退 roster 当前态）喂 raycastPlayerParts——打的是“射击者屏幕上看到的过去”。
    // 墙判定用当前静态几何（几何不变无回溯问题），次序保留：回溯命中距离 <
    // wallDist 才算中。命中→部位倍率结算（头×2.2=61.6 两枪倒/躯干×1.0=28/
    // 四肢×0.7=19.6）→ cb.hitPlayer 带 part；击杀链（kills/deaths/重生/计分）
    // 不变照旧作用于当前态，pvp:killed 增补 headshot:bool。
    var phys = context.physics && context.physics.raycast;
    if (!phys) return null;
    var l = phys(o, s, TUNE.shotRange);
    var worldDist = l ? l.dist : TUNE.shotRange;
    var stMs = clampShotT(shotT, hostMs());
    var best = null;
    for (var v of roster.values()) {
      if (!v.alive || v === shooter) continue; // 不打自己
      if (v.team === shooter.team) continue; // §10.0 友军免伤门：子弹穿过队友（不打断射线，后方敌人照常判）
      if (v.protUntil > clock) continue; // §10.0 重生保护吞伤：目标整个跳过（射线照常打墙回 cb.impact 表现）
      var fr = histAt(v.hist, stMs);
      var hb;
      if (fr) {
        _histPos.set(fr.x, fr.y, fr.z);
        hb = raycastPlayerParts(o, s, {
          pos: _histPos,
          yaw: fr.yaw,
          crouch: fr.crouch,
        });
      } else {
        hb = raycastPlayerParts(o, s, {
          pos: v.pos,
          yaw: v.yaw,
          crouch: v.crouch,
        }); // 无缓冲（刚入房/刚重生）回退当前态
      }
      if (hb && hb.dist < worldDist && (!best || hb.dist < best.dist))
        best = { e: v, part: hb.part, mult: hb.mult, h: hb.dist };
    }
    if (best) {
      _vC.copy(o).addScaledVector(s, best.h);
      var point = _vC.clone();
      applyPlayerDamage(
        best.e,
        TUNE.shotDamage * best.mult,
        "pvp",
        o,
        shooter.id,
        best.part,
      );
      if (!best.e.alive) pvpOnKill(shooter.id, best.e, best.part === "head");
      var playerImpact = {
        point: point,
        normal: s.clone().negate(),
        dist: best.h,
        surface: "player",
        enemy: null,
        part: best.part,
        dir: s,
        from: "player",
      };
      emitLocal("impact", playerImpact);
      b({
        k: "cb",
        e: "impact",
        shooter: shooter.id,
        point: arr3(point, n2),
        normal: arr3(playerImpact.normal, n2),
        dist: n2(best.h),
        surface: "player",
        dir: arr3(s, n3),
        from: "player",
      });
      return playerImpact;
    }
    if (l) {
      var u = {
        point: l.point,
        normal: l.normal,
        dist: l.dist,
        surface: l.surface,
        enemy: null,
        dir: s,
        from: "player",
      };
      emitLocal("impact", u);
      b({
        k: "cb",
        e: "impact",
        shooter: shooter.id,
        point: arr3(l.point, n2),
        normal: arr3(l.normal, n2),
        dist: n2(l.dist),
        surface: l.surface,
        dir: arr3(s, n3),
        from: "player",
      });
      return u;
    }
    return null;
  }

  function pvpBroadcastFire(e) {
    // §11.1 敌方开火暴露广播：权威处理 sh 时播发开火者眼位 {k:"pvp",e:"fire",id,
    // pos:[x,y,z]}（读 roster 该玩家最新 pos+眼高，crouch 取低头眼位——各端 HUD 据
    // 此出罗盘红色威胁标记：方位+距离+1.8s 渐隐，敌队过滤在 HUD 侧按 team 做）。
    // 限频每射 4/s：同 shooter 距上次**已播发** PVP.fireIndGapMs(250ms) 内合并丢弃
    // （窗口不因被丢弃的射而滑动——连射流恒保 4/s 上限，射速粗校验 shotGap 60ms
    // 之外的合理快射才走到这里）。host 本机 emitLocal 同名事件（中继不回声房主
    // 自身广播）；client 端由 pvp 流程从载荷翻译 pvp:enemyFire——两端各单次。
    var now = hostMs();
    if (e.lastFireMs > 0 && now - e.lastFireMs < PVP.fireIndGapMs) return;
    e.lastFireMs = now;
    var pos = {
      x: n2(e.pos.x),
      y: n2(e.pos.y + (e.crouch ? PLAYER_DIMENSIONS.crouchEye : PLAYER_DIMENSIONS.eye)),
      z: n2(e.pos.z),
    };
    b({ k: "pvp", e: "fire", id: e.id, pos: [pos.x, pos.y, pos.z] });
    emitLocal("pvp:enemyFire", { id: e.id, pos: pos });
  }

  // ============ 契约 §2.3 权威入口 ============

  function onInteract(playerId, relayId, on) {
    try {
      var e = roster.get(playerId);
      var relay = resolveRelay(relayId);
      if (!e || !relay || relay.cut) return false;
      if (!on) {
        relay.holders.delete(playerId);
        return true;
      }
      if (!e.alive || !validateInteract(e, relay)) return false;
      relay.holders.add(playerId);
      return true;
    } catch (err) {
      logErr("onInteract", err);
      return false;
    }
  }

  function onShot(playerId, origin, dir, t) {
    // 权威 hitscan——逐字复刻 combat.js:18-65 playerShot 判定链。
    // t（sh 载荷，客户端估计的主机时刻 shotT）：仅 pvp 回溯判定消费；合作路径
    // 与原版一样忽略该字段（原 t 为客户端本地时间戳，host 侧从未消费，语义收编
    // 详见 protocol.js LAGCOMP 注释）。
    try {
      var o = toV3(origin, _vA),
        s = toV3(dir, _vB);
      if (!o || !s || s.lengthSq() < 1e-8) return null;
      s.normalize();
      var e = roster.get(playerId);
      if (!e) return null;
      if (
        e.lastShot >= 0 &&
        clock - e.lastShot < TUNE.shotGap &&
        !(e.lastShot > clock)
      )
        return null; // 射速粗校验：<60ms 丢弃
      e.lastShot = clock;

      if (pvpMode()) {
        // §11.1 敌方开火暴露：权威处理 sh 即播发开火者眼位（在保护解除之前——
        // 保护期开火=解除保护那一枪同样暴露；命中与否都播，续射续曝由 HUD 1.8s
        // 渐隐窗口叠加）
        pvpBroadcastFire(e);
        // §10.0 开火立即解除重生保护（CF 语义，防蹲点滥用）：保护期内收到该玩家
        // sh 即除保护 + 广播轻量 protEnd（各端 HUD 撤保护提示；host 本地 emit 同名
        // 事件——本机开火路径也走这里，client 端另有 player.js 本地预测先行）
        if (e.protUntil > clock) {
          e.protUntil = 0;
          b({ k: "pvp", e: "protEnd", id: playerId });
          emitLocal("pvp:protEnd", { id: playerId });
        }
        return pvpShot(o, s, e, t); // 对抗：players[] 分部位回溯判定（无敌人参与）
      }

      var phys = context.physics && context.physics.raycast;
      var enRay = context.enemies && context.enemies.raycast;
      if (!phys || !enRay) return null;
      var l = phys(o, s, TUNE.shotRange),
        c = enRay(o, s, l ? l.dist : TUNE.shotRange);
      if (c && c.enemy) {
        var mult = c.part === "weak" ? TUNE.weakMult : 1,
          killed = false;
        currentAttacker = playerId; // enemy:killed 订阅据此补 by 归属
        try {
          killed = c.enemy.damage(
            TUNE.shotDamage * mult,
            c.point,
            s,
            c.part,
          ) === true;
        } finally {
          currentAttacker = null;
        }
        var f = {
          point: c.point,
          normal: c.normal || s.clone().negate(),
          dist: c.dist,
          surface: "enemy",
          enemy: c.enemy,
          part: c.part,
          dir: s,
          from: "player",
          killed: killed,
        };
        emitLocal("impact", f);
        emitLocal("player:hitEnemy", {
          enemy: c.enemy,
          part: c.part,
          killed: killed,
          weak: c.part === "weak",
          attacker: playerId,
        });
        var reg = nidMap.get(c.enemy);
        b({
          k: "cb",
          e: "hitEnemy",
          attacker: playerId,
          nid: reg ? reg.nid : null,
          part: c.part || "body",
          weak: c.part === "weak",
          killed: killed,
          point: arr3(c.point, n2),
          hp: isFinite(+c.enemy.hp) ? Math.round(c.enemy.hp) : undefined,
        });
        return f;
      }
      if (l) {
        var u = {
          point: l.point,
          normal: l.normal,
          dist: l.dist,
          surface: l.surface,
          enemy: null,
          dir: s,
          from: "player",
        };
        emitLocal("impact", u);
        b({
          k: "cb",
          e: "impact",
          shooter: playerId,
          point: arr3(l.point, n2),
          normal: arr3(l.normal, n2),
          dist: n2(l.dist),
          surface: l.surface,
          dir: arr3(s, n3),
          from: "player",
        });
        return u;
      }
      return null;
    } catch (err) {
      logErr("onShot", err);
      return null;
    }
  }

  function onEnemyFire(origin, dir) {
    // 对全体玩家结算——复刻 combat.js:66-93 enemyShot 圆柱判定（取射线上最近者）
    try {
      var o = toV3(origin, _vA),
        s = toV3(dir, _vB);
      if (!o || !s || s.lengthSq() < 1e-8) return false;
      s.normalize();
      var phys = context.physics && context.physics.raycast;
      var l = phys ? phys(o, s, TUNE.enemyShotRange) : null;
      var worldDist = l ? l.dist : TUNE.enemyShotRange;
      var best = null;
      for (var e of roster.values()) {
        if (!e.alive) continue;
        _vC.copy(e.pos);
        _vC.y += TUNE.aimLift;
        var h = _vD.copy(_vC).sub(o).dot(s);
        if (h <= 0 || h >= worldDist) continue;
        _vC.copy(o).addScaledVector(s, h);
        if (
          Math.hypot(_vC.x - e.pos.x, _vC.z - e.pos.z) < TUNE.cylRadius &&
          Math.abs(_vC.y - (e.pos.y + TUNE.cylLift)) < TUNE.cylHalf
        )
          if (!best || h < best.h) best = { e: e, h: h };
      }
      if (best) {
        applyPlayerDamage(best.e, TUNE.enemyShotDamage, "enemy", o);
        return true;
      }
      if (l) {
        emitLocal("impact", {
          point: l.point,
          normal: l.normal,
          dist: l.dist,
          surface: l.surface,
          enemy: null,
          dir: s,
          from: "enemy",
        });
        b({
          k: "cb",
          e: "impact",
          point: arr3(l.point, n2),
          normal: arr3(l.normal, n2),
          dist: n2(l.dist),
          surface: l.surface,
          dir: arr3(s, n3),
          from: "enemy",
        });
      }
      return false;
    } catch (err) {
      logErr("onEnemyFire", err);
      return false;
    }
  }

  function onExplode(pos, radius, dmg, source) {
    // AoE——复刻 combat.js:95-121 explode：敌方全额衰减+LOS，玩家半额+LOS
    try {
      var n = toV3(pos, _vA);
      if (!n) return;
      var r = isFinite(+radius) && +radius > 0 ? +radius : TUNE.explodeRadius;
      var o = isFinite(+dmg) && +dmg > 0 ? +dmg : TUNE.explodeDamage;
      currentAttacker = resolveAttacker(source);
      try {
        var list = context.enemies && context.enemies.list;
        if (Array.isArray(list) && context.physics && context.physics.lineOfSight)
          for (var en of list) {
            if (!en || !en.alive || !en.pos) continue;
            var d = en.pos.distanceTo(n);
            if (d < r)
              context.physics.lineOfSight(
                n,
                _vB.copy(en.pos).setY(en.pos.y + 0.5),
              ) &&
                en.damage(
                  o * (1 - d / r),
                  en.pos,
                  _vC.copy(en.pos).sub(n).normalize(),
                  "body",
                );
          }
      } finally {
        currentAttacker = null;
      }
      if (context.physics && context.physics.lineOfSight)
        for (var e of roster.values()) {
          if (!e.alive) continue;
          _vB.copy(e.pos);
          _vB.y += TUNE.aimLift;
          var pd = _vB.distanceTo(n);
          if (pd < r && context.physics.lineOfSight(n, _vB))
            applyPlayerDamage(
              e,
              o * TUNE.explodePlayerHalf * (1 - pd / r),
              "explosion",
              n,
            );
        }
    } catch (err) {
      logErr("onExplode", err);
    }
  }

  function onPlayerDamage(playerId, dmg, kind) {
    // 坠落/落水救援等环境伤害的权威结算
    try {
      var e = roster.get(playerId);
      if (!e) return;
      applyPlayerDamage(e, dmg, kind || "env", null);
    } catch (err) {
      logErr("onPlayerDamage", err);
    }
  }

  function onSpawnRequest(type, pos, opts) {
    // flow 刷怪走这里：本地权威 spawn（enemy:spawn 订阅负责 nid+ee.spawn 广播）
    try {
      var enemiesApi = context.enemies;
      if (!enemiesApi || typeof enemiesApi.spawn != "function") return null;
      pendingSpawnOpts = opts || null;
      try {
        return enemiesApi.spawn(type, pos, opts || {}); // 保留接收者，防 this 丢失
      } finally {
        pendingSpawnOpts = null;
      }
    } catch (err) {
      logErr("onSpawnRequest", err);
      return null;
    }
  }

  function onRetire(netId) {
    // 接受 nid 或 enemy 对象（集成侧两种引用都可能传）
    try {
      var en = null,
        reg = null;
      if (netId && typeof netId == "object") {
        en = netId;
        reg = nidMap.get(en);
      } else {
        for (var entry of nidMap)
          if (entry[1].nid === netId) {
            en = entry[0];
            reg = entry[1];
            break;
          }
      }
      if (!reg) return;
      nidMap.delete(en);
      b({ k: "ee", e: "retire", nid: reg.nid });
    } catch (err) {
      logErr("onRetire", err);
    }
  }

  function onClear() {
    try {
      nidMap.clear();
      b({ k: "ee", e: "clear" }); // 客户端清 puppet 映射
      var clear = context.enemies && context.enemies.clear;
      typeof clear == "function" && clear.call(context.enemies); // 幂等，集成侧重复调用无害
    } catch (err) {
      logErr("onClear", err);
    }
  }

  function onObjectiveProgress(relayId, t) {
    try {
      var relay = resolveRelay(relayId);
      if (!relay || relay.cut) return;
      var v = Math.min(1, Math.max(0, +t || 0));
      relay.t = v;
      relay.dirty = false;
      emitLocal("objective:progress", { id: relay.id, t: v });
      b({ k: "ob", e: "progress", relay: relay.id, t: n3(v) });
    } catch (err) {
      logErr("onObjectiveProgress", err);
    }
  }

  function onObjectiveDone(relayId) {
    try {
      var relay = resolveRelay(relayId);
      if (relay && !relay.cut) finishRelay(relay);
    } catch (err) {
      logErr("onObjectiveDone", err);
    }
  }

  function onObjectiveAll() {
    try {
      if (!allAnnounced) {
        allAnnounced = true;
        emitLocal("objective:all", {});
      }
      b({ k: "ob", e: "all" });
    } catch (err) {
      logErr("onObjectiveAll", err);
    }
  }

  function onAboard(playerId) {
    try {
      var e = roster.get(playerId);
      if (e) e.aboard = true;
      b({ k: "rm", e: "aboard", id: playerId });
    } catch (err) {
      logErr("onAboard", err);
    }
  }

  function onWipe() {
    b({ k: "rm", e: "wipe" });
  }

  function onComplete(stats) {
    try {
      b({ k: "rm", e: "complete", stats: stats || null });
    } catch (err) {
      logErr("onComplete", err);
    }
  }

  function broadcastState(stateObj) {
    // game:state 状态对象直接 fromHost 广播（I2/I5 端消费）。
    // 绝不本地 emit "game:state"——flow M() 已 emit，重复 emit 会打断状态机（防回环铁律）。
    try {
      var payload =
        typeof stateObj == "string" ? { k: "gs", state: stateObj } : stateObj;
      // 新开局归零：coop=intro / pvp=countdown（pvp 流程的开局态，语义等价"新回合"）
      if (payload && (payload.state === "intro" || payload.state === "countdown"))
        resetForNewRun(); // 时钟/目标/敌注册表/pvp 回合状态归零
      b(payload);
    } catch (err) {
      logErr("broadcastState", err);
    }
  }

  function roomTime() {
    return clock;
  }

  function difficulty() {
    // 契约 §0：按存活人数（退化取房间人数）缩放
    try {
      var alive = 0;
      for (var e of roster.values()) e.alive && alive++;
      var n = Math.max(1, alive > 0 ? alive : roster.size || 1);
      var scale = 1 + TUNE.waveStep * (n - 1);
      return {
        players: n,
        waves: TUNE.baseWaves.map((w) => ({
          gull: Math.round(w.gull * scale),
          hound: Math.round(w.hound * scale),
        })),
        maxAlive: TUNE.maxAliveBase + TUNE.maxAliveStep * (n - 1),
        pursuitExtra: TUNE.pursuitBase + TUNE.pursuitStep * (n - 1),
      };
    } catch {
      return {
        players: 1,
        waves: TUNE.baseWaves.map((w) => ({ gull: w.gull, hound: w.hound })),
        maxAlive: TUNE.maxAliveBase,
        pursuitExtra: TUNE.pursuitBase,
      };
    }
  }

  // —— 装配：订阅本地敌事件（enemy:retire 为集成侧 R4 改造后事件，缺失即静默）——
  try {
    events &&
      typeof events.on == "function" &&
      (events.on("enemy:spawn", onEnemySpawn),
      events.on("enemy:retire", onEnemyRetireEvt),
      events.on("enemy:killed", onEnemyKilledEvt));
  } catch (e) {
    logErr("subscribe", e);
  }
  try {
    net &&
      net.host &&
      typeof net.host.onClientPayload == "function" &&
      net.host.onClientPayload(handleClientPayload);
  } catch (e) {
    logErr("onClientPayload", e);
  }

  function getPvpFace() {
    // 对抗模式导出面（MP-PVP §8.2；src/game/pvp.js 房主端经此驱动回合）：
    // （注意与状态变量 pvp 区分——函数名若同名会被 var 赋值覆盖成 null）
    //  - mode()        房间是否 pvp（net.roomMode()==='pvp'）
    //  - started()     回合状态已建（startRound 至少调用过一次）
    //  - active()      回合进行中（已开局且未 roundEnd）
    //  - startRound()  回合复位（倒计时开始时调；清 kills/deaths/重生队列，下发初始板）
    //  - startPlay()   倒计时结束进 playing 时调
    //  - tick(dt)      回合节拍（房主每帧调；重生队列/score 心跳；ended 后空转）
    //  - board()       当前计分板快照 [{id,name,kills,deaths,team}]（杀数降/死亡升）
    //  - timeLeft()    兼容查询：无限时返回 Infinity，整局只按击杀数结束
    //  - team(id)      权威分队表读数（§10.1：0=蓝 1=红；roster 缺条目退蓝侧）
    if (!pvpApi)
      pvpApi = {
        mode: pvpMode,
        started: function () {
          return !!pvp;
        },
        active: function () {
          return !!(pvp && pvp.active && !pvp.ended);
        },
        startRound: pvpStartRound,
        startPlay: pvpStartPlay,
        tick: pvpTick,
        board: function () {
          return pvp ? buildPvpBoard() : [];
        },
        team: teamOf,
        timeLeft: function () {
          return Infinity;
        },
      };
    return pvpApi;
  }

  return {
    update: update,
    onInteract: onInteract,
    onShot: onShot,
    onEnemyFire: onEnemyFire,
    onExplode: onExplode,
    onPlayerDamage: onPlayerDamage,
    onSpawnRequest: onSpawnRequest,
    onRetire: onRetire,
    onClear: onClear,
    onObjectiveProgress: onObjectiveProgress,
    onObjectiveDone: onObjectiveDone,
    onObjectiveAll: onObjectiveAll,
    onAboard: onAboard,
    onWipe: onWipe,
    onComplete: onComplete,
    broadcastState: broadcastState,
    roomTime: roomTime,
    difficulty: difficulty,
    pvp: getPvpFace,
  };
}

export { createHostSim, lagcomp, PVP_TEAM_SPAWNS };
