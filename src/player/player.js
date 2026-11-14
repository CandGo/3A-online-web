// Player movement, camera, health, recoil and regeneration.
// 多人版（MP-CONTRACT §3 player 行）：联机出生点 slot 偏移；环境类伤害 host 端走
// sim.onPlayerDamage 权威；客户端受击由 cb.hitPlayer 驱动（表现+权威 hp 采信）；
// 阵亡即观战相机（跟随最近存活队友，终局判定归 flow 多人逻辑）；aboard 登船标志。
// 对抗版（MP-PVP §8.2 + §10.2 player 行）：pvp 房间（net.roomMode()==='pvp'）下——
//  - 消费 pvp:respawn 事件：重生倒计时锁输入 → 满血满弹瞬移出生点（不走观战相机）
//  - 延迟回血关闭（regenDelay 段挂 pvp 门，v1 对抗无自愈）
//  - §10.0 重生保护：落地起 prot 秒 invulnerable（内部计时器到期自撤）；
//    开火立即解除（weapon:fire 订阅，发 pvp:protEnd 清黑板）
// 全部改动挂 mpNet()/pvpMode() 门，单机零回归。
import { Euler, Vector3 } from "../vendor/three-r180.js";
import { PLAYER_DIMENSIONS, WORLD_BOUNDS } from "../core/config.js";
import { clamp, damp, lerp, saturate, smoothstep } from "../core/math.js";

var PLAYER_MOVEMENT = {
  walk: 3.8,
  sprint: 6.4,
  crouch: 1.9,
  ads: 2.4,
  accelGround: 34,
  decelGround: 26,
  accelAir: 9,
  gravity: 21,
  jumpApex: 1,
  coyote: 0.12,
  jumpBuffer: 0.13,
  standHeight: PLAYER_DIMENSIONS.height,
  crouchHeight: 1.15,
  eyeRate: 11,
  stride: {
    walk: 1.55,
    sprint: 2.1,
    crouch: 1.05,
  },
  bobY: 0.024,
  bobX: 0.013,
  bobSprint: 1.9,
  bobAds: 0.22,
  rollStrafe: 0.02,
  landDip: 0.36,
  landDipMax: 0.2,
  fovSprint: 6,
  fovAds: 52,
  adsLook: 0.6,
  regenDelay: 4,
  regenRate: 25,
  recoilKeep: 0.35,
  recoilApply: 34,
  recoilRecover: 6.5,
  recoilHold: 0.09,
  shakeDecay: 1.7,
  shakePitch: 0.03,
  shakeYaw: 0.03,
  shakeRoll: 0.045,
  pitchLimit: 1.5,
};

var JUMP_SPEED = Math.sqrt(
  2 * PLAYER_MOVEMENT.gravity * PLAYER_MOVEMENT.jumpApex,
);

function createPlayer(context) {
  let e = context.camera,
    t = () => (context.render && context.render.post) || n,
    n = {},
    s = PLAYER_DIMENSIONS.eye,
    o = PLAYER_MOVEMENT.standHeight,
    r = 0,
    a = 0,
    l = !0,
    c = 0,
    u = 0,
    h = 0,
    f = 0,
    p = 0,
    d = 0,
    v = 0,
    g = {
      x: 0,
      v: 0,
    },
    x = 0,
    y = 0,
    b = 0,
    m = 0,
    A = 0,
    _ = 0,
    M = 0,
    E = 99,
    w = 0,
    S = 0,
    z = 0,
    H = PLAYER_DIMENSIONS.fov,
    O = 0,
    q = "concrete",
    U = new Vector3(),
    T = new Euler(0, 0, 0, "YXZ"),
    D = new Vector3(),
    spPos = new Vector3(),
    spLook = new Vector3(),
    spectateTarget = null,
    pvpRespawn = null, // pvp 重生单 {t,pos:Vector3,yaw,prot}（pvp:respawn 事件驱动）
    pvpProtT = 0, // §10.0 重生保护内部计时器（秒；>0 即 invulnerable，到期/开火自撤）
    C = {
      pos: new Vector3(),
      eye: new Vector3(),
      vel: new Vector3(),
      forward: new Vector3(0, 0, -1),
      yaw: 0,
      pitch: 0,
      health: 100,
      maxHealth: 100,
      alive: !0,
      aboard: !1,
      onGround: !0,
      sprinting: !1,
      crouching: !1,
      ads: 0,
      speed: 0,
      enabled: !0,
      invulnerable: !1,
      baseFov: PLAYER_DIMENSIONS.fov,
      hurtPulse: 0,
      lookScale: 1,
      lastSafe: D,
      tuning: PLAYER_MOVEMENT,
      reset(F, O) {
        let X = F ||
          (context.level && context.level.playerStart) || {
            pos: new Vector3(),
            yaw: 0,
          };
        C.pos.copy(X.pos);
        // 联机出生点 slot 偏移：gate 走廊 x±(slot*2.2)（左右交替展开），yaw 沿用；
        // 单机 slot=0 即原出生点，零回归。pvp 重生传 {noSlotOffset:true}：host 选定
        // 的出生点原位落点（偏移可能推进墙里，MP-PVP §8.0 重生规则）。
        let slot = O && O.noSlotOffset ? 0 : spawnSlot();
        slot > 0 &&
          (C.pos.x += (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2) * 2.2);
        ((C.yaw = X.yaw || 0),
          (C.pitch = 0),
          C.vel.set(0, 0, 0),
          (C.health = C.maxHealth),
          (C.alive = !0),
          (C.aboard = !1),
          (C.onGround = !0),
          (C.sprinting = !1),
          (C.crouching = !1),
          (C.invulnerable = !1),
          (spectateTarget = null),
          (C.speed = 0),
          (s = PLAYER_DIMENSIONS.eye),
          (o = PLAYER_MOVEMENT.standHeight),
          (r = 0),
          (a = 0),
          (l = !0),
          (c = 0),
          (u = 0),
          (h = 0),
          (f = 0),
          (p = d = 0),
          (v = 0),
          (g.x = g.v = 0),
          (x = y = b = m = 0),
          (A = 0),
          (_ = 0),
          (E = 99),
          (w = 0),
          (S = 0),
          (z = 0),
          (C.hurtPulse = 0),
          D.copy(C.pos));
        let ne = t();
        ((ne.damage = 0), (ne.lowHealth = 0), (ne.ads = 0), K(0));
      },
      damage(F, X, opts) {
        // opts.hp：权威 hp（联机 cb.hitPlayer 回流）——直接采信，不再本地扣减。
        // 无 opts 的调用：单机/房主本地结算；客户端环境类（坠落/落水）本地结算后
        // 经 ps 自报（房主只收降幅），敌方命中在客户端不会走到本函数。
        let auth = opts && typeof opts.hp == "number" ? opts.hp : null;
        !C.alive ||
          C.invulnerable ||
          !(F > 0) ||
          ((C.health =
            auth != null
              ? Math.max(0, Math.min(C.maxHealth, auth))
              : Math.max(0, C.health - F)),
          (E = 0),
          (w = Math.min(1, w + 0.35 + F / 40)),
          C.addShake(0.22 + F / 70),
          context.events.emit("player:hit", {
            amount: F,
            fromPos: X,
          }),
          C.health <= 0 &&
            ((C.alive = !1),
            (C.aboard = !1),
            (z = 0),
            (C.sprinting = !1),
            (spectateTarget = null),
            context.events.emit("player:dead", {})));
      },
      heal(F) {
        C.alive && (C.health = Math.min(C.maxHealth, C.health + F));
      },
      pvpRespawnState() {
        // pvp 重生倒计时读数（HUD 重生覆盖层/流程死态判定用）
        return pvpRespawn
          ? { t: pvpRespawn.t, pos: pvpRespawn.pos, yaw: pvpRespawn.yaw }
          : null;
      },
      pvpProtState() {
        // §10.0 重生保护本地读数（HUD「重生保护 X.Xs」主路径；黑板
        // context.pvpProt 为兜底）——host 权威窗口见 host-sim protUntil
        return pvpProtT > 0 ? { left: pvpProtT } : null;
      },
      cancelPvpRespawn() {
        pvpRespawn = null; // 回合终局/重开：未决重生单作废（pvp 流程调用）
      },
      addRecoil(F = 0, X = 0) {
        let ne = PLAYER_MOVEMENT.recoilKeep;
        ((C.pitch = clamp(
          C.pitch + F * ne,
          -PLAYER_MOVEMENT.pitchLimit,
          PLAYER_MOVEMENT.pitchLimit,
        )),
          (C.yaw += X * ne),
          (x += F * (1 - ne)),
          (y += X * (1 - ne)),
          (x = clamp(x, -0.3, 0.3)),
          (y = clamp(y, -0.2, 0.2)),
          (A = PLAYER_MOVEMENT.recoilHold));
      },
      addShake(F = 0.3) {
        _ = Math.min(1, _ + F);
      },
      setFov(F) {
        C.baseFov = clamp(+F || PLAYER_DIMENSIONS.fov, 55, 100);
      },
      update: N,
    };
  context.events.on("explosion", (F) => {
    if (!F || !F.pos) return;
    let X = C.eye.distanceTo(F.pos),
      ne = F.size || 1,
      re = saturate(1 - X / (14 + ne * 10)) * (0.35 + 0.35 * ne);
    re > 0.01 && C.addShake(re);
  });
  // ---- 联机支持面（net 缺席/离线兜底时全部直通，单机零回归）----
  function mpNet() {
    let n = context.net;
    return n && !n.stub && typeof n.mode == "string" && n.mode !== "offline"
      ? n
      : null;
  }
  function mpSim() {
    // host-sim 的 context 键由 runtime 集成定名，多候选容错
    return context.netSim || context.hostSim || context.sim || null;
  }
  function pvpMode() {
    // 对抗房间判定（MP-PVP §8.1）：net.roomMode 缺席（N 通道未就绪/单机）即 false
    let n = mpNet();
    if (!n) return !1;
    try {
      return !!(typeof n.roomMode == "function" && n.roomMode() == "pvp");
    } catch {
      return !1;
    }
  }
  function spawnSlot() {
    // 自己在房间 players() 里的序号（房主首位=0）；单机/异常一律 0
    let n = mpNet();
    if (!n) return 0;
    try {
      let me = typeof n.selfId == "function" ? n.selfId() : null,
        list = typeof n.players == "function" ? n.players() : null;
      if (me == null || !Array.isArray(list)) return 0;
      for (let i = 0; i < list.length; i++)
        if (list[i] && list[i].id === me) return i;
      return 0;
    } catch {
      return 0;
    }
  }
  function envDamage(amount, kind) {
    // 环境类伤害（坠落/落水自伤）：host 端交 sim.onPlayerDamage 权威结算（host-sim
    // 回调本地 damage 并向队友端广播 cb.hitPlayer）；client/单机本地结算，
    // 客户端随后经 ps 自报 hp（房主只收降幅）。
    if (!(amount > 0)) return;
    let n = mpNet();
    if (n && n.mode === "host") {
      let sm = mpSim(),
        id = null;
      try {
        id = n.selfId();
      } catch {}
      if (sm && typeof sm.onPlayerDamage == "function" && id != null) {
        sm.onPlayerDamage(id, amount, kind);
        return;
      }
    }
    C.damage(amount, null);
  }
  function spectateMates() {
    // 候选名单源：优先远端化身 API（context.remotePlayers.list）；兜底统一视图
    // context.netPlayers()（含本端条目，本端已阵亡会被存活过滤自然剔除）。
    let rp = context.remotePlayers || context.remotes || null;
    if (rp && typeof rp.list == "function") {
      try {
        return rp.list();
      } catch {
        return [];
      }
    }
    if (typeof context.netPlayers == "function") {
      try {
        return context.netPlayers() || [];
      } catch {
        return [];
      }
    }
    return [];
  }
  function spectateCam(F) {
    // 联机观战：跟随最近存活队友——机位=队友身后 3m/高 2m，注视队友躯干；
    // 无存活队友则原地升 8m 俯瞰（three 的 lookAt 对平行 up 向量自带兜底）。
    let best = null,
      bd = 1e9;
    for (let mate of spectateMates()) {
      if (!mate || mate.alive === !1 || !mate.pos || mate.you) continue;
      let dx = mate.pos.x - C.pos.x,
        dz = mate.pos.z - C.pos.z,
        d2 = dx * dx + dz * dz;
      d2 < bd && ((bd = d2), (best = mate));
    }
    let k = Math.max(F, 1e-4);
    if (best) {
      // forward=(0,0,-1) 绕 Y 旋 yaw（与本文件 K() 的推导一致）
      spectateTarget = best.id;
      spPos.set(
        best.pos.x + Math.sin(best.yaw || 0) * 3,
        best.pos.y + 2,
        best.pos.z + Math.cos(best.yaw || 0) * 3,
      );
      e.position.lerp(spPos, 1 - Math.exp(-12 * k));
      e.lookAt(spLook.set(best.pos.x, best.pos.y + 1.3, best.pos.z));
    } else {
      spectateTarget = null;
      spPos.set(C.pos.x, C.pos.y + 8, C.pos.z);
      e.position.lerp(spPos, 1 - Math.exp(-4 * k));
      e.lookAt(spLook.set(C.pos.x, C.pos.y + 0.5, C.pos.z));
    }
  }
  (function () {
    // 客户端权威受击回流：cb.hitPlayer（带权威 hp）只走表现+采信快照；
    // cb.playerDead 兜底强制倒地。中继不回声房主自身的 fromHost，再按 mode 门一次。
    let n = context.net;
    if (!n || n.stub || !n.client || typeof n.client.onHostPayload != "function")
      return;
    n.client.onHostPayload(function (m) {
      try {
        if (!m || m.k !== "cb") return;
        let nn = mpNet();
        if (!nn || nn.mode !== "client") return;
        let me = nn.selfId();
        if (m.e === "hitPlayer" && m.id === me) {
          let f = Array.isArray(m.from)
            ? { x: m.from[0], y: m.from[1], z: m.from[2] }
            : null;
          C.damage(+m.amount > 0 ? +m.amount : 0.01, f, { hp: m.hp });
        } else if (m.e === "playerDead" && m.id === me && C.alive)
          C.damage(1, null, { hp: 0 });
      } catch {}
    });
  })();
  (function () {
    // pvp 重生消费（MP-PVP §8.2 player 行）：pvp:respawn 事件——host 端由 host-sim
    // 本地 emit、client 端由 pvp 流程从 fromHost 载荷翻译（两端事件语义一致）。
    // 阵亡态收单 → 倒计时（pvpRespawnStep 每帧推进）→ 满血满弹瞬移出生点。
    context.events.on("pvp:respawn", function (ev) {
      try {
        if (!ev || !pvpMode() || C.alive) return;
        let me = null,
          nn = mpNet();
        try {
          me = nn && typeof nn.selfId == "function" ? nn.selfId() : null;
        } catch {}
        if (ev.id == null || (me != null && ev.id !== me)) return;
        let P = ev.pos;
        if (Array.isArray(P))
          P = { x: +P[0] || 0, y: +P[1] || 0, z: +P[2] || 0 };
        if (!P || !isFinite(+P.x) || !isFinite(+P.z)) return;
        pvpRespawn = {
          t: Math.max(0.2, +ev.in > 0 ? +ev.in : 3),
          pos: new Vector3(+P.x, +P.y || 0, +P.z),
          yaw: +ev.yaw || 0,
          // §10.1 载荷 prot（保护秒数）：旧主机缺字段退 3s（与 host-sim PVP.protSeconds 同值）
          prot: +ev.prot > 0 ? +ev.prot : 3,
        };
      } catch {}
    });
  })();
  (function () {
    // §10.0 开火立即解除重生保护（CF 语义，防蹲点滥用）：仅 pvp 且本人保护期内——
    // 本地即刻撤 invulnerable（不等 host 往返），并发 protEnd 本地事件（pvp 流程
    // 据此清黑板；host 端 sim.onShot 的 protEnd 广播为幂等双保险）
    context.events.on("weapon:fire", function () {
      try {
        if (!pvpMode() || !C.alive || pvpProtT <= 0 || !C.invulnerable) return;
        ((pvpProtT = 0), (C.invulnerable = !1));
        let n = mpNet(),
          id = null;
        try {
          id = n && typeof n.selfId == "function" ? n.selfId() : null;
        } catch {}
        context.events.emit("pvp:protEnd", { id: id, self: !0 });
      } catch {}
    });
  })();
  function pvpRespawnStep(F) {
    // 重生倒计时推进（仅 dead 支调用）；到点 reset 满血+武器满弹并广播复活
    if (!pvpRespawn) return;
    pvpRespawn.t -= F;
    if (pvpRespawn.t > 0) return;
    let R = pvpRespawn;
    pvpRespawn = null;
    C.reset({ pos: R.pos, yaw: R.yaw }, { noSlotOffset: !0 });
    // §10.0 重生保护：落地起 prot 秒 invulnerable（内部计时器到期自撤——见 N()；
    // 开火提前解除见 weapon:fire 订阅）。与 host 权威窗口同口径（派单 in+prot）
    if (pvpMode() && R.prot > 0) {
      pvpProtT = R.prot;
      C.invulnerable = !0;
    }
    try {
      let w = context.weapon;
      w && typeof w.reset == "function" && w.reset();
    } catch {}
    context.events.emit("player:respawned", { pos: R.pos });
  }
  function G() {
    let F = context.physics && context.physics.boxes;
    if (!F) return !0;
    let X = PLAYER_DIMENSIONS.radius * 0.9,
      ne = C.pos.y + PLAYER_MOVEMENT.crouchHeight - 0.05,
      re = C.pos.y + PLAYER_MOVEMENT.standHeight;
    for (let $ = 0; $ < F.length; $++) {
      let ue = F[$];
      if (
        !ue.bulletOnly &&
        !(
          C.pos.x + X < ue.min.x ||
          C.pos.x - X > ue.max.x ||
          C.pos.z + X < ue.min.z ||
          C.pos.z - X > ue.max.z
        ) &&
        ue.min.y < re &&
        ue.max.y > ne
      )
        return !1;
    }
    return !0;
  }
  function j() {
    let F = C.pos.x,
      X = C.pos.z;
    try {
      if (
        context.ground &&
        context.ground.isPuddle &&
        C.pos.y < 0.05 &&
        context.ground.isPuddle(F, X)
      )
        return "water";
    } catch {}
    if (q && q !== "concrete") return q;
    try {
      return (
        (context.level &&
          context.level.groundSurfaceAt &&
          context.level.groundSurfaceAt(F, X)) ||
        q ||
        "concrete"
      );
    } catch {
      return q || "concrete";
    }
  }
  function N(F) {
    let X = context.input,
      ne = context.weapon || {};
    if (
      (ne.stub || typeof ne.ads != "number"
        ? ((O = damp(O, C.enabled && X.ads ? 1 : 0, 14, F)), (C.ads = O))
        : (C.ads = saturate(ne.ads)),
      !C.alive)
    ) {
      (z += F), Q(F), pvpRespawnStep(F);
      // 联机阵亡即观战：spectateCam 独占相机（K 的死亡镜头每帧回写会吃掉跟随
      // 插值）；单机保持原死亡镜头。终局/重开判定归 flow 多人逻辑。
      // pvp：原死亡镜头照用（§8.0 阵亡视角）——FFA 无队友，跟机观战等于透视。
      mpNet() && !pvpMode() ? spectateCam(F) : K(F);
      ie(F);
      return;
    }
    // §10.0 重生保护计时：到期自撤 invulnerable（内部计时器驱动，与黑板
    // context.pvpProt.until 同周期；开火路径不经过这里——weapon:fire 订阅即时撤）
    pvpProtT > 0 &&
      ((pvpProtT -= F),
      pvpProtT <= 0 && ((pvpProtT = 0), (C.invulnerable = !1)));
    let re = C.enabled;
    ((C.lookScale = lerp(1, PLAYER_MOVEMENT.adsLook, C.ads)),
      re &&
        ((C.yaw -= X.look.dx * C.lookScale),
        (C.pitch = clamp(
          C.pitch - X.look.dy * C.lookScale,
          -PLAYER_MOVEMENT.pitchLimit,
          PLAYER_MOVEMENT.pitchLimit,
        )),
        (C.yaw > Math.PI * 4 || C.yaw < -Math.PI * 4) &&
          (C.yaw = C.yaw % (Math.PI * 2))),
      re && X.crouch
        ? (C.crouching = !0)
        : C.crouching && G() && (C.crouching = !1),
      (o = C.crouching
        ? PLAYER_MOVEMENT.crouchHeight
        : PLAYER_MOVEMENT.standHeight));
    let ue = re ? X.move.x : 0,
      me = re ? X.move.y : 0,
      ee = ue * ue + me * me > 0.01,
      B =
        re &&
        X.sprint &&
        me > 0.55 &&
        Math.abs(ue) < 0.6 &&
        !C.crouching &&
        C.ads < 0.35 &&
        !X.fire;
    C.sprinting =
      (B && C.onGround && C.speed > PLAYER_MOVEMENT.walk * 0.6) ||
      (B && !C.onGround && C.sprinting);
    let P = PLAYER_MOVEMENT.walk;
    (C.crouching
      ? (P = PLAYER_MOVEMENT.crouch)
      : B && (P = PLAYER_MOVEMENT.sprint),
      (P = lerp(P, Math.min(P, PLAYER_MOVEMENT.ads), C.ads)),
      me < 0 && (P *= lerp(1, 0.82, -me)));
    let V = Math.sin(C.yaw),
      Y = Math.cos(C.yaw);
    U.set(ue * Y - me * V, 0, -ue * V - me * Y).multiplyScalar(P);
    let L = C.onGround
        ? ee
          ? PLAYER_MOVEMENT.accelGround
          : PLAYER_MOVEMENT.decelGround
        : ee
          ? PLAYER_MOVEMENT.accelAir
          : 0.6,
      Z = U.x - C.vel.x,
      J = U.z - C.vel.z;
    !C.onGround && !ee && ((Z = -C.vel.x), (J = -C.vel.z));
    let oe = Math.hypot(Z, J),
      fe = L * F;
    (oe <= fe || oe < 1e-6
      ? (C.onGround || ee) && ((C.vel.x = U.x), (C.vel.z = U.z))
      : ((C.vel.x += (Z / oe) * fe), (C.vel.z += (J / oe) * fe)),
      (r = C.onGround ? PLAYER_MOVEMENT.coyote : Math.max(0, r - F)),
      (a =
        re && X.pressed("jump")
          ? PLAYER_MOVEMENT.jumpBuffer
          : Math.max(0, a - F)),
      a > 0 &&
        r > 0 &&
        (!C.crouching || G()) &&
        ((C.vel.y = JUMP_SPEED),
        (a = 0),
        (r = 0),
        (C.onGround = !1),
        (C.crouching = !1),
        (o = PLAYER_MOVEMENT.standHeight),
        context.events.emit("player:jump", {
          pos: C.pos,
        })),
      (C.vel.y -= PLAYER_MOVEMENT.gravity * F * 0.5),
      C.vel.y < -40 && (C.vel.y = -40));
    let le = C.vel.y,
      R =
        context.physics.moveCapsule(
          C.pos,
          C.vel,
          F,
          PLAYER_DIMENSIONS.radius,
          o,
          l,
        ) || {};
    R.onGround || (C.vel.y -= PLAYER_MOVEMENT.gravity * F * 0.5);
    let I = context.physics.bounds;
    if (
      (I &&
        ((C.pos.x = clamp(C.pos.x, I.min.x + 0.4, I.max.x - 0.4)),
        (C.pos.z = clamp(C.pos.z, I.min.z + 0.4, I.max.z - 0.4))),
      (C.onGround = !!R.onGround),
      R.surface && (q = R.surface),
      C.onGround)
    ) {
      if (!l && c > 0.12) {
        let ce = Math.max(0, -le, u);
        ((g.v -= Math.min(ce * PLAYER_MOVEMENT.landDip, 3.2)),
          ce > 7.5 && C.addShake(Math.min(0.5, (ce - 7.5) * 0.06)),
          context.events.emit("player:land", {
            speed: ce,
            surface: j(),
            pos: C.pos,
          }),
          ce > 13 && envDamage((ce - 13) * 7, "fall"),
          (h = 0.35));
      }
      ((c = 0),
        (u = 0),
        C.pos.x <= WORLD_BOUNDS.quayX - 1.2 && C.pos.y > -0.5 && D.copy(C.pos));
    } else ((c += F), (u = Math.max(u, -C.vel.y)));
    ((l = C.onGround),
      C.pos.y < WORLD_BOUNDS.seaY - 2.2 &&
        (C.pos.copy(D),
        C.vel.set(0, 0, 0),
        (C.onGround = !0),
        (l = !0),
        (_ = 0.6),
        (C.yaw += Math.PI),
        envDamage(12, "water"),
        context.events.emit("player:rescued", {})),
      (C.speed = Math.hypot(C.vel.x, C.vel.z)));
    let se = C.crouching
      ? PLAYER_MOVEMENT.stride.crouch
      : C.sprinting
        ? PLAYER_MOVEMENT.stride.sprint
        : PLAYER_MOVEMENT.stride.walk;
    if (C.onGround && C.speed > 0.5) {
      let ce = h;
      ((h += (C.speed * F) / se),
        Math.floor(h) > Math.floor(ce) &&
          context.events.emit("player:step", {
            surface: j(),
            sprint: C.sprinting,
            pos: C.pos,
          }));
    } else C.onGround && (h = damp(h, Math.round(h), 8, F));
    let ae = C.onGround
      ? saturate(C.speed / PLAYER_MOVEMENT.walk) *
        (C.sprinting ? PLAYER_MOVEMENT.bobSprint : 1) *
        lerp(1, PLAYER_MOVEMENT.bobAds, C.ads) *
        (C.crouching ? 0.7 : 1)
      : 0;
    ((f = damp(f, ae, 9, F)),
      (d = -Math.cos(h * Math.PI * 2) * PLAYER_MOVEMENT.bobY * f),
      (p = Math.sin(h * Math.PI) * PLAYER_MOVEMENT.bobX * f));
    let k = C.vel.x * Y - C.vel.z * V;
    ((v = damp(
      v,
      (-k / PLAYER_MOVEMENT.sprint) *
        PLAYER_MOVEMENT.rollStrafe *
        lerp(1, 0.4, C.ads),
      8,
      F,
    )),
      (E += F),
      !pvpMode() && // 对抗禁延迟回血（MP-PVP §8.2：v1 无自愈，伤害只能靠重生复位）
      E > PLAYER_MOVEMENT.regenDelay &&
        C.health < C.maxHealth &&
        (C.health = Math.min(
          C.maxHealth,
          C.health + PLAYER_MOVEMENT.regenRate * F,
        )),
      K(F),
      ie(F));
  }
  function Q(F) {
    ((C.vel.x = damp(C.vel.x, 0, 5, F)),
      (C.vel.z = damp(C.vel.z, 0, 5, F)),
      (C.vel.y -= PLAYER_MOVEMENT.gravity * F));
    try {
      let X = context.physics.moveCapsule(
        C.pos,
        C.vel,
        F,
        PLAYER_DIMENSIONS.radius,
        0.6,
        l,
      );
      l = !!(X && X.onGround);
    } catch {}
    (C.pos.y < WORLD_BOUNDS.seaY - 1 &&
      ((C.pos.y = WORLD_BOUNDS.seaY - 1), (C.vel.y = 0)),
      (C.speed = 0),
      (C.sprinting = !1),
      (f = damp(f, 0, 10, F)),
      (p *= 0.9),
      (d *= 0.9));
  }
  function K(F) {
    let X = C.crouching ? PLAYER_DIMENSIONS.crouchEye : PLAYER_DIMENSIONS.eye,
      ne = 0,
      re = 0;
    if (C.alive) F > 0 ? (s = damp(s, X, PLAYER_MOVEMENT.eyeRate, F)) : (s = X);
    else {
      let Z = smoothstep(0, 0.85, z),
        J = Z * Z;
      ((X = lerp(PLAYER_DIMENSIONS.eye, 0.22, J)),
        (s = damp(s, X, 18, F)),
        (ne = 1.15 * J),
        (re = -0.25 * Z + 0.12 * Math.sin(Z * Math.PI)));
    }
    if (F > 0) {
      let Z = -g.x * 150 - g.v * 17;
      ((g.v += Z * F),
        (g.x += g.v * F),
        (g.x = clamp(g.x, -PLAYER_MOVEMENT.landDipMax, 0.05)),
        (A -= F),
        A <= 0 &&
          ((x = damp(x, 0, PLAYER_MOVEMENT.recoilRecover, F)),
          (y = damp(y, 0, PLAYER_MOVEMENT.recoilRecover, F))),
        (b = damp(b, x, PLAYER_MOVEMENT.recoilApply, F)),
        (m = damp(m, y, PLAYER_MOVEMENT.recoilApply, F)),
        (_ = Math.max(0, _ - PLAYER_MOVEMENT.shakeDecay * F)),
        (M += F));
    }
    let $ = Math.sin(C.yaw),
      ue = Math.cos(C.yaw);
    C.eye.set(C.pos.x + p * ue, C.pos.y + s + d + g.x, C.pos.z - p * $);
    let me = clamp(C.pitch + b, -1.55, 1.55),
      ee = C.yaw + m;
    (T.set(me, ee, 0, "YXZ"), C.forward.set(0, 0, -1).applyEuler(T));
    let B = _ * _,
      P = M,
      V =
        B *
        PLAYER_MOVEMENT.shakePitch *
        (Math.sin(P * 43.1) + 0.6 * Math.sin(P * 71.7 + 1.3)),
      Y =
        B *
        PLAYER_MOVEMENT.shakeYaw *
        (Math.sin(P * 37.3 + 2.1) + 0.6 * Math.sin(P * 83.9)),
      L =
        B *
        PLAYER_MOVEMENT.shakeRoll *
        (Math.sin(P * 29.7 + 0.7) + 0.5 * Math.sin(P * 61.3 + 4));
    if (
      (e.position.copy(C.eye),
      e.rotation.set(
        me + V + re + g.x * 0.12,
        ee + Y,
        v + L + ne + p * 0.35,
        "YXZ",
      ),
      !context.params || !context.params.fov)
    ) {
      let Z = lerp(
        C.baseFov + (C.sprinting ? PLAYER_MOVEMENT.fovSprint : 0),
        PLAYER_MOVEMENT.fovAds,
        C.ads,
      );
      ((H = F > 0 ? damp(H, Z, C.ads > 0.02 && C.ads < 0.98 ? 30 : 7, F) : Z),
        Math.abs(e.fov - H) > 0.01 &&
          ((e.fov = H), e.updateProjectionMatrix()));
    }
  }
  function ie(F) {
    ((w = Math.max(0, w - F * 1.9)), (C.hurtPulse = w));
    let X = C.alive ? smoothstep(0.55, 0.12, C.health / C.maxHealth) : 1;
    S = damp(S, X, 4, F);
    let ne = t();
    ((ne.damage = w), (ne.lowHealth = S), (ne.ads = C.ads));
  }
  return C;
}

export { createPlayer, PLAYER_MOVEMENT, JUMP_SPEED };
