// Game context, original system startup order and frame loop.
import { PlaneGeometry, THREE, Vector3 } from "../vendor/three-r180.js";
import { chooseQuality } from "../core/quality.js";
import { createEventBus } from "../core/events.js";
import { createRandom } from "../core/random.js";
import { FALLBACKS } from "../core/fallbacks.js";
import { createMesh } from "../core/geometry.js";
import { createRenderer } from "../render/renderer.js";
import { createMaterials } from "../render/materials/materials.js";
import { createPhysics } from "../world/physics.js";
import { createProps } from "../world/props/props.js";
import { createLevel } from "../world/level/level.js";
import { createBackdrop } from "../world/backdrop/backdrop.js";
import { createGround } from "../world/ground/ground.js";
import { createEffects } from "../effects/effects.js";
import { createAudio } from "../audio/audio.js";
import { createInput } from "../input/input.js";
import { createPlayer } from "../player/player.js";
import { createCombat } from "../combat/combat.js";
import { createWeapon } from "../weapons/weapon.js";
import { createEnemies } from "../enemies/enemies.js";
import { createHUD } from "../ui/hud.js";
import { createGameFlow } from "../game/flow.js";
import { createPvpFlow } from "../game/pvp.js"; // MP-PVP §8.2：对抗房间换装（并行契约模块，集成者兜底对账）
import { SHOWCASE_MODULES } from "./showcases.js";
import { showFatalError } from "./diagnostics.js";
import { bootElement, setBootProgress } from "./boot-screen.js";
import { enableBenchmark } from "./benchmark.js";
import { createShowcaseInput, createShowcasePlayer } from "./showcase-stubs.js";
import { createNet } from "../net/net.js";
import { createHostSim } from "../net/host-sim.js";
import { createRemotePlayers } from "../net/remote-players.js";
import { createEnemyPuppet } from "../net/puppet.js";

async function startGame() {
  let params = Object.fromEntries(new URLSearchParams(location.search)),
    benchmark = !!params.bench || location.hash === "#bench";
  benchmark && ((params.noaudio = "1"), (params.autostart = "1"));
  let context = {
    THREE: THREE,
    params: params,
    events: createEventBus(),
    rng: createRandom(+(params.seed || 4207)),
    time: {
      t: 0,
      dt: 0,
      frame: 0,
      real: 0,
    },
    quality: chooseQuality(params.q || (params.shot ? "test" : "")),
  };
  window.__G = context;
  let showcaseName =
    params.show && SHOWCASE_MODULES[params.show] ? params.show : null;
  context.showcase = showcaseName;
  let cameraOverride = null;
  function setShot(h) {
    if (h.cam) {
      let f = String(h.cam).split(",").map(Number);
      cameraOverride = {
        pos: new Vector3(f[0], f[1], f[2]),
        look: new Vector3(f[3] ?? 0, f[4] ?? 1, f[5] ?? 0),
      };
    }
    (h.cam === "" && (cameraOverride = null),
      h.fov &&
        ((context.camera.fov = +h.fov),
        context.camera.updateProjectionMatrix()),
      h.exposure && (context.render.exposure = +h.exposure));
  }
  window.__setShot = setShot;
  // —— 多人装配基建（MP-CONTRACT §3 runtime 行）——
  // 约定挂点：context.net（传输）/ context.sim（host-sim，仅房主）/ context.puppet
  // （仅客户端）/ context.remotes（remote-players，所有联机端；另挂 remotePlayers 别名
  // 防并行集成取名漂移）/ context.netPlayers()（本地单例+远端化身统一视图，§2.3 注）。
  let mpWorldSeed = +(params.seed || 4207); // 当前世界实际所用种子（与 context.rng 同源）
  let mpRoomSeed = null; // 房间握手所得种子（未握手 = null → 单机默认世界）
  let mpBuildBusy = !1,
    mpBuildQueued = null;
  // —— 对抗模式流程换装（MP-PVP §8.2 runtime 行）——
  // mpFlowKind 记录 context.game 当前外壳（'coop'|'pvp'）；mpFlowDetach 持有该流程
  // 构造期间注册的全部 net 订阅的卸载器——换装时先卸旧订阅再摘旧菜单 DOM，旧流程
  // 状态机停留在 title 自然静默（其事件处理均有 state 门），杜绝幽灵 start/restart。
  let mpFlowKind = "",
    mpFlowDetach = null;
  function mpNetActive() {
    // net 存在且不在离线态（含 connecting：URL 驱动建房的预留位）
    let n = context.net;
    return !!(n && !n.stub && n.mode != "offline");
  }
  function mpNetOnline() {
    let n = context.net;
    if (!n || n.stub || typeof n.connected != "function") return !1;
    try {
      return !!(
        n.connected() &&
        n.mode != "offline" &&
        n.mode != "connecting"
      );
    } catch {
      return !1;
    }
  }
  // 房间 seed 由握手结果写入 params.seed（契约 §3）；与当前世界不一致 → 晚建关
  function mpCaptureRoomSeed(result) {
    let seed = result && result.seed;
    seed = Number.isSafeInteger(+seed) ? +seed : null;
    if (seed == null) return;
    ((mpRoomSeed = seed), (params.seed = seed));
    seed !== mpWorldSeed && mpScheduleWorldRebuild(seed);
  }
  function mpScheduleWorldRebuild(seed) {
    ((mpBuildQueued = seed), mpBuildBusy) ||
      ((mpBuildBusy = !0),
      (async () => {
        for (; mpBuildQueued != null; ) {
          let s = mpBuildQueued;
          mpBuildQueued = null;
          s !== mpWorldSeed && (await mpRebuildWorld(s));
        }
        mpBuildBusy = !1;
      })());
  }
  // 晚建关：握手后才拿到房间 seed → 重建确定性世界（同 seed ⇒ 同关卡，蓝图 ②）。
  // 建关步骤逐字对齐 boot：新 rng → 清旧碰撞盒（快照备份防建关失败）→ createLevel
  // → 摘除旧关卡 → physics.build → 玩家落新出生点 → onLevelReady。
  async function mpRebuildWorld(seed) {
    let old = context.level,
      boxes = context.physics && context.physics.boxes,
      backup = Array.isArray(boxes) ? boxes.slice() : null;
    try {
      ((params.seed = seed), (context.rng = createRandom(seed)));
      backup && (boxes.length = 0);
      let fresh = await createLevel(context);
      old &&
        old.root &&
        context.scene &&
        context.scene.remove(old.root); // 旧世界仅摘除；材质系全局共享不 dispose
      ((context.level = fresh),
        context.physics.build && context.physics.build(),
        (mpWorldSeed = seed));
      fresh.playerStart &&
        context.player &&
        context.player.reset &&
        context.player.reset(fresh.playerStart);
      try {
        await context.render.onLevelReady();
      } catch {}
      console.log(`[mp] 房间种子 ${seed} 生效，港区已按同源种子重建`);
    } catch (e) {
      console.error("[mp] 房间种子建关失败，沿用旧世界（地图可能不同步）:", e);
      try {
        if (backup) {
          boxes.length = 0;
          for (let b of backup) boxes.push(b);
        }
        context.physics.build && context.physics.build();
      } catch {}
    }
  }
  function mpEnsureRoomWorld() {
    // 开局兜底：握手种子尚未落地（异常时序）时于建关前补检一次
    mpRoomSeed != null &&
      mpRoomSeed !== mpWorldSeed &&
      !mpBuildBusy &&
      (console.warn("[mp] 开局时房间种子尚未建关，补行重建（时序兜底）"),
      mpScheduleWorldRebuild(mpRoomSeed));
  }
  // net 装配收尾：统一玩家视图 + 种子捕获包装 + 开局种子兜底订阅
  function mpSetupNet() {
    // 统一玩家视图（§2.3 注：context.netPlayers —— 本地单例 + remote-players 全家福）。
    // 兼容两种消费形态：player.js 按函数调用；enemies.js 按 .list() 取数组。
    let netPlayersView = function () {
      let out = [],
        n = context.net,
        selfId = n && !n.stub && n.selfId ? n.selfId() : null,
        pl = context.player;
      if (pl && pl.pos)
        out.push({
          id: selfId != null ? selfId : "local",
          name: pl.name || "",
          you: !0,
          local: !0,
          pos: pl.pos,
          yaw: pl.yaw || 0,
          pitch: pl.pitch || 0,
          hp: pl.health != null ? pl.health : 100,
          alive: pl.alive !== !1,
          aboard: !!pl.aboard,
          crouch: !!pl.crouching,
          sprint: !!pl.sprinting,
          ads: !!pl.ads,
        });
      let rp = context.remotes;
      if (rp && typeof rp.list == "function") {
        let list = [];
        try {
          list = rp.list();
        } catch {}
        for (let i = 0; i < list.length; i++) out.push(list[i]);
      }
      return out;
    };
    netPlayersView.list = function () {
      try {
        return netPlayersView();
      } catch {
        return [];
      }
    };
    context.netPlayers = netPlayersView;
    let net = context.net;
    if (!net || net.stub) return;
    for (let op of ["createRoom", "joinRoom"]) {
      // 建房/加入是房间 seed 的唯一入口：包装握手 Promise，种子先行落 params
      let raw = net[op];
      if (typeof raw != "function") continue;
      net[op] = function (...args) {
        return Promise.resolve(raw.apply(net, args)).then(
          (r) => (mpCaptureRoomSeed(r), r),
          (e) => {
            throw e;
          },
        );
      };
    }
    typeof net.on == "function" &&
      (net.on("start", mpEnsureRoomWorld),
      net.on("restart", mpEnsureRoomWorld),
      // 房间模式回显即时换装（帧级对账之外的快路径：建房/加入当拍生效）
      net.on("roomState", () => mpSyncGameFlow()),
      net.on("phase", () => mpSyncGameFlow()));
  }
  // 按 net.mode 条件装配（契约 §3）：host=host-sim+remote-players；
  // client=puppet+remote-players；offline=皆无。host-sim/puppet 各只建一次
  // （内部订阅无法摘除，复用实例靠角色静默；remote-players 有 dispose 可重建）。
  function mpSyncRoleModules() {
    let net = context.net;
    if (!net || net.stub) return;
    let online = mpNetOnline(),
      host = !1;
    try {
      host = online && !!net.isHost();
    } catch {}
    online &&
      !context.remotes &&
      ((context.remotes = createRemotePlayers(context, net)),
      (context.remotePlayers = context.remotes));
    !online &&
      context.remotes &&
      (context.remotes.dispose && context.remotes.dispose(),
      (context.remotes = null),
      (context.remotePlayers = null));
    online && host && !context.sim
      ? ((context.sim = createHostSim(context, net, {
          players: () => net.players(),
        })),
        // 兼容别名：enemies.js 读 net.sim/net.hostSim；player/combat 读
        // context.netSim/context.hostSim —— 装配方一次性全挂，防集成取名漂移
        (context.netSim = context.sim),
        (context.hostSim = context.sim),
        (net.sim = context.sim),
        (net.hostSim = context.sim))
      : 0;
    online && !host && !context.puppet
      ? (context.puppet = createEnemyPuppet(context, net))
      : 0;
    (!online || host) &&
      context.puppet &&
      (context.puppet.setEnabled && context.puppet.setEnabled(!1),
      context.puppet.clear && context.puppet.clear(),
      (context.puppet = null),
      context.enemies &&
        !context.enemies.stub &&
        ((context.enemies.puppetMode = !1),
        (context.enemies.isPuppet = !1)));
  }
  // 对抗模式流程换装（MP-PVP §8.2）：pvp 房间 → createPvpFlow；离场/合作 → createGameFlow。
  // 房间在游戏运行前（大厅期）换装：此时旧流程停在 title，无副作用窗口。
  function mpRoomIsPvp() {
    let n = context.net;
    if (!n || n.stub) return !1;
    let m = n.mode;
    if (m == "offline" || m == "connecting") return !1;
    if (typeof n.roomMode != "function") return !1;
    try {
      return n.roomMode() == "pvp";
    } catch {
      return !1;
    }
  }
  // 流程构造捕获面：期间注册的 net.on / net.client.onHostPayload / net.host.onClientPayload
  // 全部记账，换装时逐项卸除（net 侧 on/off/onHostPayload 均提供卸载语义）。
  function mpCaptureFlowNet(make) {
    let net = context.net,
      rawOn = net && net.on,
      rawChp = net && net.client && net.client.onHostPayload,
      rawHcp = net && net.host && net.host.onClientPayload;
    if (
      !net ||
      net.stub ||
      typeof rawOn != "function" ||
      typeof net.off != "function"
    )
      return {
        flow: make(),
        detach: null,
      }; // 无捕获面（离线兜底网）：调用方拒绝后续换装即可
    let evts = [],
      unsubs = [],
      restore = () => {
        ((net.on = rawOn),
          rawChp && net.client && (net.client.onHostPayload = rawChp),
          rawHcp && net.host && (net.host.onClientPayload = rawHcp));
      };
    ((net.on = function (evt, fn) {
      evts.push([evt, fn]);
      return rawOn.call(net, evt, fn);
    }),
      rawChp &&
        (net.client.onHostPayload = function (fn) {
          let off = rawChp.call(net.client, fn);
          return (
            typeof off == "function" && unsubs.push(off),
            function () {
              try {
                off();
              } catch {}
              let i = unsubs.indexOf(off);
              i >= 0 && unsubs.splice(i, 1);
            }
          );
        }),
      rawHcp &&
        (net.host.onClientPayload = function (fn) {
          let off = rawHcp.call(net.host, fn);
          return (
            typeof off == "function" && unsubs.push(off),
            function () {
              try {
                off();
              } catch {}
              let i = unsubs.indexOf(off);
              i >= 0 && unsubs.splice(i, 1);
            }
          );
        }));
    let flow = null;
    try {
      flow = make();
    } catch (e) {
      for (; evts.length; ) {
        let it = evts.pop();
        try {
          net.off(it[0], it[1]);
        } catch {}
      }
      for (; unsubs.length; )
        try {
          unsubs.pop()();
        } catch {}
      throw (restore(), e);
    }
    return (
      restore(),
      {
        flow: flow,
        detach: function () {
          for (let it of evts)
            try {
              net.off(it[0], it[1]);
            } catch {}
          for (; unsubs.length; )
            try {
              unsubs.pop()();
            } catch {}
        },
      }
    );
  }
  function mpInstallFlow(made, kind) {
    ((context.game = made.flow),
      (mpFlowDetach = made.detach),
      (mpFlowKind = kind));
  }
  function mpAssembleGameFlow() {
    if (!mpRoomIsPvp()) {
      // offline/coop 主路径：行为与旧装配逐字一致（仅多一层订阅记账）
      mpInstallFlow(mpCaptureFlowNet(() => createGameFlow(context)), "coop");
      return;
    }
    try {
      mpInstallFlow(mpCaptureFlowNet(() => createPvpFlow(context)), "pvp");
    } catch (e) {
      console.error("[mp] 对抗流程装配失败，回退合作流程:", e);
      mpInstallFlow(mpCaptureFlowNet(() => createGameFlow(context)), "coop");
    }
  }
  function mpSyncGameFlow() {
    if (showcaseName) return; // showcase 分支无 game flow（契约 §3）
    let net = context.net;
    if (!net || net.stub) return;
    let wantPvp = mpRoomIsPvp();
    if (wantPvp === (mpFlowKind == "pvp")) return;
    if (wantPvp && typeof createPvpFlow != "function") return;
    let old = context.game;
    if (old && !mpFlowDetach) {
      // 现役流程无卸载面（离线兜底网装配）：拒绝换装防幽灵订阅
      console.warn("[mp] 现役流程无订阅卸载面，跳过对抗流程换装");
      return;
    }
    let made = null;
    try {
      made = mpCaptureFlowNet(() =>
        wantPvp ? createPvpFlow(context) : createGameFlow(context),
      );
    } catch (e) {
      return void console.error("[mp] 流程换装失败，维持现役流程:", e);
    }
    try {
      mpFlowDetach && mpFlowDetach();
    } catch {}
    try {
      old &&
        old.menus &&
        old.menus.root &&
        old.menus.root.remove(); // 旧菜单 DOM 摘除（新流程自带全新菜单实例）
    } catch {}
    mpInstallFlow(made, wantPvp ? "pvp" : "coop");
    let m = net.mode;
    if (
      (m == "lobby-host" || m == "lobby-client") &&
      made.flow &&
      made.flow.menus &&
      typeof made.flow.menus.show == "function"
    )
      try {
        made.flow.menus.show("lobby"); // 大厅期换装：新菜单直接落位大厅屏
      } catch {}
    console.log(
      "[mp] 房间模式切换 → " + (wantPvp ? "对抗流程" : "合作流程"),
    );
  }
  // 帧级次级节拍：快照消费先于本地模拟（契约：input 后 game.update 前）
  function mpFrameTick(p) {
    try {
      mpSyncRoleModules();
      mpSyncGameFlow(); // 每帧对账流程外壳（建房/加入/离场/断线的兜底触发面）
    } catch {}
    let sim = context.sim;
    if (sim && mpNetOnline() && context.net.isHost())
      try {
        sim.update(p);
      } catch {}
    let rp = context.remotes;
    if (rp)
      try {
        rp.update(p);
      } catch {}
    let pu = context.puppet;
    if (pu)
      try {
        pu.update(p);
      } catch {}
  }
  async function initializeSystem(h, f, p, d = !1) {
    let v = performance.now();
    try {
      context[h] = await p();
    } catch (x) {
      if (
        (console.error(`[boot] module "${h}" failed: ${(x && x.stack) || x}`),
        d || !FALLBACKS[h])
      )
        throw x;
      context[h] = FALLBACKS[h]();
    }
    let g = performance.now() - v;
    g > 150 && console.log(`[boot] ${h} ${g.toFixed(0)}ms`);
  }
  if (
    (await setBootProgress("正在唤醒渲染器", 0.04),
    await initializeSystem(
      "render",
      "render",
      () => createRenderer(context),
      !0,
    ),
    (context.renderer = context.render.renderer),
    (context.scene = context.render.scene),
    (context.camera = context.render.camera),
    (context.viewCamera = context.render.viewCamera),
    await setBootProgress("调和油漆、铁锈与雨水", 0.12),
    await initializeSystem("mats", "materials", () => createMaterials(context)),
    (context.physics = createPhysics(context)),
    (context.props = createProps(context)),
    (context.input = showcaseName
      ? createShowcaseInput()
      : createInput(context)),
    showcaseName)
  ) {
    let h = createMesh(
      new PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
      context.mats.get("concrete"),
      {
        cast: !1,
      },
    );
    if (
      (context.scene.add(h),
      (context.level = {
        stub: !0,
        playerStart: {
          pos: new Vector3(0, 0, 4),
          yaw: 0,
        },
        objectives: [],
        enemySpawns: [],
        zones: [],
        interiorBoxes: [],
        cinematicPath: [],
        extraction: {
          pos: new Vector3(),
          radius: 2,
        },
        groundSurfaceAt: () => "concrete",
        update() {},
      }),
      (context.backdrop = FALLBACKS.backdrop()),
      (context.ground = FALLBACKS.ground()),
      context.physics.build(),
      showcaseName === "fx")
    )
      await initializeSystem("fx", "fx", () => createEffects(context));
    else
      try {
        context.fx = await createEffects(context);
      } catch {
        context.fx = FALLBACKS.fx();
      }
    ((context.audio = FALLBACKS.audio()),
      (context.hud = FALLBACKS.hud()),
      // showcase 分支跳过 net 装配（契约 §3）；仅保留统一玩家视图离线形态
      mpSetupNet(),
      (context.player = createShowcasePlayer(context)),
      (context.combat = createCombat(context)),
      (context.weapon = FALLBACKS.weapon()),
      (context.enemies = FALLBACKS.enemies()),
      (context.game = {
        state: "showcase",
        update: () => !1,
        start() {},
      }));
    let f = null;
    try {
      f = await SHOWCASE_MODULES[showcaseName].showcase(context);
    } catch (p) {
      showFatalError(
        `showcase "${showcaseName}" threw: ${(p && p.stack) || p}`,
      );
    }
    ((context.showcaseInfo = f || {}),
      f &&
        f.cam &&
        setShot({
          cam: [...f.cam, ...(f.target || [0, 1, 0])].join(","),
        }));
  } else {
    if (
      (await setBootProgress("吊装集装箱", 0.34),
      // 晚建关种子：createLevel 前一刻取 net 握手结果（常规首启未握手 → 默认 4207）
      mpRoomSeed != null &&
        mpRoomSeed !== mpWorldSeed &&
        ((params.seed = mpRoomSeed),
        (context.rng = createRandom(mpRoomSeed)),
        (mpWorldSeed = mpRoomSeed)),
      await initializeSystem("level", "level", () => createLevel(context), !0),
      await setBootProgress("立起龙门吊", 0.5),
      await initializeSystem("backdrop", "backdrop", () =>
        createBackdrop(context),
      ),
      await setBootProgress("淹没装卸区", 0.58),
      await initializeSystem("ground", "ground", () => createGround(context)),
      context.ground.stub)
    ) {
      let h = createMesh(
        new PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
        context.mats.get("asphalt"),
        {
          cast: !1,
        },
      );
      context.scene.add(h);
    }
    (context.physics.build(),
      await setBootProgress("装填曳光弹与烟幕", 0.66),
      await initializeSystem("fx", "fx", () => createEffects(context)),
      await initializeSystem("audio", "audio", () =>
        params.noaudio ? FALLBACKS.audio() : createAudio(context),
      ),
      // 多人传输层：audio 后、player 前装配（契约 §3；失败走 FALLBACKS.net 离线兜底）
      await initializeSystem("net", "net", () => createNet(context)),
      mpSetupNet(),
      (context.player = createPlayer(context)),
      (context.combat = createCombat(context)),
      await setBootProgress("检查步枪", 0.74),
      await initializeSystem("weapon", "weapon", () => createWeapon(context)),
      await setBootProgress("唤醒港务主控", 0.82),
      await initializeSystem("enemies", "enemies", () =>
        createEnemies(context),
      ),
      await initializeSystem("hud", "hud", () => createHUD(context)),
      mpAssembleGameFlow());
  }
  await setBootProgress("等待第一缕天光", 0.92);
  try {
    await context.render.onLevelReady();
  } catch (h) {
    console.error(
      "[boot] render.onLevelReady failed: " + ((h && h.stack) || h),
    );
  }
  let averageFrameSeconds = 0;
  if (
    ((window.__stats = () => ({
      ...(context.render.stats ? context.render.stats() : {}),
      fps: averageFrameSeconds ? +(1 / averageFrameSeconds).toFixed(1) : 0,
      state: context.game && context.game.state,
    })),
    params.cam && setShot(params),
    params.fov &&
      setShot({
        fov: params.fov,
      }),
    // 联机封死截图/基准单方面开局（R5：对房间是现成副作用）
    !showcaseName && !mpNetActive() && (params.shot || params.autostart))
  )
    try {
      context.game.start({
        skipIntro: !0,
      });
    } catch (h) {
      console.error("[boot] game.start failed", h);
    }
  (params.noweapon &&
    context.weapon.setVisible &&
    context.weapon.setVisible(!1),
    benchmark && enableBenchmark(context),
    await setBootProgress("就绪", 1),
    bootElement.classList.add("done"),
    setTimeout(() => {
      bootElement.hidden = !0;
    }, 700));
  let previousFrameTime = performance.now(),
    weaponWetness = 1,
    updateSystem = (h, f) => {
      let p = context[h];
      if (p && p.update)
        try {
          p.update(f);
        } catch (d) {
          updateSystem.err[h] ||
            ((updateSystem.err[h] = 1),
            console.error(`[loop] ${h}.update threw: ${(d && d.stack) || d}`));
        }
    };
  (updateSystem.err = {});
  // —— BACKGROUND-TICK ①：帧体抽离 step(dt, opts) ——
  // 真机反馈：房主窗口被切后台 → Chrome 冻结 rAF → 整个房间模拟停摆。原 rAF
  // 循环体逐字搬入 step；opts.render===false 为联网后台降级路径：跳过纯视觉
  // 节拍（fx 粒子/ground 水面/level 场景动画/backdrop 天空/mats 材质/hud DOM/
  // render.frame/相机覆盖/wetness/bench/__frames 计数），保留 input→net→
  // mpFrameTick→game→player/weapon/enemies→audio→input.endFrame 的模拟与网络
  // 节拍——net 的 ps 15Hz 广播在 net.update 内自带照发，remote-players 插值
  // 照常消费；audio.setPaused 归 flow/pvp 的 R1 本地暂停覆盖管，此处不碰。
  // 可见路径（rAF）恒走 render:true，调用序与原版逐字一致
  // （scripts/test-background-tick.mjs 以 spy 序列守护）。
  let step = (p, opts) => {
    let render = !(opts && opts.render === !1),
      f = opts && opts.rawDt != null ? opts.rawDt : p;
    params.dt && (p = +params.dt);
    ((context.time.dt = p),
      (context.time.t += p),
      (context.time.real = ((opts && opts.now) || performance.now()) / 1e3),
      context.time.frame++,
      updateSystem("input", p),
      // net 节拍：input tick 后、game.update 前（契约 §3）——title/paused 照常
      // tick 支撑大厅与断线处理；net 内部自兜，帧循环永不断
      updateSystem("net", p),
      mpFrameTick(p));
    let d = !1;
    try {
      d =
        context.game.update(p) !== !1 &&
        context.game.state !== "title" &&
        context.game.state !== "paused";
    } catch (v) {
      updateSystem.err.game ||
        ((updateSystem.err.game = 1),
        console.error("[loop] game.update threw: " + ((v && v.stack) || v)));
    }
    if (showcaseName) {
      if (context.showcaseInfo.update)
        try {
          context.showcaseInfo.update(p);
        } catch (v) {
          updateSystem.err.sc ||
            ((updateSystem.err.sc = 1),
            console.error(
              "[loop] showcase update threw: " + ((v && v.stack) || v),
            ));
        }
    } else
      d &&
        (updateSystem("player", p),
        updateSystem("weapon", p),
        updateSystem("enemies", p));
    if (
      render &&
      context.weapon &&
      context.weapon.setWetness &&
      context.level &&
      context.level.interiorBoxes &&
      context.level.interiorBoxes[0]
    ) {
      let v = context.level.interiorBoxes[0],
        g = context.camera.position,
        x =
          g.x > v.min.x &&
          g.x < v.max.x &&
          g.z > v.min.z &&
          g.z < v.max.z &&
          g.y < v.max.y;
      weaponWetness +=
        ((x ? 0.3 : 1) - weaponWetness) * Math.min(1, p * (x ? 0.25 : 0.6));
      try {
        context.weapon.setWetness(weaponWetness);
      } catch {}
    }
    (render &&
      context.game.state !== "paused" &&
      (updateSystem("fx", p),
      updateSystem("ground", p),
      updateSystem("level", p),
      updateSystem("backdrop", p),
      updateSystem("mats", p)),
      updateSystem("audio", p),
      render && updateSystem("hud", p),
      render &&
        cameraOverride &&
        (context.camera.position.copy(cameraOverride.pos),
        context.camera.lookAt(cameraOverride.look)),
      render && context.bench && context.bench.frame(f));
    if (render)
      try {
        context.render.frame(p);
      } catch (v) {
        updateSystem.err.render ||
          ((updateSystem.err.render = 1),
          console.error("[loop] render.frame threw: " + ((v && v.stack) || v)));
      }
    (context.input.endFrame && context.input.endFrame(),
      render &&
        (window.__frames++, window.__frames === 2 && (window.__ready = !0)));
  };
  // —— BACKGROUND-TICK ②：联网后台保活接线 ——
  // 联网（net 非 offline/stub）且 document.hidden 时启动 tick-worker（模块
  // Worker，setInterval 15ms 心跳不受后台标签节流）驱动降级帧；visibilitychange
  // 回可见即停 worker、回 rAF；worker 消息处理时再验 document.hidden 严防双
  // 驱动。离线单机不启用（后台暂停是单机预期行为，保持）。Worker 创建失败
  // （file:// 或 CSP）→ console.info 一条后静默维持现状（后台就冻结），不重试。
  let bgTick = { worker: null, last: 0, failed: !1 };
  function bgCreateWorker() {
    try {
      return new Worker(new URL("./tick-worker.js", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      return (
        console.info(
          "[bg-tick] Worker 创建失败（file:// 或 CSP？），联网后台保活不可用，维持现状冻结: " +
            ((e && e.message) || e),
        ),
        null
      );
    }
  }
  function bgTickMessage() {
    if (!document.hidden || !mpNetActive()) return; // 双驱动防御：可见时 rAF 主场
    let now = performance.now(),
      dtMs = Math.min(100, Math.max(20, now - bgTick.last)); // dt 钳 20-100ms
    bgTick.last = now;
    try {
      step(dtMs / 1e3, { render: !1, now: now });
    } catch (e) {
      updateSystem.err.bgtick ||
        ((updateSystem.err.bgtick = 1),
        console.error("[bg-tick] 后台帧抛错: " + ((e && e.stack) || e)));
    }
  }
  function bgTickStart() {
    if (bgTick.worker || bgTick.failed || !document.hidden || !mpNetActive())
      return;
    let w = bgCreateWorker();
    if (!w) return void (bgTick.failed = !0);
    ((w.onmessage = bgTickMessage),
      (w.onerror = function () {
        (console.info("[bg-tick] Worker 加载失败，联网后台保活退回现状冻结"),
          bgTickStop(),
          (bgTick.failed = !0));
      }),
      (bgTick.worker = w),
      (bgTick.last = performance.now()),
      w.postMessage("start"),
      console.info("[bg-tick] 联网后台保活已启用（15ms 心跳降级帧）"));
  }
  function bgTickStop() {
    let w = bgTick.worker;
    if (!w) return;
    ((bgTick.worker = null), w.postMessage("stop"));
    try {
      w.terminate(); // stop 消息尽力而为，terminate 兜底必停
    } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    document.hidden ? bgTickStart() : bgTickStop();
  });
  context.renderer.setAnimationLoop(() => {
    let h = performance.now(),
      f = (h - previousFrameTime) / 1e3;
    ((previousFrameTime = h),
      (averageFrameSeconds = averageFrameSeconds
        ? averageFrameSeconds * 0.95 + f * 0.05
        : f));
    step(Math.min(f, 0.05), { render: !0, rawDt: f, now: h });
  });
  document.hidden && bgTickStart(); // 极端时序：起播即处后台（如标签页会话恢复）
}

export { startGame };
