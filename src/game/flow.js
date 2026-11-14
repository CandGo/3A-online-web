// Mission progression, relay objectives, waves, extraction and game states.
import { Vector3 } from "../vendor/three-r180.js";
import { clamp, damp, saturate, smoothstep } from "../core/math.js";
import { createMenus } from "../ui/menus.js";

var GAME_FLOW = {
  introSeconds: 3.5,
  retryIntroSeconds: 1.3,
  interactRange: 2.2,
  interactFacing: 0.45,
  cutSeconds: 2.4,
  patrol: {
    gull: 2,
    hound: 1,
  },
  waves: [
    {
      gull: 3,
      hound: 1,
    },
    {
      gull: 3,
      hound: 2,
    },
    {
      gull: 4,
      hound: 3,
    },
  ],
  maxAlive: 9,
  spawnStagger: 0.85,
  spawnFar: 18,
  pursuitEvery: 7,
  pursuitMinAlive: 4,
  pursuitExtra: 5,
  titleSpeed: 1.15,
  titleFov: 50,
};

var jC = [
  "北方",
  "东北方",
  "东方",
  "东南方",
  "南方",
  "西南方",
  "西方",
  "西北方",
];

var _l = {
  intro:
    "\u7834\u969c\u624b\uff0c\u8fd9\u91cc\u662f\u6307\u6325\u90e8\u3002\u6e2f\u52a1\u4e3b\u63a7\u628a\u5b88\u7740\u6cca\u4f4d\u3002\u5207\u65ad\u5b83\u7684\u4e09\u6761\u4e0a\u884c\u94fe\u8def\u2014\u2014\u5806\u573a\u3001\u68c0\u4fee\u68da\u3001\u5cb8\u58c1\u3002",
  contact: "\u5b83\u770b\u89c1\u4f60\u4e86\u3002\u98de\u9e25\u5728\u5929\u4e0a\u98de\uff0c\u730e\u72ac\u5728\u5730\u4e0a\u8d70\u3002\u628a\u5b83\u4eec\u5168\u90e8\u653e\u5012\u3002",
  cut: [
    "\u4e00\u5ea7\u4e2d\u7ee7\u5df2\u65ad\u7535\u3002\u5b83\u5bdf\u89c9\u5230\u4e86\u2014\u2014\u673a\u5668\u6b63\u5728\u903c\u8fd1\u3002",
    "\u4e24\u5ea7\u65ad\u7535\u3002\u5b83\u628a\u538b\u7bb1\u5e95\u7684\u706b\u529b\u5168\u7838\u8fc7\u6765\u4e86\u3002",
  ],
  all: "\u4e09\u5ea7\u5168\u90e8\u65ad\u7535\u3002\u8239\u5c31\u5019\u5728\u5cb8\u58c1\u5357\u7aef\u7684\u8237\u68af\u65c1\u3002\u5feb\u8dd1\u3002",
  low: "\u4f60\u4f24\u5f97\u4e0d\u8f7b\u3002\u9000\u5230\u94a2\u677f\u540e\u9762\uff0c\u5598\u53e3\u6c14\u3002",
  done: "\u7834\u969c\u624b\u5df2\u767b\u8239\u3002Saltline\u5168\u7f51\u65ad\u7535\u3002\u5e72\u5f97\u6f02\u4eae\u3002",
};

function createGameFlow(context) {
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
        console.error(`[game] ${V} threw`, L);
      }
    },
    l = createMenus(context, {
      deploy() {
        let net = netApi();
        if (online()) {
          // 联机：开局权归房主（契约 §0/R5）；lobby「开始行动」与本按钮同走房间 start
          if (net && net.isHost && net.isHost())
            (a(context.audio, "resume"), net.startGame({}));
          else o.message && o.message("等待房主开始行动", 3);
          return;
        }
        (a(context.audio, "resume"), r.requestLock(), U({}));
      },
      host() {
        mpHostRoom();
      },
      join(code) {
        // I5 的加入对话框以 confirmJoin 直接传 4 位房间码字符串
        mpJoinRoom(code);
      },
      mpStart() {
        // lobby「开始行动」（host 专属按钮，menus 已按权限禁用；此处再校验一次）
        let net = netApi();
        if (!online() || !net || !(net.isHost && net.isHost())) return;
        (a(context.audio, "resume"), net.startGame({}));
      },
      mpLeave() {
        // 离开房间：断链 + 本地复位回标题（房主离开=房间终局由服务器/各端自理）
        let net = netApi();
        net && net.disconnect && net.disconnect("离开房间");
        mpResetToTitle();
      },
      resume() {
        j(!0);
      },
      restart() {
        mpRestartAction({
          quick: !0,
        });
      },
      retry() {
        mpRestartAction({
          quick: !0,
        });
      },
      redeploy() {
        let net = netApi();
        if (online()) {
          // 联机：重新部署=房间级重开（房级 retries 口径，BLUEPRINT flow:321 注）
          if (net && net.isHost && net.isHost())
            (a(context.audio, "resume"), net.restartGame({}));
          else o.message && o.message("等待房主重新部署", 3);
          return;
        }
        (a(context.audio, "resume"),
          r.requestLock(),
          U({
            quick: !0,
          }));
      },
    });
  l.applySettings();
  let c = {
      time: 0,
      retries: 0,
      relays: [],
      cut: 0,
      allCut: !1,
      queue: [],
      waveHot: 0,
      alertT: 0,
      pursuitT: 0,
      pursuitLeft: 0,
      contactSaid: !1,
      lowSaid: !1,
      extractHint: 0,
      intensity: 0.15,
      used: new Map(),
    },
    u = 0,
    h = GAME_FLOW.introSeconds,
    f = !1,
    p = !1,
    d = 0,
    v = 0,
    g = !1,
    x = "",
    y = 0.8,
    b = new Vector3(),
    m = new Vector3(),
    A = () => (s && s.objectives) || [],
    _ = {
      state: "title",
      flow: GAME_FLOW,
      run: c,
      menus: l,
      start(P = {}) {
        U({
          skipIntro: !!P.skipIntro,
          quick: !!P.quick,
        });
      },
      pause() {
        G();
      },
      resume() {
        j(!1);
      },
      update: B,
      debugCut() {
        if (online()) return; // R5：联机封死作弊后门（跳过距离/朝向校验直切目标）
        let P = c.relays.find((V) => !V.cut);
        P && me(P);
      },
    };
  // ===== 多人合作挂钩（MP-CONTRACT §3 flow 行 / MP-BLUEPRINT §4 任务状态机表）=====
  // 铁律：全部改动挂 mpRun/online 门，单机路径零回归；文案中文·硬核港区军事风。
  let mpRun = !1, // 本局由房间驱动（net start/restart 置位；本地 deploy/restart 恒 false）
    mpHost = !1, // 本局是否房主权威端（net.isHost 快照，防断线后拓扑翻转）
    mpDone = !1, // 房间级撤离完成（complete）已触发
    mpWiped = !1, // 房间级团灭（wipe）已触发
    mpTimeBase = 0, // playing 起点的 roomTime 偏移（评级阈值/生成时刻表与单机同口径）
    mpBound = !1, // net 事件只绑一次（装配次序无关，晚装可补绑）
    mpIx = { relay: null, on: !1 }, // 切割上报状态机（只在变化时发 ix）
    mpKillTally = new Map(), // 房主端逐人击杀归属（enemy:killed.by 累计）
    MPv = new Vector3(),
    MPeye = new Vector3();
  function netApi() {
    let net = context.net;
    return net && !net.stub && typeof net.on == "function" ? net : null;
  }
  function online() {
    // 联机判定（契约口径）：net 存在、非 stub、且不处于 offline
    let net = netApi();
    return !!(net && net.mode !== "offline");
  }
  function mpRoomTime() {
    try {
      return Math.max(0, (context.hostSim.roomTime() || 0) - mpTimeBase);
    } catch {
      return c.time;
    }
  }
  function mpDifficulty() {
    // 4 人难度：房主按人数缩放（契约 §0），读数失败退回 GAME_FLOW
    if (!mpRun || !mpHost || !context.hostSim) return null;
    try {
      return context.hostSim.difficulty();
    } catch {
      return null;
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
  function mpHostRoom() {
    // 动作表 host：转发 net.createRoom；成功后的 lobby 屏由 I5 经 net 'roomState' 接管
    let net = netApi();
    if (!net || typeof net.createRoom != "function")
      return o.message && o.message("联机模块未就绪", 3);
    (a(context.audio, "resume"),
      net.createRoom(mpPlayerName()).catch((err) => {
        o.message &&
          o.message((err && err.message) || "创建房间失败", 3.5);
      }));
  }
  function mpRoomCodeFromEvent(evt) {
    // I5 加入对话框的输入：优先事件路径内输入框，兜底 UI 根下第一个非滑杆输入框
    let root = null;
    try {
      let el = evt && evt.target;
      el &&
        el.closest &&
        (root =
          el.closest(".m-screen") || el.closest(".menu") || el.closest("#ui"));
    } catch {}
    root || (root = document.getElementById("ui"));
    let input = null;
    if (root && root.querySelector) {
      // 优先级查询（组合选择器按文档序返回，会误中设置面板的文本输入框）
      input = root.querySelector("input[data-room]");
      input ||
        (input = root.querySelector(
          'input[data-act="join"], input:not([type=range])',
        ));
    }
    let code = input && input.value ? String(input.value) : "";
    return code.trim().toUpperCase().slice(0, 8);
  }
  function mpJoinRoom(codeOrEvt) {
    // 动作表 join：I5 confirmJoin 传房间码字符串；兜底从事件路径内输入框读取
    let net = netApi();
    if (!net || typeof net.joinRoom != "function")
      return o.message && o.message("联机模块未就绪", 3);
    let code =
      typeof codeOrEvt == "string"
        ? codeOrEvt
        : mpRoomCodeFromEvent(codeOrEvt);
    (a(context.audio, "resume"),
      net.joinRoom(code, mpPlayerName()).catch((err) => {
        o.message &&
          o.message((err && err.message) || "加入房间失败", 3.5);
      }));
  }
  function mpRestartAction(opts) {
    // restart/retry 动作统一入口：联机走房间级重开（房主权限），离线照旧
    let net = netApi();
    if (online()) {
      if (net && net.isHost && net.isHost()) {
        (a(context.audio, "resume"), net.restartGame(opts || { quick: !0 }));
        return;
      }
      o.message && o.message("只有房主可以重开任务", 3);
      return;
    }
    (a(context.audio, "resume"),
      r.requestLock(),
      c.retries++,
      U({ ...(opts || {}), keepRetries: !0 }));
  }
  function mpPlayersRef() {
    // 全体玩家位姿（context.netPlayers 统一视图：本地单例+远端化身；缺位退化为仅本地）
    let out = [];
    try {
      let np = context.netPlayers,
        list =
          typeof np == "function"
            ? np()
            : np && typeof np.list == "function"
              ? np.list()
              : [];
      for (let i = 0; i < list.length; i++)
        list[i] &&
          list[i].pos &&
          out.push({ pos: list[i].pos, local: !!list[i].local });
    } catch {}
    return out.length ? out : [{ pos: n.pos, local: !0 }];
  }
  function mpNearestPlayer(P) {
    // 距 P 最近的玩家引用（Q() 选点/波次初始瞄准基准，R2）
    let best = null,
      bd = 1e9;
    for (let m of mpPlayersRef()) {
      let d = Math.hypot(m.pos.x - P.x, m.pos.z - P.z);
      d < bd && ((bd = d), (best = m));
    }
    return best;
  }
  function mpMeanPlayerPos(out) {
    // Contact 方位告警基准：全体玩家位置均值（BLUEPRINT §4 flow:501 行）
    ((out = out || MPv), out.set(0, 0, 0));
    let list = mpPlayersRef(),
      k = 0;
    for (let m of list) ((out.x += m.pos.x), (out.z += m.pos.z), k++);
    return k ? ((out.x /= k), (out.z /= k), out) : out.copy(n.pos);
  }
  function mpRoomAliveStates() {
    // 房间成员统一视图（net.players()：含本地；alive/aboard 由 ps 位集刷新）
    let net = netApi(),
      list = net && typeof net.players == "function" ? net.players() : [];
    return list.length
      ? list
      : [{ id: "self", you: !0, alive: n.alive !== !1, aboard: !!n.aboard }];
  }
  function mpAllAboard() {
    // 全员登船才算完成；阵亡者无需登船（契约 §0）
    for (let p of mpRoomAliveStates())
      if (p.alive !== !1 && p.aboard !== !0) return !1;
    return !0;
  }
  function mpNoneAlive() {
    for (let p of mpRoomAliveStates()) if (p.alive !== !1) return !1;
    return !0;
  }
  function mpReportInteract(relayId, on) {
    // 切割上报：房主直调 sim.onInteract（本地玩家也在 roster）；client 走 ix 载荷
    try {
      let net = netApi();
      if (
        mpHost &&
        context.hostSim &&
        typeof context.hostSim.onInteract == "function"
      )
        context.hostSim.onInteract(
          net && net.selfId ? net.selfId() : null,
          relayId,
          on,
        );
      else if (net && net.client && typeof net.client.send == "function")
        net.client.send({ k: "ix", id: net.selfId(), relay: relayId, on: !!on });
    } catch (e) {
      console.error("[game] mpReportInteract threw", e);
    }
  }
  function mpRoomStats() {
    // 房级结算：time/retries 房级；kills 逐人按房主端 enemy:killed.by 归属累计；
    // 命中率 v1 以房主本地口径聚合（逐人命中率待 stats 上行通道补全）
    let S = (context.combat && context.combat.stats) || {
        shots: 0,
        hits: 0,
        kills: 0,
      },
      acc = S.shots > 0 ? clamp(S.hits / S.shots, 0, 1) : null,
      teamKills = 0;
    mpKillTally.forEach((v) => (teamKills += v));
    let per = [];
    for (let p of mpRoomAliveStates())
      per.push({
        id: p.id,
        name: p.name || "队员",
        you: !!p.you,
        kills: mpKillTally.get(p.id) || 0,
        deaths: p.deaths || 0,
        accuracy: p.you ? acc : null,
      });
    return {
      time: c.time,
      retries: c.retries,
      accuracy: acc,
      kills: teamKills || S.kills || 0,
      players: per,
    };
  }
  function mpShowComplete(stats) {
    if (mpDone && _.state === "complete") return;
    ((mpDone = !0), (stats = stats || mpRoomStats()));
    let V = stats.accuracy,
      Y =
        (stats.time < 270 ? 2 : stats.time < 400 ? 1 : 0) +
        (V >= 0.5 ? 2 : V >= 0.3 ? 1 : 0) +
        (stats.retries === 0 ? 1 : 0),
      L = ["险象环生", "火力全开", "稳扎稳打", "干净利落", "精准果断", "完美突击"][Y];
    (l.setDebrief({
      time: stats.time,
      accuracy: V,
      kills: stats.kills || 0,
      retries: stats.retries || 0,
      rating: L,
      mp: !0, // I5 合作简报扩展位（逐人卡/队伍口径）；单机字段照旧
      players: stats.players,
    }),
      M("complete"));
  }
  function mpCompleteOnline() {
    if (mpDone || mpWiped) return;
    let stats = mpRoomStats();
    mpHost &&
      context.hostSim &&
      context.hostSim.onComplete(stats); // rm.complete 广播
    mpShowComplete(stats);
  }
  function mpShowDead() {
    if (mpWiped || mpDone) return;
    ((mpWiped = !0),
      r.setGameplay && r.setGameplay(!1),
      r.exitLock(),
      o.setPrompt && o.setPrompt(null),
      o.show(!1),
      o.clearRadio && o.clearRadio(),
      l.setDead({
        time: c.time,
        relays: c.cut,
        total: c.relays.length,
        mp: !0,
      }),
      M("dead"));
  }
  function mpWipeOnline() {
    if (mpWiped || mpDone) return;
    mpHost && context.hostSim && context.hostSim.onWipe(); // rm.wipe 广播
    mpShowDead();
  }
  function mpOnHostPayload(p) {
    // client 端：房主广播 → 本地事件/终局（host 端由 hostSim 本地直发；回声不翻译防双发）
    try {
      if (!p || typeof p != "object" || !mpRun || mpHost) return;
      if (p.k === "ob") {
        if (p.e === "progress")
          context.events.emit("objective:progress", {
            id: p.relay,
            t: +p.t || 0,
          });
        else if (p.e === "done")
          context.events.emit("objective:done", { id: p.relay });
        else if (p.e === "all") context.events.emit("objective:all", {});
      } else if (p.k === "rs") {
        let R = c.relays.find((x) => x.id === p.relay);
        R &&
          O(
            R.o,
            p.s === "cutting" ? "cutting" : p.s === "cut" ? "cut" : "live",
          );
      } else if (p.k === "rm") {
        if (p.e === "wipe") mpShowDead();
        else if (p.e === "complete") mpShowComplete(p.stats);
      }
    } catch (e) {
      console.error("[game] mpOnHostPayload threw", e);
    }
  }
  function mpResetToTitle() {
    // 房间终局复位：主动离开/房主已离开/线路中断——本局作废回标题（toast 文案归 I5）
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
      l.show("title"));
  }
  function mpBindNet() {
    // net 事件绑定（幂等）：start/restart 驱动 U()；client 载荷翻译订阅
    if (mpBound) return;
    let net = netApi();
    if (!net) return;
    mpBound = !0;
    net.on("start", () => U({ mp: !0 }));
    net.on("restart", () => (
      (c.retries++), // 房级重开计一次（房间共享，BLUEPRINT flow:88/97/321）
      U({ mp: !0, quick: !0, keepRetries: !0 })
    ));
    // 房间终局：房主已离开/线路中断（v1 无重连）→ 本局作废；房主自身断线则继续本地权威局
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
        P !== "paused" && // paused 为本地态，绝不上广播（契约 §0）
        context.hostSim &&
        context.hostSim.broadcastState({
          state: P,
          prev: V,
        }));
  }
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
    let V = Math.max(26, E.len / GAME_FLOW.titleSpeed);
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
        Math.abs(Z.fov - GAME_FLOW.titleFov) > 0.01 &&
        ((Z.fov = GAME_FLOW.titleFov), Z.updateProjectionMatrix()),
      (e.fade = Math.max(
        1 - smoothstep(0, 1.8, E.t),
        smoothstep(V - 1.6, V, E.t),
      )));
  }
  function H() {
    (a(context.enemies, "clear"),
      a(context.fx, "clear"),
      a(context.combat, "reset"),
      a(context.weapon, "reset"),
      (c.time = 0),
      (c.cut = 0),
      (c.allCut = !1),
      (c.queue.length = 0),
      (c.waveHot = 0),
      (c.alertT = 0),
      (c.pursuitT = 0),
      (c.pursuitLeft = 0),
      (c.contactSaid = !1),
      (c.lowSaid = !1),
      (c.extractHint = 0),
      c.used.clear(),
      (mpWiped = !1),
      (mpDone = !1),
      (mpTimeBase = 0),
      (mpIx.relay = null),
      (mpIx.on = !1),
      mpKillTally.clear(),
      (n.aboard = !1),
      (c.relays = A().map((P, V) => {
        let Y = (/([a-z0-9])$/i.exec(String(P.id || "")) || [
          0,
          String.fromCharCode(65 + V),
        ])[1].toUpperCase();
        return (
          O(P, "live"),
          {
            o: P,
            id: P.id || "relay_" + V,
            short: Y,
            t: 0,
            cut: !1,
            cutting: !1,
          }
        );
      })),
      n.reset(s.playerStart),
      o.reset && o.reset(),
      (e.saturation = t),
      (e.flash = 0),
      q(),
      o.setRelays && o.setRelays(0, c.relays.length),
      ie());
  }
  function O(P, V) {
    try {
      let Y = P && P.object && P.object.userData;
      Y && typeof Y.setState == "function" && Y.setState(V);
    } catch (Y) {
      console.error("[game] relay setState threw", Y);
    }
  }
  function q() {
    if (!o.setMarkers) return;
    let P = c.relays
      .filter((V) => !V.cut)
      .map((V) => ({
        id: V.id,
        short: V.short,
        label: V.o.label || "中继 " + V.short,
        pos: V.o.pos,
        kind: "relay",
      }));
    (c.allCut &&
      s.extraction &&
      P.push({
        id: "extract",
        short: "EX",
        label: "撤离船",
        pos: s.extraction.pos,
        kind: "extract",
      }),
      o.setMarkers(P));
  }
  function U({
    skipIntro: P = !1,
    quick: V = !1,
    keepRetries: Y = !1,
    mp: MP = !1,
  } = {}) {
    let net = netApi();
    if (
      ((mpRun = !!(MP && net && net.mode !== "offline")),
      (mpHost = !!(mpRun && net && net.isHost && net.isHost())),
      Y || (c.retries = 0),
      l.show("none"),
      l.locationCard(!1),
      a(context.audio, "setPaused", !1),
      H(),
      a(context.weapon, "setVisible", !0),
      (g = !1),
      P)
    ) {
      ((e.fade = 0), T());
      return;
    }
    ((h = V ? GAME_FLOW.retryIntroSeconds : GAME_FLOW.introSeconds),
      (f = V),
      (p = V),
      (n.enabled = !1),
      r.setGameplay && r.setGameplay(!1),
      o.show(!1),
      (e.fade = 1),
      a(context.audio, "setIntensity", 0.15),
      M("intro"));
  }
  function T() {
    ((n.enabled = !0),
      o.show(!0),
      r.setGameplay && r.setGameplay(!0),
      o.setObjective(D()),
      M("playing"),
      C(!0));
    if (mpRun && mpHost && context.hostSim) {
      // 房间权威时钟对齐：playing 起点归零（intro 时长不污染评级/时刻表）
      try {
        mpTimeBase = context.hostSim.roomTime() || 0;
      } catch {
        mpTimeBase = 0;
      }
    } else mpTimeBase = 0;
  }
  function D() {
    if (c.allCut) return "登船撤离";
    let P = c.relays.length - c.cut;
    return c.cut === 0
      ? "切断三座上行中继"
      : P === 1
        ? "切断最后一座中继"
        : `切断剩余${P}座中继`;
  }
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
  (r.onModeChange && r.onModeChange(() => C(!1)),
    context.events.on("input:lock", (P) => {
      if (P.locked) {
        ((g = !0), C(!1));
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
        online() || // R5：联机回车开局封死（开局权归房主）
        (P.code !== "Enter" && P.code !== "NumpadEnter") ||
        (P.target && P.target.tagName === "BUTTON") ||
        (a(context.audio, "resume"), r.requestLock(), U({}));
    }));
  function G() {
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
      (d = 0.35),
      mpRun || M("paused")); // R1：联机只做本地覆盖（停输入/停音频/开菜单），绝不切 game:state 冻结房间
  }
  function j(P) {
    if (_.state === "paused") {
      (l.show("none"),
      a(context.audio, "setPaused", !1),
      o.show(!0),
      r.setGameplay && r.setGameplay(!0),
      (g = !1),
      r.requestLock(),
      M("playing"),
      setTimeout(() => C(!0), 700));
      return;
    }
    // R1 联机降级恢复：game:state 未切（仍 playing），只撤本地暂停覆盖
    mpRun &&
      l.screen === "paused" &&
      (l.show("none"),
      a(context.audio, "setPaused", !1),
      o.show(!0),
      r.setGameplay && r.setGameplay(!0),
      (g = !1),
      r.requestLock(),
      setTimeout(() => C(!0), 700));
  }
  function N(P) {
    let V = P === "gull" ? "air" : "ground",
      Y = (s && s.enemySpawns) || [],
      L = Y.filter((Z) => Z.type === V);
    return L.length ? L : Y;
  }
  function Q(
    P,
    {
      minDist: V = GAME_FLOW.spawnFar,
      from: Y = n.pos,
      preferHidden: L = !0,
    } = {},
  ) {
    let Z = N(P),
      J = null,
      oe = -1e9,
      refs = mpRun ? mpPlayersRef() : null;
    for (let le of Z) {
      let R = Math.hypot(le.pos.x - Y.x, le.pos.z - Y.z);
      if (refs && refs.length) {
        // 联机：选点参考全体玩家最近者（R2），不再只盯本地玩家
        R = 1e9;
        for (let m of refs) {
          let d2 = Math.hypot(le.pos.x - m.pos.x, le.pos.z - m.pos.z);
          d2 < R && (R = d2);
        }
      }
      let I = context.rng() * 1.5;
      if (
        ((I += R >= V ? 2 + Math.min(1, (R - V) / 30) * 0.5 : -(V - R) / 4), L)
      ) {
        (b.copy(le.pos), (b.y += P === "gull" ? 0 : 1));
        let ae = !0;
        try {
          let eye = n.eye;
          if (mpRun) {
            // 隐蔽性对最近玩家判定（远端无 eye，用 pos+1.5 近似）
            let nr = mpNearestPlayer(le.pos);
            nr &&
              !nr.local &&
              (MPeye.set(nr.pos.x, (nr.pos.y || 0) + 1.5, nr.pos.z),
              (eye = MPeye));
          }
          ae = context.physics.lineOfSight(b, eye);
        } catch {}
        ae || (I += 2.5);
      }
      let se = c.used.get(le);
      (se !== void 0 && c.time - se < 6 && (I -= 3),
        I > oe && ((oe = I), (J = le)));
    }
    let fe = new Vector3();
    if (J) {
      (c.used.set(J, c.time), fe.copy(J.pos));
      let le = (context.rng() - 0.5) * 2.4,
        R = (context.rng() - 0.5) * 2.4,
        I = P === "gull";
      try {
        I || (I = context.physics.nav.isWalkable(fe.x + le, fe.z + R));
      } catch {
        I = !1;
      }
      I && ((fe.x += le), (fe.z += R));
    } else {
      let le = context.rng() * Math.PI * 2;
      fe.set(
        clamp(Y.x + Math.cos(le) * 26, -34, 26),
        0,
        clamp(Y.z + Math.sin(le) * 26, -26, 24),
      );
    }
    return (P === "gull" && fe.y < 2.5 && (fe.y = 6 + context.rng() * 3), fe);
  }
  function K(P, V, Y) {
    let L = null;
    if (mpRun && !mpHost) return null; // client 不本地刷怪（等 ee.spawn 广播）
    try {
      L =
        mpRun && context.hostSim
          ? context.hostSim.onSpawnRequest(P, V, Y) // 房主权威刷怪：本地 spawn + ee.spawn 广播
          : context.enemies.spawn(P, V, Y);
    } catch (Z) {
      console.error("[game] enemies.spawn threw", Z);
    }
    return L;
  }
  function ie() {
    if (mpRun && !mpHost) return; // 初始巡逻仅房主生成（客户端经 ee.spawn 呈现）
    let P = (s.playerStart && s.playerStart.pos) || n.pos;
    for (let V of ["gull", "hound"])
      for (let Y = 0; Y < GAME_FLOW.patrol[V]; Y++)
        K(
          V,
          Q(V, {
            minDist: 32,
            from: P,
            preferHidden: !0,
          }),
          {
            state: "patrol",
          },
        );
  }
  function F(P) {
    if (mpRun && !mpHost) return; // 波次构建仅房主（刷怪 RNG 房主独占，R2）
    let DIF = mpDifficulty(),
      WAVES = (DIF && DIF.waves) || GAME_FLOW.waves,
      V = WAVES[Math.min(P, WAVES.length - 1)],
      Y = [];
    for (let oe = 0; oe < V.gull; oe++) Y.push("gull");
    for (let oe = 0; oe < V.hound; oe++)
      Y.splice(Math.min(Y.length, 1 + oe * 2), 0, "hound");
    let L = 0,
      Z = 0,
      ref = mpRun ? mpMeanPlayerPos(MPv) : n.pos;
    (Y.forEach((oe, fe) => {
      let le = Q(oe);
      ((L += le.x - ref.x),
        (Z += le.z - ref.z),
        c.queue.push({
          type: oe,
          pos: le,
          at: c.time + 1.6 + fe * GAME_FLOW.spawnStagger,
        }));
    }),
      (c.waveHot = 30));
    let J = ((Math.atan2(L, -Z) * 180) / Math.PI + 360) % 360;
    o.warn && o.warn("\u63a5\u654c \u2014 " + jC[Math.round(J / 45) % 8], 3.4);
  }
  function X(P) {
    if (mpRun && !mpHost) return; // 生成泵/追击仅房主（client 等 ee 广播）
    let V = ne(),
      MA = (mpDifficulty() || GAME_FLOW).maxAlive;
    for (let Y = 0; Y < c.queue.length; Y++) {
      let L = c.queue[Y];
      if (c.time < L.at) continue;
      if (V >= MA) {
        L.at = c.time + 1;
        continue;
      }
      let tgt = n.pos;
      mpRun &&
        (tgt = (mpNearestPlayer(L.pos) || { pos: n.pos }).pos); // 初始瞄准最近玩家
      if (
        !K(L.type, L.pos, {
          state: "alert",
          target: tgt,
        }) &&
        !context.enemies.stub &&
        (L.tries = (L.tries || 0) + 1) < 6
      ) {
        L.at = c.time + 1.5;
        continue;
      }
      (c.queue.splice(Y, 1), a(context.enemies, "alert", n.pos, 60));
      break;
    }
    if (c.allCut) {
      if (
        ((c.pursuitT -= P),
        c.pursuitT <= 0 &&
          c.pursuitLeft > 0 &&
          !c.queue.length &&
          V < GAME_FLOW.pursuitMinAlive)
      ) {
        ((c.pursuitT = GAME_FLOW.pursuitEvery), c.pursuitLeft--);
        let Y = context.rng() < 0.6 ? "gull" : "hound";
        c.queue.push({
          type: Y,
          pos: Q(Y),
          at: c.time + 0.5,
        });
      }
      c.pursuitT <= 0 &&
        ((c.pursuitT = 4), a(context.enemies, "alert", n.pos, 90));
    }
  }
  function ne() {
    try {
      return context.enemies.aliveCount
        ? context.enemies.aliveCount()
        : context.enemies.list.filter((P) => P.alive).length;
    } catch {
      return 0;
    }
  }
  function re(P) {
    let V = (context.enemies && context.enemies.list) || [];
    for (let Y = 0; Y < V.length; Y++) {
      let L = V[Y];
      if (
        L &&
        L.alive &&
        L.pos &&
        Math.hypot(L.pos.x - n.pos.x, L.pos.z - n.pos.z) < P
      )
        return !0;
    }
    return !1;
  }
  (context.events.on("enemy:alert", () => {
    ((c.alertT = 10),
      _.state === "playing" &&
        !c.contactSaid &&
        ((c.contactSaid = !0), o.radio && o.radio(_l.contact, 3.2)));
  }),
    context.events.on("player:hit", () => {
      c.alertT = Math.max(c.alertT, 8);
    }),
    context.events.on("player:rescued", () => {
      _.state === "playing" && o.message("已从水中捞起", 2.5);
    }),
    // —— 联机目标回放：host 端由 hostSim 本地 emit、client 端由 ob 广播翻译，各端单次 ——
    context.events.on("enemy:killed", (P) => {
      // 房主端逐人击杀归属累计（结算"kills 逐人"用；by 由 combat/hostSim 结算窗口补）
      if (!mpRun || !mpHost || !P || P.by == null) return;
      mpKillTally.set(P.by, (mpKillTally.get(P.by) || 0) + 1);
    }),
    context.events.on("objective:progress", (P) => {
      if (!mpRun || !P) return;
      let R = c.relays.find((x) => x.id === P.id);
      R && !R.cut && (R.t = Math.min(1, Math.max(0, +P.t || 0)));
    }),
    context.events.on("objective:done", (P) => {
      if (!mpRun || !P) return;
      let R = c.relays.find((x) => x.id === P.id);
      if (!R || R.cut) return; // 幂等：host 本地 emit 与 ob 回放只走一次（防双发）
      ((R.cut = !0), (R.cutting = !1), (R.t = 1),
        (c.cut =
          typeof P.index == "number"
            ? P.index
            : c.relays.filter((x) => x.cut).length));
      let V = c.relays.length;
      (o.setRelays && o.setRelays(c.cut, V),
        o.setPrompt && o.setPrompt(null),
        n.addShake(0.18),
        mpHost && F(c.cut - 1), // 下一波仅房主调度
        c.cut < V &&
          o.radio &&
          o.radio(_l.cut[Math.min(c.cut - 1, _l.cut.length - 1)], 3.6),
        o.setObjective(D()),
        q());
    }),
    context.events.on("objective:all", () => {
      if (!mpRun || c.allCut) return;
      let DIF = mpDifficulty();
      ((c.allCut = !0),
        (c.pursuitLeft = DIF ? DIF.pursuitExtra : GAME_FLOW.pursuitExtra),
        (c.pursuitT = 12),
        o.radio && o.radio(_l.all, 4.5),
        o.setObjective(D()),
        q());
    }));
  function $() {
    let P = null,
      V = GAME_FLOW.interactRange;
    for (let Y of c.relays) {
      if (Y.cut) continue;
      let L = Y.o.pos.x - n.pos.x,
        Z = Y.o.pos.z - n.pos.z,
        J = Math.hypot(L, Z);
      J > V ||
        Math.abs((Y.o.pos.y || 0) - n.pos.y) > 2.5 ||
        (J > 0.9 &&
          (L * n.forward.x + Z * n.forward.z) /
            (J * Math.max(0.2, Math.hypot(n.forward.x, n.forward.z))) <
            GAME_FLOW.interactFacing) ||
        ((P = Y), (V = J));
    }
    return P;
  }
  function ue(P) {
    if (mpRun) return ueOnline(P);
    let V = n.alive ? $() : null;
    for (let L of c.relays)
      L.cut ||
        (L === V && r.down("interact")
          ? (L.cutting || ((L.cutting = !0), O(L.o, "cutting")),
            (L.t += P / GAME_FLOW.cutSeconds),
            context.events.emit("objective:progress", {
              id: L.id,
              t: Math.min(1, L.t),
            }),
            L.t >= 1 && me(L))
          : L.t > 0 &&
            ((L.t = Math.max(0, L.t - P * 1.6)),
            L.cutting &&
              ((L.cutting = !1),
              O(L.o, "live"),
              context.events.emit("objective:progress", {
                id: L.id,
                t: 0,
              }))));
    V && !V.cut
      ? o.setPrompt && o.setPrompt("切断中继 " + V.short, saturate(V.t))
      : o.setPrompt && o.setPrompt(null);
    let Y = s.extraction;
    if (Y && Y.pos) {
      let L = Math.hypot(Y.pos.x - n.pos.x, Y.pos.z - n.pos.z),
        Z = L < (Y.radius || 2.5) && Math.abs(Y.pos.y - n.pos.y) < 3.5;
      (Z && c.allCut && n.alive
        ? ee()
        : Z &&
          !c.allCut &&
          c.extractHint <= 0 &&
          ((c.extractHint = 8),
          o.message(
            "\u4e2d\u7ee7\u672a\u5168\u90e8\u65ad\u5f00 \u2014 \u8239\u4e0d\u4f1a\u5728\u706b\u7ebf\u4e0b\u4e45\u7559",
            3.5,
          )),
        (c.extractHint = Math.max(0, c.extractHint - P)));
    }
  }
  function ueOnline(P) {
    // 联机切割/撤离（契约 §0/§3）：本地只采集"我在按 E 且贴近哪座中继"并上报，
    // 进度/完成/松手判定全部消费房主 ob/rs 广播（HUD 同源）。
    let V = n.alive ? $() : null,
      press = !!(V && !V.cut && r.down("interact")),
      cur = press && V ? V.id : null;
    if (cur !== mpIx.relay || press !== mpIx.on) {
      (mpIx.on && mpIx.relay != null && mpReportInteract(mpIx.relay, !1),
        press && mpReportInteract(cur, !0),
        (mpIx.relay = cur),
        (mpIx.on = press));
    }
    (V && !V.cut
      ? o.setPrompt && o.setPrompt("切断中继 " + V.short, saturate(V.t))
      : o.setPrompt && o.setPrompt(null));
    let Y = s.extraction;
    if (Y && Y.pos) {
      let L = Math.hypot(Y.pos.x - n.pos.x, Y.pos.z - n.pos.z),
        Z = L < (Y.radius || 2.5) && Math.abs(Y.pos.y - n.pos.y) < 3.5;
      (Z && c.allCut && n.alive && !n.aboard
        ? ee()
        : Z &&
          !c.allCut &&
          c.extractHint <= 0 &&
          ((c.extractHint = 8),
          o.message("中继未全部断开 — 船不会在火线下久留", 3.5)),
        (c.extractHint = Math.max(0, c.extractHint - P)));
    }
    if (mpHost && !mpDone && !mpWiped) {
      // 房主权威终局轮询：全员登船→complete / 全员倒地→wipe（rm 广播）
      n.aboard && mpAllAboard() && mpCompleteOnline();
      !n.alive && mpNoneAlive() && mpWipeOnline();
    }
  }
  function me(P) {
    if (mpRun) {
      // 联机：完成判定归房主权威（正常路径 hostSim.advanceRelays 直发；此处入口兜底）
      mpHost && context.hostSim && context.hostSim.onObjectiveDone(P.id);
      return;
    }
    ((P.cut = !0), (P.cutting = !1), (P.t = 1), c.cut++, O(P.o, "cut"));
    let V = c.relays.length;
    (context.events.emit("objective:done", {
      id: P.id,
      index: c.cut,
      total: V,
    }),
      o.setRelays && o.setRelays(c.cut, V),
      o.setPrompt && o.setPrompt(null),
      n.addShake(0.18),
      F(c.cut - 1),
      c.cut >= V
        ? ((c.allCut = !0),
          (c.pursuitLeft = GAME_FLOW.pursuitExtra),
          (c.pursuitT = 12),
          context.events.emit("objective:all", {}),
          o.radio && o.radio(_l.all, 4.5))
        : o.radio &&
          o.radio(_l.cut[Math.min(c.cut - 1, _l.cut.length - 1)], 3.6),
      o.setObjective(D()),
      q());
  }
  context.events.on("player:dead", () => {
    (_.state !== "playing" && _.state !== "paused") ||
      (mpRun
        ? // R3/合作语义：本地倒地→观战（相机由 player.js 接管），全员倒地才房级 wipe；
          // 保持指针锁定以免触发 G() 暂停覆盖，终局屏由 rm.wipe / 房主判定驱动
          (r.setGameplay && r.setGameplay(!1),
          o.setPrompt && o.setPrompt(null),
          o.message && o.message("已倒地 — 观战中，等待队友撤离", 4))
        : (r.setGameplay && r.setGameplay(!1),
          r.exitLock(),
          o.setPrompt && o.setPrompt(null),
          o.show(!1),
          o.clearRadio && o.clearRadio(),
          l.setDead({
            time: c.time,
            relays: c.cut,
            total: c.relays.length,
          }),
          M("dead")));
  });
  function ee() {
    ((n.invulnerable = !0),
      (n.enabled = !1),
      (n.aboard = !0), // §3 player 行 aboard 标志（client 经 ps 位集上行）
      r.setGameplay && r.setGameplay(!1),
      r.exitLock(),
      o.setPrompt && o.setPrompt(null),
      o.show(!1),
      context.events.emit("extraction:reached", {}),
      o.clearRadio && o.clearRadio(),
      o.radio && o.radio(_l.done, 2.2));
    if (mpRun) {
      // 登船上报：房主直调权威入口；结算屏等全员登船（房主判定→onComplete 广播）
      let net = netApi();
      mpHost &&
        context.hostSim &&
        net &&
        context.hostSim.onAboard(net.selfId());
      return;
    }
    let P = (context.combat && context.combat.stats) || {
        shots: 0,
        hits: 0,
        kills: 0,
      },
      V = P.shots > 0 ? clamp(P.hits / P.shots, 0, 1) : null,
      Y =
        (c.time < 270 ? 2 : c.time < 400 ? 1 : 0) +
        (V >= 0.5 ? 2 : V >= 0.3 ? 1 : 0) +
        (c.retries === 0 ? 1 : 0),
      L = ["险象环生", "火力全开", "稳扎稳打", "干净利落", "精准果断", "完美突击"][Y];
    (l.setDebrief({
      time: c.time,
      accuracy: V,
      kills: P.kills || 0,
      retries: c.retries,
      rating: L,
    }),
      M("complete"));
  }
  function B(P) {
    switch (((mpBound || mpBindNet(), (u += P), _.state))) {
      case "title":
        return (z(P), !1);
      case "intro":
        return (
          (e.fade = 1 - smoothstep(0.25, Math.min(h, 2.6), u)),
          !f && u > 0.5 && ((f = !0), l.locationCard(!0)),
          !p && u > 1.3 && ((p = !0), o.radio && o.radio(_l.intro, 4.2)),
          u > h - 0.6 &&
            !o.root?.classList.contains("on") &&
            (o.show(!0), o.setObjective(D())),
          u >= h && (l.locationCard(!1), (e.fade = 0), T()),
          !0
        );
      case "playing": {
        if (
          (mpRun && mpHost && context.hostSim
            ? (c.time = mpRoomTime()) // 房间权威时钟（c.time 替身，契约 §2.3）
            : (c.time += P),
          (e.fade = damp(e.fade || 0, 0, 6, P)),
          d > 0 && (d -= P),
          r.pressed("pause"))
        )
          return (
            mpRun && l.screen === "paused" ? (j(!0), !1) : (G(), !1)
          );
        if ((ue(P), _.state !== "playing")) return !0;
        (X(P),
          (c.alertT = Math.max(0, c.alertT - P)),
          (c.waveHot = Math.max(0, c.waveHot - P)));
        let V = ne();
        c.waveHot > 0 &&
          V === 0 &&
          !c.queue.length &&
          c.waveHot < 24 &&
          (c.waveHot = 0);
        let Y =
          c.allCut || c.queue.length || (c.waveHot > 0 && V > 0)
            ? 1
            : c.alertT > 0 || (V > 0 && re(26))
              ? 0.6
              : 0.15;
        return (
          Y !== c.intensity &&
            ((c.intensity = Y), a(context.audio, "setIntensity", Y)),
          r.mode === "lock" &&
          !r.locked &&
          !r.touch &&
          !context.params.shot &&
          !context.params.autostart
            ? ((y -= P), y <= 0 && ((y = 2), o.message(r.describeMode(), 2.6)))
            : (y = 0.8),
          !c.lowSaid &&
            n.alive &&
            n.health < 30 &&
            ((c.lowSaid = !0), o.radio && o.radio(_l.low, 3)),
          !0
        );
      }
      case "paused":
        return (
          d > 0 ? (d -= P) : r.pressed("pause") && (l.closePanel() || j(!1)),
          !1
        );
      case "dead":
        return (
          (e.saturation = damp(e.saturation ?? 1, 0.12, 2.2, P)),
          (e.fade = damp(e.fade || 0, 0.55, 1.4, P)),
          u > 1.5 &&
            l.screen !== "dead" &&
            (l.show("dead"), a(context.audio, "setIntensity", 0.15)),
          !0
        );
      case "complete":
        return (
          (e.fade = damp(e.fade || 0, 0.72, 0.9, P)),
          (e.saturation = damp(e.saturation ?? 1, t * 0.7, 1, P)),
          u > 3.3 &&
            l.screen !== "complete" &&
            (l.show("complete"), a(context.audio, "setIntensity", 0.15)),
          !0
        );
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

export { createGameFlow, GAME_FLOW };
