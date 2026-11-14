// PvP FFA 对抗流程（MP-PVP §8.2 pvp.js 行）：createPvpFlow 与 createGameFlow 同外壳。
// 装配：runtime 在房间 mode==='pvp' 时以本流程替代 createGameFlow（其余装配不变）。
//
// 状态机：title → countdown(3s，屏显 3-2-1 开战) → playing ⇄ dead(重生倒计时，死亡
// 相机锁输入) → roundend(结算；对抗为一局制，结算后退出房间，不重开任务)。
// 无中继/波次/撤离/敌 spawn 代码；pause 联机降级为纯本地覆盖（R1 同款，绝不切
// game:state）。房主 update 里跑 round 计时与 score 心跳——权威计算全部经 host-sim
// 的 sim.pvp() 子对象（startRound/startPlay/tick），本文件只驱动与消费。
//
// 事件约定（两端同名单事件，各端单次）：
//  - host 端：host-sim 权威决策本地 emit（pvp:score / pvp:killed / pvp:respawn /
//    pvp:roundEnd / pvp:enemyFire[§11.1 开火暴露]），同时广播 {k:"pvp",...} 载荷；
//  - client 端：本文件把 fromHost 的 pvp 载荷翻译成同名事件再 emit（翻译层惯例与
//    flow.js 的 ob→objective:* 相同；net 入站本体绝不进 context.events）。
//  - player.js 消费 pvp:respawn（倒计时→满血满弹瞬移）；hud/_menus 消费 pvp:score/
//    killed/roundEnd/countdown（计分板/killfeed/结算屏/倒计时覆盖层）；hud 消费
//    pvp:enemyFire（§11.1 罗盘红色威胁标记：方位+距离+1.8s 渐隐，敌队过滤按 team
//    做）+ 黑板 context.pvpLastFire 兜底（本文件写入，存最近一发）。
import { Vector3 } from "../vendor/three-r180.js";
import { clamp, damp, smoothstep } from "../core/math.js";
import { createMenus } from "../ui/menus.js";
import { PVP_TEAM_SPAWNS } from "../net/host-sim.js"; // §10 队伍出生点常量（纯数据，双端同源）

var PVP_FLOW = {
  countdownSeconds: 3, // 开局倒计时（屏显 3-2-1 开战）
  killLimit: 20, // §10.0 团队死斗：队伍总分先到 20 杀（与 host-sim PVP.teamKillLimit 同源同值）
  respawnSeconds: 3, // 阵亡重生倒计时（host-sim 排程，载荷 in 字段）
  protSeconds: 3, // §10.0 重生保护秒数（载荷 prot 字段；开火立即解除，CF 语义）
  titleSpeed: 1.15, // 标题巡航运镜（flow.js GAME_FLOW 同参）
  titleFov: 50,
  threatRadius: 26, // 交火强度提示半径（有敌近距离即拉高音频强度）
};

var RADIO = {
  open: "交火区已开放。红蓝对垒，队伍先达二十杀，或撑满五分钟。祝好运。",
  kill: "目标倒地",
  limit: "杀伤数达标 — 行动结束，收队。",
};

function createPvpFlow(context, deps) {
  deps = deps || {};
  let e = (context.render && context.render.post) || {},
    t = typeof e.saturation == "number" ? e.saturation : 1,
    n = context.player,
    s = context.level,
    o = context.hud,
    r = context.input,
    a = (P, V, ...Y) => {
      try {
        if (P && typeof P[V] == "function") return P[V](...Y);
      } catch (L) {
        console.error(`[pvp] ${V} threw`, L);
      }
    },
    l =
      deps.menus ||
      createMenus(context, {
        deploy() {
          // 对抗仅联机可玩（§8.0）：单机开始行动在本流程下不开本地局
          let net = netApi();
          if (!online())
            return o.message && o.message("对抗模式仅联机可玩 — 先创建或加入房间", 3.5);
          if (net && net.isHost && net.isHost())
            (a(context.audio, "resume"), net.startGame({}));
          else o.message && o.message("等待房主开始行动", 3);
        },
        host(opts) {
          // 本流程内建房默认对抗房（§8.1 createRoom 携带 mode；menus 若传 {mode} 则从之）
          let net = netApi();
          if (!net || typeof net.createRoom != "function")
            return o.message && o.message("联机模块未就绪", 3);
          let mode = (opts && opts.mode) || "pvp";
          (a(context.audio, "resume"),
            net
              .createRoom(mpPlayerName(), { mode })
              .catch((err) => {
                o.message &&
                  o.message((err && err.message) || "创建房间失败", 3.5);
              }));
        },
        join(code) {
          // menus confirmJoin 直接传 4 位房间码字符串（I5 同款）
          let net = netApi();
          if (!net || typeof net.joinRoom != "function")
            return o.message && o.message("联机模块未就绪", 3);
          (a(context.audio, "resume"),
            net.joinRoom(code, mpPlayerName()).catch((err) => {
              o.message &&
                o.message((err && err.message) || "加入房间失败", 3.5);
            }));
        },
        mpStart() {
          let net = netApi();
          if (!online() || !net || !(net.isHost && net.isHost())) return;
          (a(context.audio, "resume"), net.startGame({}));
        },
        mpLeave() {
          let net = netApi();
          net && net.disconnect && net.disconnect("离开房间");
          mpResetToTitle();
        },
        mpLobby() {
          let net = netApi();
          if (!online() || !net || typeof net.returnLobby !== "function")
            return o.message && o.message("联机服务不可用", 3);
          if (net.isHost && net.isHost()) {
            net.returnLobby();
          } else {
            o.message && o.message("等待房主返回房间", 3);
          }
        },
        resume() {
          j(!0);
        },
        restart() {
          mpRestartAction({ quick: !0 });
        },
        retry() {
          mpRestartAction({ quick: !0 });
        },
        redeploy() {
          mpRestartAction({ quick: !0 });
        },
      });
  l.applySettings();
  let c = {
      time: 0,
      retries: 0,
      board: [],
      timeUp: !1,
      intensity: 0.15,
      teamResult: null, // §10.1 团队结算 {blueKills,redKills,winner}（roundEnd 驱动）
    },
    u = 0,
    h = PVP_FLOW.countdownSeconds,
    d = 0,
    g = !1,
    x = "",
    y = 0.8,
    b = new Vector3(),
    m = new Vector3(),
    cdShown = 0, // countdown 已屏显的秒数
    roundShown = !1, // roundend 结算屏已出
    roundPlayBegun = !1, // 本回合 playing 已开（timeBase/startPlay 只做一次）
    protPending = 0, // §10.0 本人下一落地的保护秒数（pvp:respawn 记，落地转黑板）
    _ = {
      state: "title",
      flow: PVP_FLOW,
      run: c,
      menus: l,
      start(P = {}) {
        U({ mp: !0, quick: !!P.quick });
      },
      pause() {
        G();
      },
      resume() {
        j(!1);
      },
      update: B,
      applySettings() {
        try {
          l.applySettings && l.applySettings();
        } catch {}
      },
      debugCut() {
        return; // 对抗无切割目标；联机作弊后门一律封死（R5 同款）
      },
    };
  // ===== 多人对抗挂钩（铁律：对抗必联机；合作/单机不走本流程零回归）=====
  let mpRun = !1, // 本局由房间驱动（net start/restart 置位）
    mpHost = !1, // 本局是否房主权威端（net.isHost 快照）
    mpDone = !1, // roundEnd 已触发（结算屏只出一次）
    mpTimeBase = 0, // playing 起点的 roomTime 偏移
    mpBound = !1, // net 事件只绑一次
    protMap = {}; // §10.0 全员保护窗（id→到期 ms；combat.pvpVisualHit 跳保护目标的数据源）

  function netApi() {
    let net = context.net;
    return net && !net.stub && typeof net.on == "function" ? net : null;
  }
  function online() {
    let net = netApi();
    return !!(net && net.mode !== "offline");
  }
  function myId() {
    let net = netApi();
    try {
      return net && net.selfId ? net.selfId() : null;
    } catch {
      return null;
    }
  }
  function nowMs() {
    return typeof performance != "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }
  function myTeam() {
    // §10.1 我的队伍号（0=蓝 1=红；HUD/UI 敌我配色数据源）：net.myTeam 优先，
    // 计分板 team 字段次之，net.players 序位奇偶兜底（§10.0 加入序 0,2→蓝 1,3→红）
    let net = netApi();
    try {
      if (net && typeof net.myTeam == "function") {
        let t = net.myTeam();
        if (t === 0 || t === 1) return t;
      }
    } catch {}
    let me = myId(),
      b = context.pvpBoard;
    if (Array.isArray(b))
      for (let k of b)
        if (k && k.id === me && (k.team === 0 || k.team === 1)) return k.team;
    try {
      let list = net && typeof net.players == "function" ? net.players() : null;
      if (me != null && Array.isArray(list))
        for (let i = 0; i < list.length; i++)
          if (list[i] && list[i].id === me) return i % 2;
    } catch {}
    return null;
  }
  function simPvpApi() {
    // host-sim 的 pvp 导出面（context 键多候选容错，与 combat/player 同款）
    try {
      let sm = context.hostSim || context.netSim || context.sim;
      return sm && typeof sm.pvp == "function" ? sm.pvp() : null;
    } catch {
      return null;
    }
  }
  function hostTick(P) {
    // 房主回合节拍：countdown/playing/dead 全都要跑（重生队列与 score 心跳不停摆）
    if (!mpRun || !mpHost) return;
    let pv = simPvpApi();
    try {
      pv && typeof pv.tick == "function" && pv.tick(P);
    } catch (L) {
      console.error("[pvp] hostTick threw", L);
    }
  }
  function mpPlayerName() {
    try {
      let v = localStorage.getItem("saltline.mp.name");
      return v && v.trim() ? v.trim().slice(0, 24) : undefined;
    } catch {
      return undefined;
    }
  }
  function mpRestartAction(opts) {
    // 对抗是一局制：始终禁止“重开任务/再来一局”，避免房主单方面重置整房。
    if (mpRun) {
      o.message && o.message("对抗模式不支持重开任务", 3);
      return false;
    }
    let net = netApi();
    if (online()) {
      if (net && net.isHost && net.isHost()) {
        (a(context.audio, "resume"), net.restartGame(opts || { quick: !0 }));
        return;
      }
      o.message && o.message("等待房主再来一局", 3);
      return;
    }
    o.message && o.message("对抗模式仅联机可玩", 3);
  }
  function mpOnHostPayload(p) {
    // client 端：fromHost 的 pvp 载荷 → 同名本地事件（host 端由 host-sim 本地
    // emit，回声不翻译防双发；翻译层惯例与 flow.js ob→objective:* 一致）
    try {
      if (!p || typeof p != "object" || p.k !== "pvp") return;
      if (!mpRun || mpHost) return;
      if (p.e === "score")
        context.events.emit("pvp:score", { board: p.board || [] });
      else if (p.e === "teamscore")
        // §10.1 队伍比分（顶部计分条主数据源）：与 host-sim emitLocal 车道同字段名
        context.events.emit("pvp:teamscore", {
          blue: +p.blue || 0,
          red: +p.red || 0,
        });
      else if (p.e === "killed")
        // §9.1 headshot:bool 透传——与 host-sim emitLocal 车道同字段名（两端一致，
        // hud killfeed/menus 死亡屏不再依赖原始载荷直读兜底）
        context.events.emit("pvp:killed", {
          by: p.by == null ? null : p.by,
          victim: p.victim,
          headshot: p.headshot === true,
        });
      else if (p.e === "respawn") {
        let P = p.pos;
        context.events.emit("pvp:respawn", {
          id: p.id,
          pos: Array.isArray(P)
            ? { x: +P[0] || 0, y: +P[1] || 0, z: +P[2] || 0 }
            : P,
          yaw: +p.yaw || 0,
          in: +p.in > 0 ? +p.in : PVP_FLOW.respawnSeconds,
          prot: +p.prot > 0 ? +p.prot : PVP_FLOW.protSeconds,
        });
      } else if (p.e === "protEnd")
        // §10.0 开火解除保护（host 广播；本地 player.js 已先行预测，此处幂等收口）
        context.events.emit("pvp:protEnd", { id: p.id });
      else if (p.e === "fire")
        // §11.1 敌方开火暴露：host 权威处理 sh 时广播（每射 4/s 限频）→ 翻译为本地
        // 事件 pvp:enemyFire{id,pos}（host 端由 host-sim emitLocal 同名——中继不回声
        // 房主自身广播，两端各单次）；敌队过滤在 HUD 侧按 team 做，此处只翻译不筛
        context.events.emit("pvp:enemyFire", {
          id: p.id,
          pos: Array.isArray(p.pos)
            ? { x: +p.pos[0] || 0, y: +p.pos[1] || 0, z: +p.pos[2] || 0 }
            : p.pos,
        });
      else if (p.e === "roundEnd")
        context.events.emit("pvp:roundEnd", {
          board: p.board || [],
          timeUp: !!p.timeUp,
          blueKills: +p.blueKills || 0, // §10.1 团队结算（分高者胜/平局）
          redKills: +p.redKills || 0,
          winner: p.winner === "blue" || p.winner === "red" || p.winner === "draw" ? p.winner : null,
        });
    } catch (L) {
      console.error("[pvp] mpOnHostPayload threw", L);
    }
  }
  function mpResetToTitle() {
    // 房间终局复位：主动离开/房主已离开/线路中断——本局作废回标题
    ((mpRun = !1),
      (mpHost = !1),
      (n.enabled = !1),
      r.setGameplay && r.setGameplay(!1),
      r.exitLock(),
      o.show(!1),
      o.setPrompt && o.setPrompt(null),
      n.cancelPvpRespawn && n.cancelPvpRespawn(),
      a(context.weapon, "setVisible", !1),
      a(context.audio, "setIntensity", 0.15),
      a(context.audio, "setPaused", !1),
      _.state !== "title" && M("title"),
      l.show("title"));
  }
  function mpReturnToLobby() {
    // 结算后回到原房间大厅：保留连接、房间码和成员，不重建房间。
    if (!mpRun) return;
    H();
    ((mpRun = !1),
      (mpHost = !1),
      (n.enabled = !1),
      r.setGameplay && r.setGameplay(!1),
      r.exitLock(),
      o.show(!1),
      o.setPrompt && o.setPrompt(null),
      a(context.weapon, "setVisible", !1),
      a(context.audio, "setIntensity", 0.15),
      a(context.audio, "setPaused", !1),
      _.state !== "title" && M("title"),
      l.locationCard && l.locationCard(!1),
      l.show("lobby"));
  }
  function mpBindNet() {
    if (mpBound) return;
    let net = netApi();
    if (!net) return;
    mpBound = !0;
    net.on("start", () => U({ mp: !0 }));
    // 对抗是一局制：结算后不接受 restart/redeploy 信号，避免任何入口
    // 把已经结束的团队死斗重新初始化。合作流程仍保留自己的重开链路。
    net.on("restart", () => {
      if (mpRun)
        o.message && o.message("对抗模式不支持重开任务", 3);
    });
    net.on("lobby", () => {
      mpRun && mpReturnToLobby();
    });
    net.on("hostGone", () => {
      mpRun && !mpHost && mpResetToTitle();
    });
    net.on("error", (ev) => {
      mpRun &&
        !mpHost &&
        ev &&
        ev.code === "DISCONNECT" &&
        mpResetToTitle();
    });
    if (net.client && typeof net.client.onHostPayload == "function")
      net.client.onHostPayload(mpOnHostPayload);
  }
  function M(P) {
    let V = _.state;
    P !== V &&
      ((_.state = P),
      (u = 0),
      context.events.emit("game:state", {
        state: P,
        prev: V,
      }),
      mpRun &&
        mpHost &&
        P !== "paused" && // paused 为本地态绝不上广播（R1）；pvp 流程永不进入 paused 态
        context.hostSim &&
        context.hostSim.broadcastState({
          state: P,
          prev: V,
        }));
  }
  // ===== 标题巡航运镜（flow.js 同款参数化路径）=====
  let E = {
    pos: [],
    look: [],
    len: 1,
    t: 0,
  };
  function w() {
    let P = (s && s.cinematicPath) || [];
    if (
      ((E.pos = P.map((Y) => new Vector3(...Y.pos))),
      (E.look = P.map((Y) => new Vector3(...Y.look))),
      E.pos.length < 2)
    ) {
      let Y = (s && s.playerStart && s.playerStart.pos) || new Vector3();
      ((E.pos = [new Vector3(Y.x, 2.2, Y.z), new Vector3(Y.x + 8, 2, Y.z)]),
        (E.look = [
          new Vector3(Y.x + 30, 2.5, Y.z - 2),
          new Vector3(Y.x + 40, 3, Y.z - 2),
        ]));
    }
    let V = 0;
    for (let Y = 1; Y < E.pos.length; Y++)
      V += E.pos[Y].distanceTo(E.pos[Y - 1]);
    E.len = Math.max(V, 4);
  }
  function S(P, V, Y) {
    let L = P.length - 1,
      Z = clamp(V, 0, 1) * L,
      J = Math.min(L - 1, Math.floor(Z)),
      oe = Z - J,
      fe = P[Math.max(0, J - 1)],
      le = P[J],
      R = P[J + 1],
      I = P[Math.min(L, J + 2)],
      se = oe * oe,
      ae = se * oe,
      k = (ce, ve, _e, Te) =>
        0.5 *
        (2 * ve +
          (-ce + _e) * oe +
          (2 * ce - 5 * ve + 4 * _e - Te) * se +
          (-ce + 3 * ve - 3 * _e + Te) * ae);
    return Y.set(
      k(fe.x, le.x, R.x, I.x),
      k(fe.y, le.y, R.y, I.y),
      k(fe.z, le.z, R.z, I.z),
    );
  }
  function z(P) {
    let V = Math.max(26, E.len / PVP_FLOW.titleSpeed);
    ((E.t += P), E.t >= V && (E.t = 0));
    let Y = E.t / V,
      L = Y * Y * (3 - 2 * Y) * 0.25 + Y * 0.75,
      Z = context.camera,
      J = context.time.t;
    (S(E.pos, L, b),
      S(E.look, L, m),
      (b.x += Math.sin(J * 0.31) * 0.05),
      (b.y += Math.sin(J * 0.43 + 1.7) * 0.035),
      (b.z += Math.sin(J * 0.27 + 0.6) * 0.05),
      (m.y += Math.sin(J * 0.19) * 0.12),
      (m.x += Math.sin(J * 0.13 + 2) * 0.2),
      Z.position.copy(b),
      Z.lookAt(m),
      (Z.rotation.z += Math.sin(J * 0.21) * 0.006),
      !context.params.fov &&
        Math.abs(Z.fov - PVP_FLOW.titleFov) > 0.01 &&
        ((Z.fov = PVP_FLOW.titleFov), Z.updateProjectionMatrix()),
      (e.fade = Math.max(
        1 - smoothstep(0, 1.8, E.t),
        smoothstep(V - 1.6, V, E.t),
      )));
  }
  // ===== 回合生命周期 =====
  function H() {
    // 回合清场：无中继/波次/撤离状态可清，只复位战斗面与玩家
    (a(context.enemies, "clear"),
      a(context.fx, "clear"),
      a(context.combat, "reset"),
      a(context.weapon, "reset"),
      (c.time = 0),
      (c.board = []),
      (c.timeUp = !1),
      (c.intensity = 0.15),
      (mpDone = !1),
      (mpTimeBase = 0),
      (roundShown = !1),
      (roundPlayBegun = !1),
      n.cancelPvpRespawn && n.cancelPvpRespawn(),
      (context.pvpBoard = null), // HUD 计分板黑板（§8.2 hud 行主路径）
      (context.pvpRespawn = null), // HUD 重生倒计时黑板（{deadline:ms}）
      (context.pvpTeams = null), // §10.2 队伍比分黑板（{blue,red}）
      (context.pvpProt = null), // §10.2 出生保护黑板（{until:ms}）
      (protPending = 0),
      (protMap = {}),
      (context.pvpProtMap = null), // 旧局保护窗黑板一并撤（combat 视觉通道）
      (context.pvpLastFire = null), // §11.1 旧局开火暴露黑板一并撤（HUD 威胁标兜底）
      (context.pvpLastHitFrom = null), // §11.1 旧局受击方向黑板一并撤（HUD 受击扇形）
      (n.aboard = !1),
      // §10.0 开局落位队伍化：蓝=闸门区 / 红=码头区各自固定点集（与重生同源）。
      // 开局不设保护窗（CF 语义：保护只属于重生；开局双方各在己方半场距离天然拉开）。
      (function mpPlaceTeamStart() {
        var team = myTeam() || 0;
        var set = team === 1 ? PVP_TEAM_SPAWNS.red : PVP_TEAM_SPAWNS.blue;
        var idx = 0;
        try {
          var mates = net && net.players ? net.players() : [];
          for (var i = 0; i < mates.length; i++)
            if (mates[i].you) {
              idx = i;
              break;
            }
        } catch {}
        var pt = set[(idx | 0) % set.length];
        n.reset(
          { pos: new Vector3(pt[0], pt[1], pt[2]), yaw: team === 1 ? Math.PI / 2 : -Math.PI / 2 },
          { noSlotOffset: true },
        );
      })(),
      o.reset && o.reset(),
      (e.saturation = t),
      (e.flash = 0));
  }
  function U({ quick: V = !1, keepRetries: Y = !1, mp: MP = !1 } = {}) {
    let net = netApi();
    if (
      ((mpRun = !!(MP && net && net.mode !== "offline")),
      (mpHost = !!(mpRun && net && net.isHost && net.isHost())),
      !mpRun)
    )
      return; // 对抗仅联机可玩（§8.0）；本地 deploy 在动作表已拦截
    Y || (c.retries = 0);
    // §10.2 队伍配色上下文（每局一次）：UI 取 context.pvpMyTeam（0=蓝 1=红）+
    // context.pvpTeamColors 定敌我高亮（队友蓝/敌红，色值与 ui.css 队伍色同源）
    ((context.pvpTeamColors = { friendly: "#4da3ff", enemy: "#ff5a4d" }),
      (context.pvpMyTeam = myTeam()),
      l.show("none"),
      l.locationCard(!1),
      a(context.audio, "setPaused", !1),
      H(),
      a(context.weapon, "setVisible", !0),
      (h = PVP_FLOW.countdownSeconds),
      (u = 0),
      (cdShown = 0),
      (n.enabled = !1),
      r.setGameplay && r.setGameplay(!1),
      o.show(!0),
      (e.fade = 1),
      a(context.audio, "setIntensity", 0.15),
      M("countdown"));
    // broadcastState("countdown") 已让 host-sim 清场（pvp=null）；此处重建回合
    if (mpHost) {
      let pv = simPvpApi();
      pv && typeof pv.startRound == "function" && pv.startRound();
    }
  }
  function T() {
    if (_.state === "playing") return; // 幂等：倒计时结束与复活回流共用入口
    ((n.enabled = !0),
      r.setGameplay && r.setGameplay(!0),
      o.show(!0),
      // 死亡相机会把后处理降到低饱和度；重生回流必须立刻恢复，
      // 否则 player:respawned 后仍会沿用灰暗画面。
      (e.saturation = t),
      (e.fade = 0),
      o.setObjective(`团队对抗 · 队伍先达 ${PVP_FLOW.killLimit} 杀`),
      M("playing"));
    if (mpRun && mpHost && context.hostSim && !roundPlayBegun) {
      // 房间权威时钟对齐，供命中回溯和事件时间戳使用。
      roundPlayBegun = !0;
      try {
        mpTimeBase = context.hostSim.roomTime() || 0;
      } catch {
        mpTimeBase = 0;
      }
      let pv = simPvpApi();
      pv && typeof pv.startPlay == "function" && pv.startPlay();
    }
  }
  function showRoundEnd() {
    let board = c.board || [],
      me = myId(),
      mine = null;
    for (let k of board) k && k.id === me && (mine = k);
    try {
      if (typeof l.setRoundEnd == "function") {
        // menus 对抗结算屏（§8.2/§10.2 menus 行）就位时走专用面；team 为 §10.1
        // 团队结算字段（menus 未消费时自然忽略，向后兼容）
        l.setRoundEnd({
          board: board,
          timeUp: c.timeUp,
          time: c.time,
          you: me,
          host: mpHost,
          team: c.teamResult || null,
        });
        l.show("roundend");
        return;
      }
    } catch {}
    // 降级：沿用合作简报屏（队伍行=name/kills/acc；menus 专线落地前不断 UI）
    l.setDebrief({
      time: c.time,
      accuracy: null,
      kills: mine ? mine.kills || 0 : 0,
      retries: c.retries,
      rating: c.timeUp
        ? "时间到"
        : mine && board[0] && mine.id === board[0].id
          ? "火力压制"
          : "对抗结束",
      team: board.map((k) => ({
        name: (k.name || "队员") + (k.id === me ? "（你）" : ""),
        kills: k.kills || 0,
        accuracy: null,
        deaths: k.deaths || 0,
      })),
    });
    l.show("complete");
  }
  // ===== 本地事件消费 =====
  (context.events.on("player:dead", () => {
    (_.state !== "playing" && _.state !== "countdown") ||
      (r.setGameplay && r.setGameplay(!1),
      o.setPrompt && o.setPrompt(null),
      o.message && o.message("已阵亡 — 等待重新部署", 3),
      M("dead"));
  }),
    context.events.on("player:respawned", () => {
      // player.js 重生落地（player:respawned）→ 回到战斗（T() 幂等，含倒计时期阵亡的边角）
      if (_.state !== "dead") return;
      (T(),
        l.show("none"), // 撤死亡屏 pvp 变体（menus 自带倒计时 ticker）
        (context.pvpRespawn = null),
        // §10.2 出生保护黑板：落地瞬间起 prot 秒（HUD 显示「重生保护 X.Xs」；
        // 本地权威读数为 player.pvpProtState()，protEnd/开火解除路径置 null）
        (context.pvpProt =
          protPending > 0 ? { until: nowMs() + protPending * 1e3 } : null),
        (protPending = 0),
        o.message && o.message("重新部署完成", 1.5));
    }),
    context.events.on("pvp:score", (ev) => {
      mpRun &&
        ev &&
        Array.isArray(ev.board) &&
        ((c.board = ev.board),
        // HUD 计分板黑板（§8.2 hud 行主路径：顶部小条/Tab 计分板/host 差分击杀流）
        (context.pvpBoard = ev.board),
        // §10.2 队伍配色黑板随板刷新（board 每项带 team，§10.1）
        (context.pvpMyTeam = myTeam()));
    }),
    context.events.on("pvp:teamscore", (ev) => {
      // §10.2 队伍比分黑板（{blue,red}）：顶部计分条主数据源；host 端由 host-sim
      // emitLocal、client 端由本文件从 teamscore 载荷翻译，两端事件语义一致
      mpRun &&
        ev &&
        (context.pvpTeams = { blue: +ev.blue || 0, red: +ev.red || 0 });
    }),
    context.events.on("pvp:killed", (ev) => {
      // 己方击杀高亮播报；被杀时喂 menus 死亡屏 pvp 变体（host 端无载荷回声，
      // 由本流程本地驱动 setDead —— §8.2 menus 行注释同款约定；client 端 menus
      // 自消费 pvp 载荷，此处调用幂等无害）
      if (!mpRun || !ev) return;
      ev.by != null && ev.by === myId() && o.radio && o.radio(RADIO.kill, 2);
      if (ev.victim === myId() && typeof l.setDead == "function") {
        try {
          l.setDead({
            pvp: !0,
            by: ev.by == null ? undefined : ev.by,
            respawn: PVP_FLOW.respawnSeconds,
          });
        } catch {}
      }
    }),
    context.events.on("pvp:respawn", (ev) => {
      // 任意成员重生单：全员保护窗黑板（combat.pvpVisualHit 跳保护目标的数据源，
      // 到点自动失效）；本人单另记 protPending（落地转 context.pvpProt）+ HUD 重生
      // 倒计时黑板（{deadline:ms}；hud mpRespawnLeft 主路径）
      if (!mpRun || !ev) return;
      let sec = +ev.in > 0 ? +ev.in : PVP_FLOW.respawnSeconds,
        prot = +ev.prot > 0 ? +ev.prot : PVP_FLOW.protSeconds;
      protMap[ev.id] = nowMs() + (sec + prot) * 1e3; // 落地(in)+保护(prot)
      context.pvpProtMap = protMap;
      if (ev.id !== myId()) return;
      protPending = prot;
      context.pvpRespawn = { deadline: nowMs() + sec * 1e3 };
    }),
    context.events.on("pvp:protEnd", (ev) => {
      // §10.0 开火解除保护：撤黑板（本人 HUD 提示）+ 清全员保护窗（他人视觉通道）
      if (!mpRun || !ev) return;
      delete protMap[ev.id];
      ev.id === myId() && ((context.pvpProt = null), (protPending = 0));
    }),
    context.events.on("pvp:enemyFire", (ev) => {
      // §11.1 黑板：最近一发开火暴露（HUD 罗盘威胁标记兜底读数，主路径为直接订阅
      // 本事件；敌队过滤 HUD 侧按 team 做，此处只存不筛）。host（host-sim
      // emitLocal）/client（本文件载荷翻译）两端事件同名单次，黑板恒为最新一发
      if (!mpRun || !ev || ev.id == null) return;
      context.pvpLastFire = { id: ev.id, pos: ev.pos || null, at: nowMs() };
    }),
    context.events.on("pvp:roundEnd", (ev) => {
      if (!mpRun || mpDone || _.state === "roundend") return;
      ((mpDone = !0),
        (c.board = (ev && ev.board) || c.board),
        (c.timeUp = !!(ev && ev.timeUp)),
        (c.teamResult =
          ev && ev.winner
            ? {
                blueKills: +ev.blueKills || 0,
                redKills: +ev.redKills || 0,
                winner: ev.winner,
              }
            : null), // §10.1 团队结算（结算屏蓝 X:Y 红+胜利方横幅）
        Array.isArray(c.board) && (context.pvpBoard = c.board),
        (n.enabled = !1),
        r.setGameplay && r.setGameplay(!1),
        o.setPrompt && o.setPrompt(null),
        n.cancelPvpRespawn && n.cancelPvpRespawn(),
        (context.pvpRespawn = null),
        (context.pvpProt = null), // 终局撤保护提示
        a(context.audio, "setIntensity", 0.15),
        o.radio && o.radio(RADIO.limit, 4),
        M("roundend"));
    }),
    context.events.on("input:lock", (P) => {
      if (P.locked) {
        (g = !0), C(!1);
        return;
      }
      (_.state === "playing" && g && G(), (g = !1));
    }),
    document.addEventListener("visibilitychange", () => {
      document.hidden && _.state === "playing" && G();
    }),
    addEventListener("keydown", (P) => {
      _.state !== "title" ||
        l.panelOpen ||
        online() || // R5：联机回车开局封死（对抗必联机，此门恒拦）
        (P.code !== "Enter" && P.code !== "NumpadEnter") ||
        (P.target && P.target.tagName === "BUTTON") ||
        (a(context.audio, "resume"), r.requestLock(), U({ mp: !0 }));
    }));
  function C(P) {
    let V = r.describeMode ? r.describeMode() : "";
    (l.setLookMode(V),
      !(!P && V === x) &&
        ((x = V),
        _.state === "playing" &&
        (r.mode === "drag" ||
          (r.mode === "lock" &&
            !r.locked &&
            !context.params.shot &&
            !context.params.autostart))
          ? o.message(V, r.mode === "drag" ? 7 : 4)
          : _.state === "playing" && r.locked && o.message("", 0)));
  }
  function G() {
    // R1 联机降级：停输入/停本端音频/开菜单，绝不切 game:state（对抗必联机恒走此支）
    _.state === "playing" &&
      (r.setGameplay && r.setGameplay(!1),
      r.exitLock(),
      a(context.audio, "setPaused", !0),
      l.setLookMode(
        r.mode === "drag"
          ? r.describeMode()
          : r.touch
            ? ""
            : "「继续」会重新锁定鼠标。",
      ),
      o.show(!1),
      l.show("paused"),
      (d = 0.35));
  }
  function j(P) {
    if (_.state === "paused") {
      (l.show("none"),
        a(context.audio, "setPaused", !1),
        o.show(!0),
        r.setGameplay && r.setGameplay(!0),
        (g = !1),
        r.requestLock(),
        setTimeout(() => C(!0), 700));
      return;
    }
    // R1 恢复：game:state 未切（仍 playing/dead），撤本地暂停覆盖
    l.screen === "paused" &&
      (l.show("none"),
      a(context.audio, "setPaused", !1),
      o.show(!0),
      r.setGameplay && r.setGameplay(!0),
      (g = !1),
      r.requestLock(),
      setTimeout(() => C(!0), 700));
  }
  function threatIntensity() {
    // 有存活对手贴近即拉高紧张度（音频/视觉强度，与 flow.js 口径类似的简化版）
    try {
      let np = context.netPlayers,
        list =
          typeof np == "function"
            ? np()
            : np && typeof np.list == "function"
              ? np.list()
              : [];
      for (let k of list)
        if (
          k &&
          k.alive !== !1 &&
          !k.local &&
          !k.you &&
          k.pos &&
          Math.hypot(k.pos.x - n.pos.x, k.pos.z - n.pos.z) <
            PVP_FLOW.threatRadius
        )
          return 0.6;
    } catch {}
    return 0.15;
  }
  function B(P) {
    switch (((mpBound || mpBindNet(), (u += P), _.state))) {
      case "title":
        return (z(P), !1);
      case "countdown": {
        hostTick(P); // 房主回合节拍（重生队列/score 心跳从倒计时起就不停摆）
        e.fade = 1 - smoothstep(0.25, Math.min(h, 2), u);
        let V = Math.max(0, Math.ceil(h - u));
        if (V !== cdShown && V >= 1) {
          ((cdShown = V),
            o.message(String(V), 1.1),
            context.events.emit("pvp:countdown", { n: V }));
        }
        if (u >= h) {
          (o.message("开战", 1.4),
            context.events.emit("pvp:countdown", { n: 0 }),
            o.radio && o.radio(RADIO.open, 3.5),
            T());
        }
        return !0;
      }
      case "playing": {
        if (
          (hostTick(P),
          mpRun && mpHost && context.hostSim
            ? (c.time = Math.max(
                0,
                (context.hostSim.roomTime() || 0) - mpTimeBase,
              )) // 房间权威时钟（c.time 替身，契约 §2.3）
            : (c.time += P),
          (e.fade = damp(e.fade || 0, 0, 6, P)),
          (e.saturation = damp(e.saturation ?? t, t, 5, P)),
          d > 0 && (d -= P),
          r.pressed("pause"))
        )
          return (
            mpRun && l.screen === "paused" ? (j(!0), !1) : (G(), !1)
          );
        let V = threatIntensity();
        return (
          V !== c.intensity &&
            ((c.intensity = V), a(context.audio, "setIntensity", V)),
          r.mode === "lock" &&
          !r.locked &&
          !r.touch &&
          !context.params.shot &&
          !context.params.autostart
            ? ((y -= P), y <= 0 && ((y = 2), o.message(r.describeMode(), 2.6)))
            : (y = 0.8),
          !0
        );
      }
      case "dead": {
        // 重生倒计时态：锁输入死亡相机（player.js 死亡镜头）；
        // 倒计时数字由 menus 死亡屏 pvp 变体（自带 ticker）+ HUD 重生覆盖层呈现
        hostTick(P); // 房主阵亡回合照跑
        e.saturation = damp(e.saturation ?? 1, 0.35, 2.2, P);
        e.fade = damp(e.fade || 0, 0.25, 1.4, P);
        u > 0.8 &&
          l.screen !== "dead" &&
          l.screen !== "roundend" &&
          l.screen !== "paused" &&
          (l.show("dead"), a(context.audio, "setIntensity", 0.2));
        return !0;
      }
      case "roundend": {
        hostTick(P); // tick 已 ended 空转；保持调用面不变
        e.fade = damp(e.fade || 0, 0.5, 0.9, P);
        e.saturation = damp(e.saturation ?? 1, t * 0.7, 1, P);
        u > 1.4 && !roundShown && ((roundShown = !0), showRoundEnd());
        return !0;
      }
    }
    return !1;
  }
  return (
    w(),
    (n.enabled = !1),
    o.show(!1),
    a(context.weapon, "setVisible", !1),
    r.setGameplay && r.setGameplay(!1),
    a(context.audio, "setIntensity", 0.15),
    mpBindNet(),
    context.params.shot || context.params.autostart || l.show("title"),
    _
  );
}

export { createPvpFlow, PVP_FLOW };
