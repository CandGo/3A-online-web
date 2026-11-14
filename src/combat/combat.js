// 射击 / 敌方火力 / AoE 结算（多人版：房主权威，客户端只做表现）。
// 契约依据 docs/MP-CONTRACT.md §3 combat 行 / docs/MP-PVP.md §8.2 combat 行：
//  - enemy:killed payload 补 by 归属（本端射击结算窗口内就地标；单机用 "local"）
//  - playerShot：client 只做视觉 + net.client.send({k:"sh"})；host 走 sim.onShot
//  - enemyShot：host 走 sim.onEnemyFire；client 完全跳过（表现等 cb.hitPlayer 回流）
//  - explode：host 走 sim.onExplode；client 零结算（视觉由 ee 通道负责）
//  - pvp（net.roomMode()==='pvp'）：playerShot 加远端玩家分部位命中【纯视觉】
//    （MP-PVP §9.1：hitbox.js 同参数替换 v1 圆柱）——曳光止点/命中标记走现有通道
//    （player:hitEnemy → hud hitmarker，part 透传；爆头复用 weak 高亮变体），不扣血、
//    不计 hits、不上报命中（sh 照旧只带 origin/dir，判定归 host 权威）
//  - §11.1 受击方向黑板：本地 player:hit（pvp）时把攻击者位姿快照写
//    context.pvpLastHitFrom={pos,at}（HUD 受击扇形数据源）——攻击者从 remote-players
//    表按 fromPos（射击者眼位）水平就近反查，查无（环境伤/攻击者不在场）即跳过
// 全部分支挂 online()/pvpMode() 门，单机行为零回归。
import { Vector3 } from "../vendor/three-r180.js";
import { raycastPlayerParts } from "../net/hitbox.js";

// §11.1 受击方向黑板参数：攻击者反查容差（水平米）。fromPos 是射击者眼位快照
// （host 端 applyPlayerDamage 直传射击原点 / client 端 cb.hitPlayer.from 回流），
// remote-players 是插值后的脚位（~100-200ms 时差位移）——同一人的水平偏差远小于
// 该容差，异人通常相隔数米；即便贴脸认错，两者几乎同点位，扇形方位只差毫厘。
var THREAT = { matchR: 2.0 };

function createCombat(context) {
  let e = {
    shots: 0,
    hits: 0,
    kills: 0,
  };
  // 本端射击结算窗口的击杀归属标记：enemy:killed 在 damage() 内同步派发，
  // 订阅者据此就地补 by（先于 host-sim 的订阅者，ee.killed 广播沿用该归属）。
  let killTag = null;

  // ---- 联机访问面（context.net 由 runtime 装配；FALLBACKS 兜底 stub 时视为离线）----
  function netApi() {
    let n = context.net;
    return n && !n.stub && typeof n.mode === "string" ? n : null;
  }
  function online() {
    // 仅对局态（host/client）分流权威；connecting/lobby 期保持单机行为
    let n = netApi();
    return n && (n.mode === "host" || n.mode === "client") ? n : null;
  }
  function simApi() {
    // host-sim 的 context 键由 runtime 集成定名，此处多候选容错
    return context.netSim || context.hostSim || context.sim || null;
  }
  function tag() {
    // 击杀归属标签：联机取 net.selfId()，单机/异常兜底 "local"
    let n = netApi();
    if (n && n.mode !== "offline") {
      try {
        let i = n.selfId();
        if (i != null) return i;
      } catch {}
    }
    return "local";
  }
  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }
  function pvpMode() {
    // 对抗模式判定（MP-PVP §8.1）：仅对局态有意义；net.roomMode 缺席即 false
    let n = netApi();
    if (!n || (n.mode !== "host" && n.mode !== "client")) return false;
    try {
      return typeof n.roomMode == "function" && n.roomMode() === "pvp";
    } catch {
      return false;
    }
  }
  function pvpTeamNum(id) {
    // §10.1 队伍号（0=蓝 1=红）：net.myTeam（本人）/players[].team 优先，
    // 序位奇偶兜底（§10.0 加入序 0,2→蓝 1,3→红）；查不到返回 null（不按队友跳过
    // ——宁可多一个视觉标记也不吞敌情反馈，伤害口径始终归 host 权威）
    let n = netApi();
    try {
      if (n && typeof n.players == "function") {
        let list = n.players();
        if (Array.isArray(list))
          for (let i = 0; i < list.length; i++)
            if (list[i] && list[i].id === id)
              return list[i].team === 1
                ? 1
                : list[i].team === 0
                  ? 0
                  : i % 2;
      }
      if (n && typeof n.myTeam == "function" && id === tag()) {
        let t = n.myTeam();
        if (t === 0 || t === 1) return t;
      }
    } catch {}
    return null;
  }
  function pvpProtected(id) {
    // §10.0 保护期目标视觉吞伤：pvp 流程黑板 protMap（id→到期 ms，pvp:respawn
    // 写入 in+prot 窗口、protEnd 即撤）——host 权威吞伤在前，此处只对齐视觉
    try {
      let m = context.pvpProtMap;
      if (!m) return false;
      let until = +m[id];
      return isFinite(until) && until > nowMs();
    } catch {
      return false;
    }
  }
  function pvpVisualHit(n, s, r, wallHit) {
    // 纯视觉：远端玩家分部位命中（MP-PVP §9.1 同参数替换 v1 圆柱）——hitbox.js
    // 解析求交取最近部位（与 host 权威同表同参），距墙近者胜（wall 优先级照
    // playerShot 既有次序）。命中标记走 player:hitEnemy 现有视觉通道（hud
    // hitmarker 四态 hit/weak/headshot/kill），part 透传；爆头（part==="head"）
    // 由 hud 按 pvp+part 识别高亮 + 本处复用 impact_enemy 换参做专属听感
    // （library.js 无独立 hitmarker 音色 cue，不造新音频 API）。绝不扣血、
    // 绝不计 hits、绝不外发命中（host 权威）。
    let list;
    try {
      let rp = context.remotePlayers || context.remotes;
      list = rp && typeof rp.list == "function" ? rp.list() : [];
    } catch {
      return null;
    }
    if (!Array.isArray(list) || !list.length) return null;
    let wall = wallHit;
    if (!wall) {
      try {
        wall = context.physics.raycast(n, s, r);
      } catch {}
    }
    let wallDist = wall ? wall.dist : r;
    let myTeam = pvpTeamNum(tag()),
      best = null;
    for (let p of list) {
      if (!p || p.alive === !1 || !p.pos) continue;
      // §10.2 队友跳过：无 hitmarker 无音效（host 权威友军免伤在前，视觉不误导）；
      // 队伍未知（null）不跳——敌情反馈宁多勿吞
      let pt = pvpTeamNum(p.id);
      if (pt != null && myTeam != null && pt === myTeam) continue;
      // §10.0 保护期目标跳过：命中标记/音效一并吞掉（host 吞伤在前的视觉对齐）
      if (pvpProtected(p.id)) continue;
      let hb = null;
      try {
        hb = raycastPlayerParts(n, s, {
          pos: p.pos,
          yaw: p.yaw,
          crouch: p.crouch,
        });
      } catch {}
      if (hb && hb.dist < wallDist && (!best || hb.dist < best.dist))
        best = { p, part: hb.part, h: hb.dist };
    }
    if (!best) return null;
    let head = best.part === "head";
    if (head) {
      // 爆头视觉/听觉变体（§9.1）：part 透传 console 可见 + 复用现有 cue 换参
      try {
        console.info("[pvp] headshot visual hit →", best.p.id);
      } catch {}
      try {
        let a = context.audio;
        a && typeof a.play == "function" && a.play("impact_enemy", { gain: 1, pitch: 1.25 });
      } catch {}
    }
    context.events.emit("player:hitEnemy", {
      part: best.part, // hud 按 pvp+part==="head" 出爆头高亮变体（§9.1）
      weak: head, // 兼容旧 weak 语法（hud 中 headshot 优先级高于 weak）
      killed: !1,
      pvp: !0,
      victim: best.p.id,
    });
    return {
      point: zf.copy(n).addScaledVector(s, best.h).clone(),
      normal: s.clone().negate(),
      dist: best.h,
      surface: "player",
      enemy: null,
      part: best.part,
      dir: s,
      from: "player",
    };
  }

  context.events.on("enemy:killed", (p) => {
    // 击杀归属：本端结算窗口内（killTag 非空）就地标 by，否则留给 host-sim 补
    if (p && p.by === undefined && killTag != null) p.by = killTag;
    let by = p ? p.by : undefined;
    if (by === undefined || by === null) {
      // 单机口径：无人认领即本地击毁（含 audio 演示事件，保持零回归）；联机不冒领
      let n = netApi();
      (!n || n.mode === "offline") && e.kills++;
    } else by === tag() && e.kills++;
  });

  context.events.on("player:hit", (ev) => {
    // §11.1 受击方向黑板（HUD 受击扇形数据源）：pvp 下被命中瞬间把攻击者位姿快照
    // 写 context.pvpLastHitFrom={pos,at}。攻击者解析：fromPos（射击者眼位——host 端
    // 权威结算 applyPlayerDamage 直传 / client 端 cb.hitPlayer.from 经 player.damage
    // 回流）按水平距离就近对齐 remote-players 表内玩家条目取 pos（player:hit 载荷
    // 本体不带 attacker id，且 player.js 的 cb 订阅先于本模块注册、事件在其中同步
    // 派发——跨模块记 id 必滞后一发，几何反查双端一致且无次序依赖）。对不上（坠落
    // 等环境伤 fromPos 缺失 / 攻击者已不在场）→ 跳过不写（HUD 扇形缺省静默）。
    try {
      if (!pvpMode() || !ev) return;
      let f = ev.fromPos;
      if (!f || !isFinite(+f.x) || !isFinite(+f.z)) return;
      let rp = context.remotePlayers || context.remotes;
      if (!rp || typeof rp.list != "function") return;
      let list = rp.list();
      if (!Array.isArray(list)) return;
      let best = null,
        bd = THREAT.matchR;
      for (let p of list) {
        if (!p || !p.pos || p.alive === false) continue;
        let d = Math.hypot(p.pos.x - f.x, p.pos.z - f.z);
        if (d < bd) ((bd = d), (best = p));
      }
      if (!best) return;
      context.pvpLastHitFrom = {
        pos: { x: best.pos.x, y: best.pos.y, z: best.pos.z },
        at: nowMs(),
      };
    } catch {}
  });

  // 客户端统计回流：host 广播的 cb.hitEnemy / ee.killed 按 attacker/by 归属补
  // hits/kills（本端 shots 在 playerShot 已计，命中率才有意义）。
  // 中继不回声房主自身的 fromHost，且此处再按 mode 门一次，双保险防重复计数。
  (function () {
    let n = netApi();
    if (!n || !n.client || typeof n.client.onHostPayload !== "function") return;
    n.client.onHostPayload(function (m) {
      let nn = netApi();
      if (!nn || nn.mode !== "client" || !m) return;
      try {
        let me = tag();
        if (m.k === "cb" && m.e === "hitEnemy" && m.attacker === me) e.hits++;
        else if (m.k === "ee" && m.e === "killed" && m.by === me) e.kills++;
      } catch {}
    });
  })();

  return {
    stats: e,
    reset() {
      e.shots = e.hits = e.kills = 0;
    },
      playerShot(
        n,
        s,
        { damage: o = 28, range: r = 300, impulse: a = 1 } = {},
      ) {
        let m = online();
        e.shots++;
        if (m && m.mode === "client") {
          // 客户端预测：只报不打——本地 tracer 端点用世界射线，绝不扣敌血；
          // 权威命中（着弹/敌伤）经 cb.impact / cb.hitEnemy 回流。
          let w = null;
          try {
            w = context.physics.raycast(n, s, r);
          } catch {}
          try {
            m.client &&
              typeof m.client.send === "function" &&
              m.client.send({
                k: "sh",
                o: [n.x, n.y, n.z],
                d: [s.x, s.y, s.z],
                t: nowMs(),
              });
          } catch {}
          if (pvpMode()) {
            // pvp：远端玩家圆柱命中【纯视觉】优先于墙面止点；sh 上报照旧（§8.2）
            let pv = pvpVisualHit(n, s, r, w);
            if (pv) return pv;
          }
          return w
            ? {
                point: w.point,
                normal: w.normal,
                dist: w.dist,
                surface: w.surface,
                enemy: null,
                dir: s,
                from: "player",
              }
            : null;
        }
        if (m && m.mode === "host") {
          let sm = simApi();
          if (sm && typeof sm.onShot === "function") {
            // 房主即权威端：hitscan / 弱点×2.2 / 射速校验 / 归属 / cb 广播全在
            // host-sim（本地 impact / player:hitEnemy 表现由它回发，HUD/音频免改）。
            let self = tag(),
              f = null;
            killTag = self;
            try {
              f = sm.onShot(self, n, s, nowMs());
            } finally {
              killTag = null;
            }
            if (pvpMode()) {
              // pvp：伤害/击杀已由 host-sim pvp 分支权威结算；本地再做同几何圆柱
              // 测试取视觉止点+命中标记（插值位姿与权威 roster 可能差一拍，视觉从权）
              let pv = pvpVisualHit(n, s, r, null);
              return pv || f;
            }
            return f && f.enemy ? (e.hits++, f) : f;
          }
          // sim 缺席（装配竞态）：落回本地链，房主不哑火
        }
        let l = context.physics.raycast(n, s, r),
          c = context.enemies.raycast(n, s, l ? l.dist : r);
        if (c) {
          e.hits++;
          let u = c.part === "weak" ? 2.2 : 1,
            h = !1;
          killTag = tag();
          try {
            h = c.enemy.damage(o * u, c.point, s, c.part) === !0;
          } finally {
            killTag = null;
          }
          let f = {
            point: c.point,
            normal: c.normal || s.clone().negate(),
            dist: c.dist,
            surface: "enemy",
            enemy: c.enemy,
            part: c.part,
            dir: s,
            from: "player",
            killed: h,
          };
          return (
            context.events.emit("impact", f),
            context.events.emit("player:hitEnemy", {
              enemy: c.enemy,
              part: c.part,
              killed: h,
              weak: c.part === "weak",
            }),
            f
          );
        }
        if (l) {
          let u = {
            point: l.point,
            normal: l.normal,
            dist: l.dist,
            surface: l.surface,
            enemy: null,
            dir: s,
            from: "player",
          };
          return (context.events.emit("impact", u), u);
        }
        return null;
      },
      enemyShot(n, s, { damage: o = 6, range: r = 200 } = {}) {
        let m = online();
        if (m) {
          if (m.mode === "client")
            // 客户端零结算：敌方开火表现走 ee.fire，本端受击抖动/扣血由
            // cb.hitPlayer → player.damage 只走表现半段（权威 hp 随载荷回流）。
            return !1;
          let sm = simApi();
          if (sm && typeof sm.onEnemyFire === "function")
            // 房主权威：对全体玩家圆柱判定 + cb.hitPlayer 广播
            return sm.onEnemyFire(n, s) === !0;
          // sim 缺席：落回单机判定（仅本地玩家），降级不断火力
        }
        let a = context.physics.raycast(n, s, r),
          l = a ? a.dist : r,
          c = context.player;
        if (c && c.alive) {
          let u = nm.copy(c.pos);
          u.y += 1;
          let h = u.sub(n).dot(s);
          if (h > 0 && h < l) {
            zf.copy(n).addScaledVector(s, h);
            let f = Math.abs(zf.y - (c.pos.y + 0.95));
            if (Math.hypot(zf.x - c.pos.x, zf.z - c.pos.z) < 0.38 && f < 0.95)
              return (c.damage(o, n), !0);
          }
        }
        return (
          a &&
            context.events.emit("impact", {
              point: a.point,
              normal: a.normal,
              dist: a.dist,
              surface: a.surface,
              enemy: null,
              dir: s,
              from: "enemy",
            }),
          !1
        );
      },
      explode(n, s = 5, o = 80, r = "player") {
        let m = online();
        if (m) {
          if (m.mode === "client") return; // 零结算零广播：爆点视觉由本地 fx / ee 通道负责
          let sm = simApi();
          if (sm && typeof sm.onExplode === "function") {
            // 房主权威：AoE 对全体玩家（半额+LOS 规则照原版）+ cb 广播
            sm.onExplode(n, s, o, r);
            return;
          }
          // sim 缺席：落回单机链
        }
        for (let l of context.enemies.list) {
          if (!l.alive) continue;
          let c = l.pos.distanceTo(n);
          c < s &&
            context.physics.lineOfSight(
              n,
              nm.copy(l.pos).setY(l.pos.y + 0.5),
            ) &&
            l.damage(
              o * (1 - c / s),
              l.pos,
              zf.copy(l.pos).sub(n).normalize(),
              "body",
            );
        }
        let a = context.player;
        if (a && a.alive) {
          let l = nm
            .copy(a.pos)
            .setY(a.pos.y + 1)
            .distanceTo(n);
          l < s &&
            context.physics.lineOfSight(n, nm.copy(a.pos).setY(a.pos.y + 1)) &&
            a.damage(o * 0.5 * (1 - l / s), n);
        }
      },
    };
}

var nm = new Vector3();

var zf = new Vector3();

export { createCombat };
