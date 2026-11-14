// Saltline 多人合作 — 敌人提线木偶（仅 client 装配）。
// Consumes host payloads (snap + ee events) and drives the LOCAL enemy pool
// in pose-only mode: host owns AI/damage, this side only mirrors visuals.
// Contract: docs/MP-CONTRACT.md §2.5 · Blueprint: docs/MP-BLUEPRINT.md ③/④.
//
// 交叉陷阱（R15）：协议逻辑名 gull=空中机械飞鸥(walker.js 建造)、hound=地面
// 机械猎犬(drone.js 建造)。本模块只认逻辑名，绝不 import walker/drone。
// 事件铁律：入站消息一律走本模块显式入口，绝不 emit 到 context.events（防回环）。

import { Vector3 } from "../vendor/three-r180.js";
import { createRandom } from "../core/random.js";

// ——— 节拍参数（秒，走本模块自累积时钟，不依赖墙钟） ———
var SPAWN_GRACE = 0.8; // 快照里出现未知 nid，等 ee.spawn 这么久没到 → 本地兜底 spawn
var SPAWN_RETRY = 0.5; // 对象池耗尽时的重试间隔
var SPAWN_GIVEUP = 6; // 重试上限，之后放弃（主机快照会持续重新提名）
var STALE_DROP = 3; // nid 连续缺席快照这么久 → 视作已 retire（丢包兜底）
var KILL_WATCH = 0.7; // 快照 hp<=0 但 ee.killed 迟迟未到 → 本地补刀走死亡动画

var MODE_WORDS = { patrol: 1, investigate: 1, search: 1, engage: 1 };
var HOUND_ES = {
  move: 1,
  aim: 1,
  tele: 1,
  burst: 1,
  wind: 1,
  lunge: 1,
  recover: 1,
  cool: 1,
};

var UP = new Vector3(0, 1, 0);
var _end = new Vector3();

function wrapAngle(a) {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function arrV3(src) {
  if (!Array.isArray(src) || src.length < 3) return null;
  var x = +src[0],
    y = +src[1],
    z = +src[2];
  return isFinite(x) && isFinite(y) && isFinite(z) ? new Vector3(x, y, z) : null;
}

function num(v) {
  return v != null && isFinite(+v) ? +v : null;
}

// ee.killed 的 ds 缺失/非法时用 nid 派生，保证死亡动画仍两端可复现
function seedOf(ds, nid) {
  var s = Number(ds) >>> 0;
  if (!s) s = (Number(nid) * 2654435761) >>> 0;
  return (s >>> 0) || 1;
}

// ee.spawn 的 opts 原样语义（blueprint ③）：passive/hover/patrolRadius/state/
// yaw/target/patrolLine。Vector3 字段在协议里是 [x,y,z]，此处转回本地形态。
function convertOpts(src) {
  var out = {};
  if (!src || typeof src !== "object") return out;
  var v;
  if (src.passive !== undefined) out.passive = !!src.passive;
  if ((v = num(src.hover)) !== null) out.hover = v;
  if ((v = num(src.patrolRadius)) !== null) out.patrolRadius = v;
  if (typeof src.state === "string") out.state = src.state;
  if ((v = num(src.yaw)) !== null) out.yaw = v;
  if (Array.isArray(src.patrolLine)) {
    var line = [];
    for (var i = 0; i < src.patrolLine.length; i++) {
      var p = arrV3(src.patrolLine[i]);
      p && line.push(p);
    }
    line.length && (out.patrolLine = line);
  }
  var t = arrV3(src.target);
  t && (out.target = t);
  return out;
}

function createEnemyPuppet(context, net) {
  var enabled = true;
  var clock = 0; // 本地累积时钟（秒），仅用于兜底期限
  var map = new Map(); // nid → { nid, obj, ty, seenAt, yawAt, prevYaw, dead, killPend }
  var pending = new Map(); // nid → { ty, pos, opts, yaw, firstAt, lastTry, grace }
  var tomb = new Set(); // 已终结 nid：快照再提也不复活，防幽灵木偶
  var errored = false; // 日志只喷一次，学 runtime 的 updateSystem.err 风格

  function fail(stage, e) {
    if (errored) return;
    errored = true;
    console.error("[mp:puppet] " + stage + " threw: " + ((e && e.stack) || e));
  }

  // ——— puppet 模式旗标：I4 会在 enemies.js 读它跳过 think 只跑姿态 ———
  function markPuppetMode() {
    var E = context.enemies;
    if (!E || E.stub) return;
    if (E.puppetMode !== true) E.puppetMode = true;
    if (E.isPuppet !== true) E.isPuppet = true;
  }

  // ——— nid → 本地池对象 ———
  function trySpawn(nid, ty, posSrc, optsSrc, yaw) {
    var E = context.enemies;
    if (!E || typeof E.spawn !== "function") return null;
    if (ty !== "gull" && ty !== "hound") return null; // 契约逻辑名，防 R15 交叉
    var pos = arrV3(posSrc);
    if (!pos) return null;
    var obj = null;
    try {
      obj = E.spawn(ty, pos, convertOpts(optsSrc));
    } catch {
      return null;
    }
    if (!obj) return null; // 池耗尽（enemies 兜底 stub 也返回 null）
    var y = num(yaw);
    if (y !== null) {
      try {
        obj.yaw = y;
        if (obj.rig && obj.rig.group) obj.rig.group.rotation.y = y;
      } catch {}
    }
    var rec = {
      nid: nid,
      obj: obj,
      ty: obj.type || ty,
      seenAt: clock,
      yawAt: clock,
      prevYaw: y !== null ? y : obj.yaw || 0,
      dead: !obj.alive,
      killPend: 0,
    };
    map.set(nid, rec);
    tomb.delete(nid);
    // 池复用撞车：同一对象已被别的 nid 登记 → 旧 nid 必是主机侧已 retire
    for (var other of map.keys())
      if (other !== nid && map.get(other).obj === obj) {
        map.delete(other);
        tomb.add(other);
      }
    return obj;
  }

  function ensureFromSnapshot(s) {
    var rec = map.get(s.nid);
    if (rec) return rec;
    if (tomb.has(s.nid)) return null;
    var p = pending.get(s.nid);
    if (p) {
      // 刷新为最新快照数据，兜底 spawn 用新位置
      arrV3(s.pos) && (p.pos = s.pos);
      s.opts && (p.opts = s.opts);
      p.yaw = num(s.yaw) !== null ? s.yaw : p.yaw;
      return null;
    }
    pending.set(s.nid, {
      ty: s.ty,
      pos: s.pos,
      opts: s.opts || null,
      yaw: num(s.yaw),
      firstAt: clock,
      lastTry: clock,
      grace: SPAWN_GRACE, // 给 ee.spawn 在途留时间，800ms 后强制本地 spawn
    });
    return null;
  }

  // ——— retire：走 enemies 真实入口（debug.ctx.retire 即 enemies.js:286 h.retire）———
  function retireEnemy(obj) {
    if (!obj) return;
    var E = context.enemies;
    try {
      if (
        E &&
        E.debug &&
        E.debug.ctx &&
        typeof E.debug.ctx.retire === "function"
      ) {
        E.debug.ctx.retire(obj);
        return;
      }
      if (typeof obj._deactivate === "function") obj._deactivate();
      var list = E && E.list;
      if (list) {
        var i = list.indexOf(obj);
        i >= 0 && list.splice(i, 1);
      }
    } catch {}
  }

  // ——— killed：喂 deathSeed，走 walker/drone 的 damage 大伤公开入口 ———
  //（v()/q() 是闭包私有，damage 是唯一公开死亡动画入口；hp 已被快照写低，
  //  这里直接大额伤害触发；随机量事后按 ds 对齐：gull 的 spin/lostRotor、
  //  hound 的 dieRoll/diePitch —— 共享 h.rng 闭包捕获无法替换，只能覆写结果。）
  function killLocal(rec, ds, nid) {
    var obj = rec.obj;
    if (!obj || !obj.alive) return;
    var ty = obj.type || rec.ty;
    try {
      obj.damage(1e6, obj.pos, null, "body");
    } catch {}
    if (obj.alive) return; // 入口被 gate（异常态），别硬改
    var rng = createRandom(seedOf(ds, nid));
    if (ty === "gull") {
      var bones = obj.rig && obj.rig.bones;
      var want = rng.int(0, 3);
      if (bones) {
        // damage 内部用本地共享 rng 藏了一片桨叶 → 找出来还原，再藏 ds 指定的
        // 那片（_activate 时四片都复位为 1，所以死亡后恰好只有一片是被藏的）
        for (var i = 0; i < 4; i++) {
          var b = bones["rotor" + i];
          if (b && b.scale && b.scale.x < 0.05) {
            if (i !== want) b.scale.setScalar(1);
            break;
          }
        }
        var wb = bones["rotor" + want];
        wb && wb.scale.setScalar(1e-4);
      }
      try {
        obj.lostRotor = want;
        obj.spin = rng.sign() * (5 + rng() * 3);
      } catch {}
    } else if (ty === "hound") {
      try {
        // O() 姿态在 !alive 时直接以 diePitch/dieRoll 为弹簧目标 → 覆写即对齐
        obj.dieRoll = rng.sign() * (0.25 + rng() * 0.3);
        obj.diePitch = (rng() - 0.5) * 0.25;
      } catch {}
    }
  }

  // ——— §2.5 applySnapshot ———
  function applySnapshot(snap) {
    try {
      markPuppetMode();
      if (!enabled || !snap || !Array.isArray(snap.enemies)) return;
      for (var i = 0; i < snap.enemies.length; i++) {
        var s = snap.enemies[i];
        if (!s || s.nid == null) continue;
        var nid = s.nid;
        var rec = map.get(nid);
        if (!rec) {
          if (tomb.has(nid)) continue; // 已终结：池复用后旧 nid 残留快照，忽略
          ensureFromSnapshot(s);
          continue;
        }
        rec.seenAt = clock;
        var obj = rec.obj;
        if (!obj.active) {
          // 本地已退场（坠毁/沉底/池腾位）→ 映射作废，等 ee.spawn 重新提名
          map.delete(nid);
          tomb.add(nid);
          continue;
        }
        if (!obj.alive) continue; // 死亡动画本地自跑，别拿快照去打架
        // 位姿直写：obj.pos === rig.group.position（walker.js:100 / drone.js:125）
        var pos = arrV3(s.pos);
        if (pos) obj.pos.copy(pos);
        var yaw = num(s.yaw);
        if (yaw !== null) {
          if (obj.type === "hound") {
            // 快照无 speed/yawRate：由连续快照差分推步态参数（gait H() 消费）
            var dT = Math.max(0.03, clock - rec.yawAt);
            try {
              obj.yawRate = clamp(wrapAngle(yaw - rec.prevYaw) / dT, -6, 6);
            } catch {}
            rec.prevYaw = yaw;
            rec.yawAt = clock;
          }
          obj.yaw = yaw;
          try {
            obj.rig && obj.rig.group && (obj.rig.group.rotation.y = yaw);
          } catch {}
        }
        var hp = num(s.hp);
        if (hp !== null) {
          obj.hp = hp;
          if (hp <= 0) rec.killPend || (rec.killPend = clock);
          else rec.killPend = 0;
        }
        var vel = arrV3(s.vel);
        if (vel) {
          if (obj.type === "gull" && obj.vel) obj.vel.copy(vel);
          else if (obj.type === "hound")
            try {
              obj.speed = clamp(Math.hypot(vel.x, vel.z), 0, 12);
            } catch {}
        }
        if (typeof s.md === "string") {
          // md 语义：优先 AI mode（威胁灯色/信标节拍靠它）；hound 附带 es。
          // 不写 gull 的 atk —— 本地开火机构必须只由 ee.fire 驱动，防双发。
          if (MODE_WORDS[s.md]) {
            if (obj.mode !== s.md) obj.mode = s.md;
          } else if (obj.type === "hound" && HOUND_ES[s.md] && obj.es !== s.md)
            obj.es = s.md;
        }
        if (Array.isArray(s.aim)) {
          var ay = num(s.aim[0]),
            ap = num(s.aim[1]);
          try {
            if (ay !== null)
              obj.type === "gull" ? (obj.gy = ay) : (obj.tyaw = ay);
            if (ap !== null)
              obj.type === "gull" ? (obj.gp = ap) : (obj.tpitch = ap);
          } catch {}
        }
        if (obj.type === "gull") {
          // 姿态半段依赖的传感器朝向（think 半段被跳过后本地补齐）
          try {
            obj.fwd && obj.fwd.set(Math.sin(obj.yaw), 0, Math.cos(obj.yaw));
            obj.sensor &&
              obj.sensor
                .set(0, -0.17, 0.27)
                .applyAxisAngle(UP, obj.yaw)
                .add(obj.pos);
          } catch {}
        }
      }
    } catch (e) {
      fail("applySnapshot", e);
    }
  }

  // 缺席 nid：宽限后视作 retire（ee.retire 丢包兜底）。帧驱动——即便主机
  // 快照断流也能清场（map 上限 18，每帧扫描零负担）。
  function purgeStale() {
    for (var k of map.keys()) {
      var r = map.get(k);
      if (clock - r.seenAt > STALE_DROP) {
        retireEnemy(r.obj);
        map.delete(k);
        tomb.add(k);
      }
    }
  }

  // ——— ee 事件入口 ———
  function onSpawn(evt) {
    try {
      if (!enabled || !evt || evt.nid == null) return;
      var rec = map.get(evt.nid);
      if (rec && rec.obj.active && rec.obj.alive) {
        rec.seenAt = clock; // 重复 spawn：已跟踪，幂等
        return;
      }
      if (rec) {
        map.delete(evt.nid); // 旧壳未清：退掉重挂
      }
      tomb.delete(evt.nid);
      pending.delete(evt.nid);
      if (!trySpawn(evt.nid, evt.ty, evt.pos, evt.opts, evt.yaw))
        pending.set(evt.nid, {
          ty: evt.ty,
          pos: evt.pos,
          opts: evt.opts || null,
          yaw: num(evt.yaw),
          firstAt: clock,
          lastTry: clock,
          grace: 0, // 事件已到，只等池位
        });
    } catch (e) {
      fail("onSpawn", e);
    }
  }

  function onRetire(nid) {
    try {
      pending.delete(nid);
      tomb.add(nid);
      var rec = map.get(nid);
      if (!rec) return;
      map.delete(nid);
      retireEnemy(rec.obj);
    } catch (e) {
      fail("onRetire", e);
    }
  }

  function onKilled(evt) {
    try {
      if (!evt || evt.nid == null) return;
      pending.delete(evt.nid);
      var rec = map.get(evt.nid);
      if (!rec) return; // 没赶上 spawn 就死了：不值得为尸体兜底
      rec.dead = true;
      rec.killPend = 0;
      killLocal(rec, evt.ds, evt.nid);
    } catch (e) {
      fail("onKilled", e);
    }
  }

  // ——— 纯视觉三件（只碰 context.fx / 对象视觉位，绝不 emit 事件） ———
  function onFire(evt) {
    try {
      if (!enabled || !evt) return;
      var rec = map.get(evt.nid);
      var ty = (rec && (rec.ty || rec.obj.type)) || evt.ty;
      var isHound = ty === "hound"; // gull 与未知类型按 gull 弹视觉口径
      var pos = arrV3(evt.pos),
        dir = arrV3(evt.dir);
      if (!pos || !dir || dir.lengthSq() < 1e-8) return;
      dir.normalize();
      var fx = context.fx;
      if (fx && typeof fx.muzzleFlash === "function")
        try {
          fx.muzzleFlash(pos, dir, { scale: isHound ? 0.9 : 0.55 });
        } catch {}
      if (fx && typeof fx.tracer === "function")
        try {
          // 同主机 hitscan 口径的视觉长度（hound 源事件 drone.js:726-770）
          var maxD = isHound ? 90 : 60;
          var dist = maxD;
          var hit =
            context.physics && context.physics.raycast
              ? context.physics.raycast(pos, dir, maxD)
              : null;
          if (hit && hit.dist > 0.5) dist = hit.dist;
          _end.copy(pos).addScaledVector(dir, dist);
          fx.tracer(
            pos,
            _end,
            isHound
              ? { color: 16760944, speed: 260, width: 0.035 }
              : { color: 16738858, speed: 70, width: 0.022 },
          );
        } catch {}
      if (isHound)
        try {
          // 猎犬炮口闪光灯（源事件同参数 drone.js:760-762）
          var lp = context.render && context.render.lightPool;
          lp && lp.flash && lp.flash(pos, 16756832, 22, 7, 0.05);
        } catch {}
    } catch (e) {
      fail("onFire", e);
    }
  }

  function onTelegraph(evt) {
    try {
      if (!enabled || !evt || evt.nid == null) return;
      var rec = map.get(evt.nid);
      if (!rec || !rec.obj) return;
      // 主机侧 telegraph 的视觉=镜头预警灯充能（walker/drone 的 flare），
      // 姿态半段会让它按指数亮起再衰减；这里直接顶满保证两端一致起亮。
      try {
        rec.obj.flare = 1;
      } catch {}
    } catch (e) {
      fail("onTelegraph", e);
    }
  }

  function onMelee(evt) {
    try {
      if (!enabled || !evt) return;
      var pos = arrV3(evt.pos);
      if (!pos) {
        var rec = map.get(evt.nid);
        rec && rec.obj && (pos = rec.obj.pos.clone());
      }
      if (!pos) return;
      var fx = context.fx;
      if (!fx) return;
      pos.y += 0.9; // 爪击命中高度（猎犬扑咬 torso 位）
      if (typeof fx.sparks === "function")
        try {
          fx.sparks(pos, UP, 8);
        } catch {}
      if (typeof fx.dust === "function")
        try {
          fx.dust(pos, UP);
        } catch {}
    } catch (e) {
      fail("onMelee", e);
    }
  }

  // ——— 主循环 ———
  function update(dt) {
    if (!enabled) return;
    try {
      markPuppetMode();
      clock += clamp(+dt || 0, 0, 0.25);
      // 待补 spawn：过了宽限期开始试，池位腾出即成
      for (var nid of pending.keys()) {
        var p = pending.get(nid);
        if (
          clock - p.firstAt >= p.grace &&
          clock - p.lastTry >= SPAWN_RETRY
        ) {
          p.lastTry = clock;
          if (trySpawn(nid, p.ty, p.pos, p.opts, p.yaw)) pending.delete(nid);
          else if (clock - p.firstAt > SPAWN_GIVEUP) pending.delete(nid);
        }
      }
      // 补刀看门狗：ee.killed 丢包时由快照 hp<=0 兜底
      for (var k of map.keys()) {
        var r = map.get(k);
        if (
          r.killPend &&
          clock - r.killPend > KILL_WATCH &&
          r.obj.alive &&
          r.obj.active
        ) {
          r.dead = true;
          r.killPend = 0;
          killLocal(r, null, k);
        }
      }
      purgeStale();
    } catch (e) {
      fail("update", e);
    }
  }

  // ——— 生命周期 ———
  function setEnabled(b) {
    enabled = !!b;
    if (!enabled) {
      // 冻结并丢映射，不动 enemies 本体（showcase/bench 自管世界）
      map.clear();
      pending.clear();
      tomb.clear();
    }
  }

  function clear() {
    try {
      // 与 flow.js:248 全量重置同一入口：房间重开/回大厅清场
      var E = context.enemies;
      E && typeof E.clear === "function" && E.clear();
    } catch (e) {
      fail("clear", e);
    }
    map.clear();
    pending.clear();
    tomb.clear();
  }

  // ——— 入站分发（k=="snap" → applySnapshot；k=="ee" → 事件分派） ———
  function handleHostPayload(p) {
    if (!enabled || !p) return;
    try {
      if (p.k === "snap") {
        applySnapshot(p);
        return;
      }
      if (p.k !== "ee") return;
      switch (p.e) {
        case "spawn":
          onSpawn(p);
          break;
        case "retire":
          onRetire(p.nid);
          break;
        case "killed":
          onKilled(p);
          break;
        case "fire":
          onFire(p);
          break;
        case "telegraph":
          onTelegraph(p);
          break;
        case "melee":
          onMelee(p);
          break;
        case "clear":
          clear(); // sim.onClear 广播（契约 §2.3），防御性支持
          break;
      }
    } catch (e) {
      fail("hostPayload", e);
    }
  }

  // net 离线兜底 stub 没有 client 面 —— 不订阅、保持惰性
  try {
    net &&
      net.client &&
      typeof net.client.onHostPayload === "function" &&
      net.client.onHostPayload(handleHostPayload);
  } catch (e) {
    fail("subscribe", e);
  }
  markPuppetMode();

  return {
    update: update,
    applySnapshot: applySnapshot,
    onSpawn: onSpawn,
    onRetire: onRetire,
    onKilled: onKilled,
    onFire: onFire,
    onTelegraph: onTelegraph,
    onMelee: onMelee,
    setEnabled: setEnabled,
    clear: clear,
  };
}

export { createEnemyPuppet };
