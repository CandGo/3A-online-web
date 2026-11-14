// src/net/remote-players.js — 远端玩家化身模块（MP 契约 §2.4，代号 R；MP-PVP §8.3 升级件）
//
// 职责：把网络侧传来的玩家位姿（ps/peers 消息）渲染成多关节士兵化身（avatar.js 构建件），
// 并提供开火/换弹/阵亡/受击的表现入口（host-sim / 集成层显式调用，防事件桥回环）。
//
// 契约要点（MP-CONTRACT §2.4 + MP-PVP §8.3）：
//   - 化身 = avatar.js 多关节士兵（靴/腿双关节/腰胯/背心/肩臂肘/颈/头盔/背囊，~1.8m）；
//     位色染背心+头盔，其余深色装备；全部 MeshStandardMaterial 纯色，绝不新建纹理文件；
//     THREE 一律取自 context.THREE。名牌/插值/航位推测/事件通道与 P0 完全一致，只换视觉件。
//   - 插值：100ms 缓冲 hermite 位置插值；yaw/pitch 最短弧；vel 航位推测外推上限 250ms。
//   - flags（ps 载荷 fl 位集，按契约 ③ 顺序 crouch|sprint|ads|alive|aboard|fire）：
//       bit0 crouch bit1 sprint bit2 ads bit3 alive bit4 aboard(隐身) bit5 fire(枪口闪+后坐)
//   - 数据面：client 端消费 net.client.onHostPayload 的 {k:"peers", states}；
//     host 端消费 net.host.onClientPayload 的 (playerId, {k:"ps"})（同一 ingest 通道）。
//     绝不向 context.events 发射任何事件（回环铁律）。
//   - update(dt) 全程自兜 try/catch；dispose 释放全部化身几何/材质/画布。

import { createAvatar } from "./avatar.js";

var BUFFER_MS = 100; // 插值缓冲：渲染时刻落后最新采样 100ms
var EXTRAP_MAX_MS = 250; // 航位推测外推上限
var SAMPLE_KEEP = 24; // 每位玩家最多保留采样数
var SAMPLE_STALE_S = 1.5; // 早于该时长的采样在更新时清理
var PEER_TIMEOUT_S = 6; // 超时未见 ps → 移除化身
var TAG_HIDE_M = 20; // 名牌可见距离
// ps 以 15Hz 发送，ev.fire 与下一帧 fl.fire 可能跨越 120ms 到达；
// 留出一个完整的网络抖动窗口，避免同一发被两条通道重复表现。
var FIRE_SUPPRESS_S = 0.35; // playFire 后抑制 fl.fire 重复闪光的窗口
var FIRE_KICK_S = 0.16; // 开火后坐姿态时长（与 avatar.js RECOIL_DUR 对齐）

// ps 载荷 fl 位集（与契约 ③ 字段顺序一致）
var FL_CROUCH = 1;
var FL_SPRINT = 2;
var FL_ADS = 4;
var FL_ALIVE = 8;
var FL_ABOARD = 16;
var FL_FIRE = 32;

// 玩家位 0-3 固定四色（青/橙/紫/黄——高饱和亮色，与港区蓝灰钢构+暗安全橙主视觉拉开）
var SLOT_COLORS = [0x2ee6d6, 0xff8a3c, 0xb45cff, 0xffd84d];

var RIFLE_RANGE = 300; // 与 weapon.js 命中距离口径一致（tracer 终点兜底）
var TAU = Math.PI * 2;

function nowS() {
  return performance.now() / 1000;
}

// 最短弧差 (-π, π]
function angleDelta(a, b) {
  var d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function toVec3(T, v) {
  // 载荷 pos/vel 可能是 [x,y,z] 数组、类 Vector3 或缺失
  if (!v) return null;
  if (typeof v.x === "number") return new T.Vector3(v.x, v.y || 0, v.z || 0);
  if (Array.isArray(v) && v.length >= 2)
    return new T.Vector3(+v[0] || 0, +v[1] || 0, +v[2] || 0);
  return null;
}

export function createRemotePlayers(context, net) {
  var T = context && context.THREE;
  if (!T || !T.Group) {
    // 无 THREE（极端兜底）：返回全兼容空实现，集成层无感
    console.warn("[mp:remote-players] context.THREE 缺失，化身降级为空实现");
    var stub = {
      update: function () {},
      count: function () {
        return 0;
      },
      list: function () {
        return [];
      },
      byId: function () {
        return null;
      },
      setColorMap: function () {},
      colorOf: function () {
        return 0xffffff;
      },
      playFire: function () {},
      playReload: function () {},
      playDeath: function () {},
      playHit: function () {},
      nametag: function () {},
      dispose: function () {},
    };
    return stub;
  }

  var scene = context.scene || null;
  var camera = function () {
    return context.camera;
  };
  var disposed = false;
  var lastWarnAt = -9;
  var fireVariant = 0;
  var colorMapFn = null; // setColorMap 覆盖：fn(id, slot) → 颜色 hex（可返回空走默认）
  var peers = new Map(); // id → peer
  var peersOrder = []; // 首见顺序（无 roster 时的 slot 兜底）
  var pendingNames = new Map(); // nametag() 先于化身到达时暂存
  var slotSeed = 0;

  // ---- 共享材质（全部化身共用深色装备件；位色件由 avatar.js 每化身自建）----
  var matFatigues = new T.MeshStandardMaterial({
    color: 0x2a3138, // 作战服（四肢/颈）
    roughness: 0.85,
    metalness: 0.22,
  });
  var matGear = new T.MeshStandardMaterial({
    color: 0x1a2126, // 装具（靴/护膝/腰胯/肩甲/背囊/手/枪托）
    roughness: 0.7,
    metalness: 0.35,
  });
  var matDark = new T.MeshStandardMaterial({
    color: 0x10151a, // 深色金属（枪身/护目镜/战术板）
    roughness: 0.55,
    metalness: 0.5,
  });

  function colorOfDefault(id, slot) {
    if (colorMapFn) {
      try {
        var c = colorMapFn(id, slot);
        if (typeof c === "number") return c;
      } catch {}
    }
    return SLOT_COLORS[((slot % SLOT_COLORS.length) + SLOT_COLORS.length) % SLOT_COLORS.length];
  }

  function rosterPlayers() {
    try {
      var r = net && net.players && net.players();
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  function selfId() {
    try {
      return net && net.selfId ? net.selfId() : null;
    } catch {
      return null;
    }
  }

  function rosterSlotOf(id) {
    var list = rosterPlayers();
    for (var i = 0; i < list.length; i++)
      if (list[i] && list[i].id === id) return i;
    return -1;
  }

  function rosterNameOf(id) {
    var list = rosterPlayers();
    for (var i = 0; i < list.length; i++)
      if (list[i] && list[i].id === id) return list[i].name || "";
    return "";
  }

  function pvpTagVisible(id) {
    var mode = null;
    try {
      mode = net && typeof net.roomMode === "function" ? net.roomMode() : null;
    } catch {}
    if (mode !== "pvp") return true;
    var mine = null;
    try {
      mine = net && typeof net.myTeam === "function" ? net.myTeam() : null;
    } catch {}
    if (mine !== 0 && mine !== 1) return false;
    var list = rosterPlayers();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id)
        return list[i].team === 0 || list[i].team === 1 ? list[i].team === mine : false;
    }
    return false;
  }

  // ---- 名牌（canvas 256x64，独立实现，不碰 textures.js）----
  function makeTag(colorHex) {
    if (typeof document === "undefined") return null;
    try {
      var cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 64;
      var ctx = cv.getContext("2d");
      var tex = new T.CanvasTexture(cv);
      tex.anisotropy = 1;
      var mat = new T.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      var sp = new T.Sprite(mat);
      sp.scale.set(1.4, 0.35, 1);
      sp.center.set(0.5, 0);
      sp.position.set(0, 2.08, 0);
      sp.renderOrder = 5;
      var col = new T.Color(colorHex);
      var tag = {
        sprite: sp,
        material: mat,
        texture: tex,
        canvas: cv,
        ctx: ctx,
        cssColor: "#" + col.getHexString(),
        lastText: "",
        lastDrawAt: -9,
        drawn: false,
      };
      sp.userData.rpTag = tag;
      return tag;
    } catch {
      return null;
    }
  }

  function drawTag(peer, distText, force) {
    var tag = peer.tag;
    if (!tag || !tag.ctx) return;
    var now = nowS();
    var text = peer.name + "|" + distText;
    if (!force && text === tag.lastText && tag.drawn) return;
    if (!force && now - tag.lastDrawAt < 0.2) return;
    tag.lastText = text;
    tag.lastDrawAt = now;
    tag.drawn = true;
    var ctx = tag.ctx;
    ctx.clearRect(0, 0, 256, 64);
    // 底板：左色条 + 半透明深底（硬核港区军事风铭牌）
    ctx.fillStyle = "rgba(8,13,18,0.78)";
    ctx.fillRect(10, 4, 236, 56);
    ctx.fillStyle = tag.cssColor;
    ctx.fillRect(10, 4, 5, 56);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    var name = (peer.name || "").slice(0, 14);
    ctx.font = "bold 16px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = tag.cssColor;
    ctx.fillText(name, 24, 24);
    ctx.font = "12px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(178,196,209,0.95)";
    ctx.fillText(distText, 24, 45);
    tag.texture.needsUpdate = true;
  }

  // ---- 化身构建：视觉件全部来自 avatar.js 多关节士兵 ----
  function createPeer(id) {
    var slot = rosterSlotOf(id);
    if (slot < 0) slot = peersOrder.length + slotSeed++;
    var colorHex = colorOfDefault(id, slot);

    // 多关节士兵（位色染背心+头盔；几何/位色材质归化身自管，dispose 一并释放）
    var avatar = createAvatar(T, { fatigues: matFatigues, gear: matGear, dark: matDark }, {
      color: colorHex,
      castShadow: true,
    });
    if (!avatar) {
      // 极端兜底（THREE 部件缺席）：空壳组保名牌/插值面不塌
      var shell = new T.Group();
      avatar = {
        root: shell,
        applyPose: function () {},
        setVisible: function (b) {
          shell.visible = !!b;
        },
        setColor: function () {},
        setHitFlash: function () {},
        dispose: function () {},
      };
    }
    var root = avatar.root;
    root.name = "mp_peer_" + id;

    var tag = makeTag(colorHex);
    if (tag) root.add(tag.sprite);
    if (scene && scene.add) {
      try {
        scene.add(root);
      } catch {}
    }

    var name = rosterNameOf(id);
    if (!name && pendingNames.has(id)) name = pendingNames.get(id);

    var peer = {
      id: id,
      slot: slot,
      name: name,
      color: colorHex,
      root: root,
      avatar: avatar,
      tag: tag,
      // 网络采样与插值状态
      samples: [], // {at, pos:Vector3, vel:Vector3, yaw, pitch}
      cur: {
        pos: new T.Vector3(0, 0, 0),
        yaw: 0,
        pitch: 0,
      },
      hp: 100,
      flags: {
        crouch: false,
        sprint: false,
        ads: false,
        alive: true,
        aboard: false,
      },
      lastSeq: null,
      lastSampleAt: nowS(),
      lastFireAt: -9,
      // 表现动画状态（倒伏计时归 avatar 内部，这里只留驱动量）
      deathPlayed: false,
      hitT: 0,
      reloadT: 0,
      fireT: 0, // 开火后坐剩余秒（playFire / fl.fire 上升沿置 FIRE_KICK_S）
      speed: 0, // 平面速度（插值位姿差分+平滑，喂 avatar 步态）
      vy: 0, // 垂直速度（喂 avatar 着地检测）
      lastPos: null,
      lastTagDistText: "",
    };
    peersOrder.push(id);
    if (tag) drawTag(peer, "--m", true);
    return peer;
  }

  function removePeer(id, dropName) {
    var peer = peers.get(id);
    if (!peer) return;
    try {
      if (peer.root.parent && peer.root.parent.remove)
        peer.root.parent.remove(peer.root);
      else if (scene && scene.remove) scene.remove(peer.root);
    } catch {}
    try {
      if (peer.avatar) peer.avatar.dispose(); // 几何+位色材质（共享深色件不在此释放）
    } catch {}
    peer.avatar = null;
    if (peer.tag) {
      try {
        peer.tag.material.dispose();
        peer.tag.texture.dispose();
      } catch {}
      peer.tag.canvas = null;
      peer.tag.ctx = null;
      peer.tag = null;
    }
    peers.delete(id);
    var i = peersOrder.indexOf(id);
    if (i >= 0) peersOrder.splice(i, 1);
    if (dropName) pendingNames.delete(id);
  }

  function clearAll() {
    var ids = Array.from(peers.keys());
    for (var i = 0; i < ids.length; i++) removePeer(ids[i], false);
  }

  // ---- 采样摄入（peers 批量 / host 侧单条 ps 共用）----
  function ingestState(state, now) {
    if (!state || disposed) return;
    var id = state.id;
    if (!id || id === selfId()) return;
    var peer = peers.get(id);
    if (!peer) {
      peer = createPeer(id);
      peers.set(id, peer);
    }
    // ps 带 seq：丢弃乱序/重复（房主重启可能重置 seq——采样已陈旧时放行）
    if (
      typeof state.seq === "number" &&
      typeof peer.lastSeq === "number" &&
      state.seq <= peer.lastSeq &&
      now - peer.lastSampleAt < 2
    )
      return;
    if (typeof state.seq === "number") peer.lastSeq = state.seq;

    var pos = toVec3(T, state.pos);
    if (pos) {
      var vel = toVec3(T, state.vel) || new T.Vector3(0, 0, 0);
      peer.samples.push({
        at: now,
        pos: pos,
        vel: vel,
        yaw: +state.yaw || 0,
        pitch: +state.pitch || 0,
      });
      if (peer.samples.length > SAMPLE_KEEP) peer.samples.shift();
      peer.cur.pos.copy(pos);
      peer.cur.yaw = +state.yaw || 0;
      peer.cur.pitch = +state.pitch || 0;
    }
    peer.lastSampleAt = now;

    // 名字迟到补齐（大厅内 setName / roster 后到）
    if (!peer.name) {
      var rn = rosterNameOf(id);
      if (rn) {
        peer.name = rn;
        if (peer.tag) drawTag(peer, peer.lastTagDistText || "--m", true);
      }
    }

    // flags 解析（fl 缺席时按存活兜底）
    var fl = state.fl;
    var has = typeof fl === "number";
    var f = peer.flags;
    var wasAlive = f.alive;
    f.crouch = has && !!(fl & FL_CROUCH);
    f.sprint = has && !!(fl & FL_SPRINT);
    f.ads = has && !!(fl & FL_ADS);
    f.alive = has ? !!(fl & FL_ALIVE) : true;
    f.aboard = has && !!(fl & FL_ABOARD);
    if (typeof state.hp === "number") peer.hp = state.hp;

    if (!f.alive && wasAlive) startDeath(peer);
    if (f.alive && !wasAlive) revivePeer(peer);

    // fl.fire 上升沿：一帧枪口闪（playFire 已在近期触发过则跳过防双闪）
    if (has && fl & FL_FIRE && !peer.fireSeen) {
      peer.fireSeen = true;
      if (now - peer.lastFireAt > FIRE_SUPPRESS_S) miniMuzzleFlash(peer);
    }
    if (!(has && fl & FL_FIRE)) peer.fireSeen = false;
  }

  function onHostPayload(payload) {
    if (disposed || !payload) return;
    if (payload.k === "ev") {
      // 客户端会收到房主转发的完整事件；自己的上行事件也可能被房主
      // 原样广播回来，不能把第一人称火光再当成远端化身火光播放一次。
      var self = selfId();
      if (payload.id != null && self != null && String(payload.id) === String(self))
        return;
      if (payload.e === "fire") playFire(payload.id, payload.o, payload.d);
      else if (payload.e === "reload") playReload(payload.id);
      return;
    }
    if (payload.k === "cb") {
      if (payload.e === "impact") playImpact(payload);
      else if (payload.e === "hitEnemy") playImpact({
        point: payload.point,
        normal: payload.dir,
        dir: payload.dir,
        surface: "enemy",
      });
      return;
    }
    if (payload.k !== "peers") return;
    var now = nowS();
    var states = payload.states;
    if (!Array.isArray(states)) return;
    for (var i = 0; i < states.length; i++) ingestState(states[i], now);
  }

  function onClientPayload(playerId, payload) {
    // host 端：客户端 ps / 表现事件都从 toHost 单条直达。
    // 之前这里只消费 ps，导致房主能看到队友移动，却看不到队友枪口火光。
    if (disposed || !payload) return;
    if (payload.k === "ps") {
      ingestState(payload, nowS());
      return;
    }
    var id = payload.id != null ? payload.id : playerId;
    if (payload.k === "ev") {
      if (payload.e === "fire") playFire(id, payload.o, payload.d);
      else if (payload.e === "reload") playReload(id);
    } else if (payload.k === "cb") {
      if (payload.e === "impact") playImpact(payload);
      else if (payload.e === "hitEnemy")
        playImpact({
          point: payload.point,
          normal: payload.dir,
          dir: payload.dir,
          surface: "enemy",
        });
    }
  }

  // ---- 网络挂接（全部防御式，缺席即静默）----
  try {
    if (net && net.client && typeof net.client.onHostPayload === "function")
      net.client.onHostPayload(onHostPayload);
  } catch {}
  try {
    if (net && net.host && typeof net.host.onClientPayload === "function")
      net.host.onClientPayload(onClientPayload);
  } catch {}
  try {
    if (net && typeof net.on === "function") {
      net.on("peerLeave", function (p) {
        // net.js 实际载荷为 {player:{id,...}, kind}；兼容裸 id 与 {id} 形态
        var id =
          p && p.player && p.player.id !== undefined
            ? p.player.id
            : p && p.id !== undefined
              ? p.id
              : p;
        if (typeof id === "string" || typeof id === "number")
          removePeer(String(id), false);
      });
      net.on("start", function () {
        clearAll(); // 开局：清场（大厅期本无化身，防御旧局残留）
      });
      net.on("restart", function () {
        clearAll(); // 重新部署：旧尸体/旧化身全部清场
      });
      net.on("hostGone", function () {
        clearAll();
      });
    }
  } catch {}

  // ---- 表现入口 ----
  function normalizeDir(dir) {
    var v = toVec3(T, dir);
    if (!v || v.lengthSq() < 1e-8) return null;
    return v.normalize();
  }

  function cameraDistTo(pos) {
    var cam = camera();
    if (!cam || !cam.position) return 0;
    var dx = pos.x - cam.position.x;
    var dy = pos.y - cam.position.y;
    var dz = pos.z - cam.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // 枪口世界位：优先化身真枪口节点（avatar.muzzleWorld，PAC-9 移植后枪口
  // 与视觉枪严格一致），化身缺席/未挂枪时退回 payload 眼位偏移推算
  function muzzleWorld(peer, origin) {
    try {
      if (peer && peer.avatar && peer.avatar.muzzleWorld) {
        var m = peer.avatar.muzzleWorld(new T.Vector3());
        if (m) return m;
      }
    } catch {}
    var yaw = peer ? peer.cur.yaw : 0;
    var rx = Math.cos(yaw) * 0.24;
    var rz = -Math.sin(yaw) * 0.24;
    return new T.Vector3(origin.x + rx, origin.y - 0.26, origin.z + rz);
  }

  function poseFireDir(peer, out) {
    // fl.fire 只有位姿快照，没有 ev.fire 的散布方向；按远端 yaw/pitch
    // 还原枪口朝向，避免兜底闪光永远沿世界 -Z 指向画面中央。
    var yaw = peer ? peer.cur.yaw : 0;
    var pitch = peer ? peer.cur.pitch : 0;
    var cp = Math.cos(pitch);
    return out.set(
      Math.sin(yaw) * cp,
      -Math.sin(pitch),
      -Math.cos(yaw) * cp,
    ).normalize();
  }

  function miniMuzzleFlash(peer) {
    // fl.fire 的一帧枪口闪：优先灯光池（真·一帧），退化为 fx.muzzleFlash 小尺度
    peer.fireT = FIRE_KICK_S; // 后坐姿态（avatar 内 kick 衰减）
    try {
      var p = muzzleWorld(peer, peer.cur.pos.clone().setY(peer.cur.pos.y + 1.55));
      var lp = context.render && context.render.lightPool;
      if (lp && typeof lp.flash === "function") {
        lp.flash(p, 16756832, 14, 6, 0.04);
        return;
      }
      var fx = context.fx;
      if (fx && typeof fx.muzzleFlash === "function")
        fx.muzzleFlash(p, poseFireDir(peer, new T.Vector3()), { scale: 0.5 });
    } catch {}
  }

  function startDeath(peer) {
    var first = !peer.deathPlayed; // flags 上升沿与显式 playDeath 双触发时，音效只出一次
    peer.deathPlayed = true;
    if (peer.tag) peer.tag.sprite.visible = false;
    if (first) {
      try {
        var a = context.audio;
        if (a && typeof a.play === "function")
          a.play("death", { gain: 0.45 });
      } catch {}
    }
  }

  function revivePeer(peer) {
    peer.deathPlayed = false;
    // 倒伏姿态由 avatar 在下一帧存活 applyPose 自愈复位
    if (peer.tag) peer.tag.sprite.visible = true;
  }

  function playFire(id, origin, dir) {
    if (disposed) return;
    try {
      var o = toVec3(T, origin);
      var d = normalizeDir(dir);
      if (!o || !d) return;
      var peer = peers.get(id);
      var now = nowS();
      if (peer) {
        peer.lastFireAt = now;
        peer.fireT = FIRE_KICK_S; // 远端开火后坐姿态
      }

      // tracer 终点：优先沿弹道做一次纯视觉 raycast（不产生伤害），失败落到最大射程
      var end = null;
      try {
        var ph = context.physics;
        if (ph && typeof ph.raycast === "function") {
          var hit = ph.raycast(o, d, RIFLE_RANGE);
          if (hit && hit.point) end = new T.Vector3().copy(hit.point);
        }
      } catch {}
      if (!end) end = new T.Vector3().copy(o).addScaledVector(d, RIFLE_RANGE);

      var muz = muzzleWorld(peer, o);
      var fx = context.fx;
      if (fx) {
        if (typeof fx.tracer === "function") fx.tracer(muz, end);
        if (typeof fx.muzzleFlash === "function")
          fx.muzzleFlash(muz, d, { scale: 0.85 });
      }
      try {
        var lp = context.render && context.render.lightPool;
        if (lp && typeof lp.flash === "function")
          lp.flash(muz, 16756832, 40, 8, 0.05);
      } catch {}
      // 枪声：复用 library.js 现有 rifle_shot（near 总线不带空间化，按距离手算衰减）
      try {
        var a = context.audio;
        if (a && typeof a.play === "function") {
          var dist = cameraDistTo(o);
          var g = Math.max(0, 1.1 - dist / 50);
          if (g > 0.04)
            a.play("rifle_shot", {
              gain: g * 0.9,
              variant: fireVariant++ & 3,
              jitter: 0.012,
            });
        }
      } catch {}
    } catch {}
  }

  function playImpact(payload) {
    if (disposed || !payload) return;
    try {
      var point = toVec3(T, payload.point);
      if (!point) return;
      var normal = toVec3(T, payload.normal) || new T.Vector3(0, 1, 0);
      var dir = toVec3(T, payload.dir);
      var fx = context.fx;
      if (fx && typeof fx.impact === "function")
        fx.impact(
          point,
          normal,
          payload.surface === "player" ? "enemy" : payload.surface || "enemy",
          dir,
        );
    } catch {}
  }

  function playReload(id) {
    if (disposed) return;
    try {
      var peer = peers.get(id);
      if (peer) peer.reloadT = 0.7;
      var a = context.audio;
      if (a && typeof a.play === "function") {
        var pos = peer ? peer.cur.pos : null;
        var g = Math.max(0, 0.9 - (pos ? cameraDistTo(pos) : 0) / 25);
        if (g > 0.05) a.play("reload_magin", { gain: g });
      }
    } catch {}
  }

  function playDeath(id) {
    if (disposed) return;
    try {
      var peer = peers.get(id);
      if (peer) {
        peer.flags.alive = false;
        startDeath(peer);
      } else {
        var a = context.audio;
        if (a && typeof a.play === "function") a.play("death", { gain: 0.45 });
      }
    } catch {}
  }

  function playHit(id) {
    if (disposed) return;
    try {
      var peer = peers.get(id);
      if (peer) peer.hitT = 0.3; // 受击红闪（视觉；无对应远端玩家受击音 cue，静默不造 API）
    } catch {}
  }

  // ---- 插值求值 ----
  function evalPose(peer, renderT) {
    var s = peer.samples;
    if (s.length === 0) return;
    // 清理陈旧采样（保留至少 2 条以便回退夹取）
    while (s.length > 2 && renderT - s[0].at > SAMPLE_STALE_S) s.shift();
    if (s.length === 1) {
      singleSamplePose(peer, s[0], renderT);
      return;
    }
    var newest = s[s.length - 1];
    if (renderT >= newest.at) {
      singleSamplePose(peer, newest, renderT); // 缓冲超前 → 由最新采样航位推测（上限 250ms）
      return;
    }
    var i = s.length - 2;
    while (i > 0 && s[i].at > renderT) i--;
    var s0 = s[i];
    var s1 = s[i + 1];
    var dt01 = s1.at - s0.at;
    if (dt01 <= 1e-4) {
      singleSamplePose(peer, s1, renderT);
      return;
    }
    var u = (renderT - s0.at) / dt01;
    if (u < 0) u = 0; // renderT 早于全部采样（网络突发/卡顿追帧）→ 夹取最旧采样，防 hermite 爆炸
    else if (u > 1) u = 1;
    // hermite 位置插值（端点速度作切向）
    var u2 = u * u;
    var u3 = u2 * u;
    var h00 = 2 * u3 - 3 * u2 + 1;
    var h10 = u3 - 2 * u2 + u;
    var h01 = -2 * u3 + 3 * u2;
    var h11 = u3 - u2;
    var p = peer.cur.pos;
    p.set(
      h00 * s0.pos.x + h10 * s0.vel.x * dt01 + h01 * s1.pos.x + h11 * s1.vel.x * dt01,
      h00 * s0.pos.y + h10 * s0.vel.y * dt01 + h01 * s1.pos.y + h11 * s1.vel.y * dt01,
      h00 * s0.pos.z + h10 * s0.vel.z * dt01 + h01 * s1.pos.z + h11 * s1.vel.z * dt01,
    );
    peer.cur.yaw = s0.yaw + angleDelta(s0.yaw, s1.yaw) * u;
    peer.cur.pitch = s0.pitch + angleDelta(s0.pitch, s1.pitch) * u;
  }

  function singleSamplePose(peer, sample, renderT) {
    peer.cur.yaw = sample.yaw;
    peer.cur.pitch = sample.pitch;
    var f = peer.flags;
    var beyond = renderT - sample.at;
    if (beyond > 0.001 && f.alive && !f.aboard) {
      // 航位推测：vel 外推，上限 250ms
      var ex = Math.min(beyond, EXTRAP_MAX_MS / 1000);
      peer.cur.pos.set(
        sample.pos.x + sample.vel.x * ex,
        sample.pos.y + sample.vel.y * ex,
        sample.pos.z + sample.vel.z * ex,
      );
    } else {
      peer.cur.pos.copy(sample.pos);
    }
  }

  // ---- 主更新 ----
  function update(dt) {
    if (disposed) return;
    try {
      tick(dt);
    } catch (e) {
      var now = nowS();
      if (now - lastWarnAt > 2) {
        lastWarnAt = now;
        console.warn("[mp:remote-players] update 自兜:", e && e.message);
      }
    }
  }

  function tick(dt) {
    var now = nowS();
    var renderT = now - BUFFER_MS / 1000;
    var ids = Array.from(peers.keys());
    for (var k = 0; k < ids.length; k++) {
      var peer = peers.get(ids[k]);
      var f = peer.flags;

      // 超时清场（掉线由 peerLeave 兜底，这里是网络静默兜底）
      if (now - peer.lastSampleAt > PEER_TIMEOUT_S) {
        removePeer(ids[k], false);
        continue;
      }

      evalPose(peer, renderT);
      peer.root.position.copy(peer.cur.pos);
      peer.root.rotation.y = peer.cur.yaw;

      // aboard：整体隐身
      peer.root.visible = !f.aboard;
      if (f.aboard) continue;

      // 平面/垂直速度：插值后位姿逐帧差分 + 指数平滑（帧率无关，喂 avatar 步态/着地检测）
      if (peer.lastPos) {
        var inv = dt > 1e-4 ? 1 / dt : 60;
        var hs = Math.hypot(
          peer.cur.pos.x - peer.lastPos.x,
          peer.cur.pos.z - peer.lastPos.z,
        ) * inv;
        if (hs > 8) hs = 8; // 上船瞬移/卡顿追帧尖峰夹取
        var vs = (peer.cur.pos.y - peer.lastPos.y) * inv;
        if (vs > 12) vs = 12;
        else if (vs < -12) vs = -12;
        var kv = 1 - Math.exp(-10 * dt);
        peer.speed += (hs - peer.speed) * kv;
        peer.vy += (vs - peer.vy) * kv;
      } else {
        peer.lastPos = new T.Vector3();
      }
      peer.lastPos.copy(peer.cur.pos);

      // 表现计时推进
      if (peer.fireT > 0) peer.fireT = Math.max(0, peer.fireT - dt);
      if (peer.reloadT > 0) peer.reloadT = Math.max(0, peer.reloadT - dt);
      if (peer.hitT > 0) peer.hitT = Math.max(0, peer.hitT - dt);

      // 姿态：喂给 avatar（步态/蹲伏/冲刺/ADS/后坐/换弹/呼吸/倒伏全在化身内驱动）
      if (peer.avatar) {
        peer.avatar.applyPose(
          {
            speed: peer.speed,
            vy: peer.vy,
            crouch: f.crouch,
            sprint: f.sprint,
            ads: f.ads,
            alive: f.alive,
            pitch: peer.cur.pitch,
            fireT: peer.fireT,
            reload: peer.reloadT > 0 ? 1 - peer.reloadT / 0.7 : -1,
          },
          dt,
        );
        peer.avatar.setHitFlash(peer.hitT > 0 ? peer.hitT / 0.3 : 0);
      }

      // 名牌：billboard 由 Sprite 自带；20m 外隐藏；距离文本节流重绘
      if (peer.tag) {
        if (!pvpTagVisible(peer.id) || !f.alive) {
          peer.tag.sprite.visible = false;
        } else {
          var dist = cameraDistTo(peer.cur.pos);
          peer.tag.sprite.visible = dist <= TAG_HIDE_M;
          if (peer.tag.sprite.visible) {
            var txt = Math.max(0, Math.round(dist)) + "m";
            if (txt !== peer.lastTagDistText) {
              peer.lastTagDistText = txt;
              drawTag(peer, txt, false);
            }
          }
        }
      }
    }
  }

  // ---- 查询面 ----
  function publicView(peer) {
    var f = peer.flags;
    return {
      id: peer.id,
      name: peer.name,
      pos: peer.cur.pos,
      yaw: peer.cur.yaw,
      pitch: peer.cur.pitch,
      hp: peer.hp,
      alive: f.alive,
      aboard: f.aboard,
      crouch: f.crouch,
      sprint: f.sprint,
      ads: f.ads,
      color: peer.color,
    };
  }

  function list() {
    var out = [];
    peers.forEach(function (peer) {
      out.push(publicView(peer));
    });
    return out;
  }

  function byId(id) {
    var peer = peers.get(id);
    return peer ? publicView(peer) : null;
  }

  function count() {
    return peers.size;
  }

  function colorOf(id) {
    var peer = peers.get(id);
    if (peer) return peer.color;
    return colorOfDefault(id, rosterSlotOf(id) >= 0 ? rosterSlotOf(id) : 0);
  }

  function setColorMap(fn) {
    colorMapFn = typeof fn === "function" ? fn : null;
    // 在场化身即时换色
    peers.forEach(function (peer) {
      var c = colorOfDefault(peer.id, peer.slot);
      peer.color = c;
      try {
        if (peer.avatar) peer.avatar.setColor(c); // 背心+头盔即时换色
      } catch {}
      if (peer.tag) {
        var col = new T.Color(c);
        peer.tag.cssColor = "#" + col.getHexString();
        drawTag(peer, peer.lastTagDistText || "--m", true);
      }
    });
  }

  function nametag(id, text) {
    if (disposed || id == null) return;
    var str = String(text == null ? "" : text).slice(0, 14);
    var peer = peers.get(id);
    if (peer) {
      peer.name = str;
      drawTag(peer, peer.lastTagDistText || "--m", true);
    } else {
      pendingNames.set(id, str);
    }
  }

  function dispose() {
    disposed = true;
    clearAll();
    pendingNames.clear();
    try {
      matFatigues.dispose();
      matGear.dispose();
      matDark.dispose();
    } catch {}
  }

  return {
    update: update,
    count: count,
    list: list,
    byId: byId,
    setColorMap: setColorMap,
    colorOf: colorOf,
    playFire: playFire,
    playReload: playReload,
    playDeath: playDeath,
    playHit: playHit,
    nametag: nametag,
    dispose: dispose,
  };
}
