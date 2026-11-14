// server/rooms.js — 房间生命周期 + 纯中继路由（无任何游戏逻辑）
// 契约依据：docs/MP-CONTRACT.md §0/§2.1/§③；docs/MP-BLUEPRINT.md ①③；
//           docs/MP-PVP.md §8.1/§8.2（room.mode 存储/透传/回显）、
//           §10.1（visibility 存储/回显 + quickJoin 匹配/自动建房 + team 序号下发）、
//           §12（/lan-info 房间摘要：公开房回显房主+成员名，私密房名单脱敏为人数）。
// 职责：房间增删、成员进出与广播、toHost/fromHost 隧道转发、
//       start/restart/lobby 仅房主放行、host 掉线广播 HOST_GONE 解散、ping/pong 心跳清死链、
//       quickJoin 匹配「公开 + lobby 态 + 未满」房（无命中自动建公开房）、
//       lanInfo 房间摘要（index.js 的 /lan-info 数据源）。
// 铁律：绝不解析游戏载荷（p 字段原样透传，pvp 载荷族同样不解析）；房主身份是唯一权威校验点。
//       team 序号只是房间元数据（按加入序取模分配，供 lobby 分组/装配层消费），
//       lanInfo 同样只是房间元数据查询 —— 不构成游戏逻辑，服务器仍是纯中继。

import {
  MSG,
  PROTOCOL_VERSION,
  MODE_PVP,
  VIS_PUBLIC,
  decode,
  encode,
  makeRoomCode,
  normalizeMode,
  normalizeVisibility,
} from "../src/net/protocol.js";

export const MAX_PLAYERS = 4;
const HEARTBEAT_MS = 30_000; // 心跳周期：30s 无 pong 即视为死链
const NAME_MAX = 16;

// 错误码：契约 §③ 的四个（BAD_CODE/ROOM_FULL/GAME_STARTED/HOST_GONE）
// 另加两个协议卫生码：PROTO（hello 版本不匹配）、BAD_REQUEST（非法消息/顺序错误）
const ERR_TEXT = {
  BAD_CODE: "无效房间码",
  ROOM_FULL: "小队已满编（4 人）",
  GAME_STARTED: "行动已开始，禁止中途加入",
  HOST_GONE: "房主已离开，行动终止",
  PROTO: "协议版本不兼容，请更新客户端",
  BAD_REQUEST: "无效请求",
};

let seq = 0;
function uid(prefix) {
  return prefix + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitizeName(raw) {
  const name =
    typeof raw === "string"
      ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX)
      : "";
  return name || "无名队员";
}

function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * 创建房间服务。index.js 负责把 ws 连接事件转进来：
 *   rooms.onOpen(ws) / rooms.onMessage(ws, data) / rooms.onPong(ws) / rooms.onClose(ws)
 */
export function createRoomServer({ log = () => {} } = {}) {
  const sockets = new Set(); // 全部在连 socket（含未握手）
  const conns = new Map(); // ws -> { ws, id, name, helloed, room, alive }
  const roomsByCode = new Map(); // 房间码 -> room
  const roomsById = new Map(); // roomId -> room
  // room = { id, code, seed, hostId, mode, visibility, phase: "lobby"|"playing", players: Map<id, player> }
  // player = { id, name, ready, alive, aboard, kills, deaths, ws }
  // 公开房注册表（§10.1「公开房注册表」）不另立结构：roomsById 遍历 + visibility
  // 过滤即匹配池 —— 房间增删/解散天然同步，无第二份状态可漂移。

  // ---------- 基础收发 ----------

  function send(ws, obj) {
    if (ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(encode(obj));
    } catch (err) {
      log("发送失败:", err.message);
    }
  }

  function sendError(ws, code) {
    send(ws, { t: MSG.ERROR, code, msg: ERR_TEXT[code] || code });
  }

  function roomBroadcast(room, obj, excludeWs = null) {
    for (const p of room.players.values()) if (p.ws !== excludeWs) send(p.ws, obj);
  }

  function broadcastRoomState(room) {
    roomBroadcast(room, {
      t: MSG.ROOM_STATE,
      phase: room.phase,
      mode: room.mode, // MP-PVP §8.1：模式随 roomState 回显（创建后不可改）
      visibility: room.visibility, // MP-PVP §10.1：可见性随 roomState 回显
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        aboard: p.aboard,
        kills: p.kills,
        deaths: p.deaths,
        team: playerTeam(room, p), // MP-PVP §10.1：pvp 按加入序 0,1 交替；coop 恒 0
      })),
      code: room.code,
    });
  }

  // ---------- 房间与成员 ----------

  function uniqueCode() {
    let code = makeRoomCode();
    while (roomsByCode.has(code)) code = makeRoomCode();
    return code;
  }

  /**
   * team 序号（MP-PVP §10.0/§10.1）：pvp 房按**当前花名册加入序**（players Map 插入序）
   * 取模分配 —— 0,2→蓝(0) 1,3→红(1)；coop 房恒 0。有人离场后按幸存者相对加入序重排，
   * 保证任意时刻 0/1 交替（2 人必为 1v1）。纯房间元数据，对局内权威分队表在 host-sim。
   */
  function playerTeam(room, player) {
    if (room.mode !== MODE_PVP) return 0;
    let idx = 0;
    for (const p of room.players.values()) {
      if (p === player) return idx % 2;
      idx++;
    }
    return 0;
  }

  /** joined 回包（建房/加入/quickJoin 三路共用形状；§8.1 mode + §10.1 visibility/team） */
  function sendJoined(ws, room, conn) {
    send(ws, {
      t: MSG.JOINED,
      roomId: room.id,
      code: room.code,
      you: { id: conn.id },
      hostId: room.hostId,
      seed: room.seed,
      mode: room.mode, // 创建后不可改，加入者回显作徽章数据源
      visibility: room.visibility, // §10.1：可见性回显（旧客户端忽略未知字段）
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        team: playerTeam(room, p),
      })),
    });
  }

  /** 建房公共路径：handleCreate 与 quickJoin 自动建房共用 */
  function createNewRoom(conn, { seed, mode, visibility }) {
    const room = {
      id: uid("r"),
      code: uniqueCode(),
      seed: Number.isSafeInteger(seed) ? seed : randomSeed(), // 缺省服务器生成并随 joined 回发
      hostId: conn.id,
      mode,
      visibility,
      phase: "lobby",
      players: new Map(),
    };
    roomsByCode.set(room.code, room);
    roomsById.set(room.id, room);
    addPlayer(room, conn);
    sendJoined(conn.ws, room, conn);
    broadcastRoomState(room);
    return room;
  }

  function addPlayer(room, conn) {
    const player = {
      id: conn.id,
      name: conn.name,
      ready: false,
      alive: true,
      aboard: false,
      kills: 0,
      deaths: 0,
      ws: conn.ws,
    };
    room.players.set(player.id, player);
    conn.room = room;
    return player;
  }

  function dissolve(room, note) {
    for (const p of room.players.values()) {
      const conn = conns.get(p.ws);
      if (conn) conn.room = null;
    }
    room.players.clear();
    roomsByCode.delete(room.code);
    roomsById.delete(room.id);
    log(`房间 ${room.code} 已解散（${note}）`);
  }

  /** 成员离场（主动 leave 或掉线 disconnect）；房主离场即房间终局 */
  function removePlayer(conn, kind) {
    const room = conn.room;
    if (!room) return;
    const player = room.players.get(conn.id);
    conn.room = null;
    room.players.delete(conn.id);
    if (room.hostId === conn.id) {
      // 房主离开/掉线 = 房间终局：其余成员收 HOST_GONE 回大厅，房间解散
      roomBroadcast(room, { t: MSG.ERROR, code: "HOST_GONE", msg: ERR_TEXT.HOST_GONE });
      dissolve(room, "房主离场");
      return;
    }
    if (room.players.size === 0) {
      dissolve(room, "最后一名成员离场");
      return;
    }
    roomBroadcast(room, {
      t: MSG.PEER_EVENT,
      kind, // "leave" 主动退房 / "disconnect" 掉线
      player: { id: conn.id, name: player ? player.name : conn.name },
    });
    broadcastRoomState(room);
  }

  // ---------- 消息处理 ----------

  function handleHello(ws, conn, msg) {
    if (conn.helloed) return sendError(ws, "BAD_REQUEST");
    if (msg.v !== PROTOCOL_VERSION) {
      sendError(ws, "PROTO");
      try {
        ws.close(1002, "protocol version mismatch");
      } catch {}
      return;
    }
    conn.name = sanitizeName(msg.name);
    conn.helloed = true;
  }

  function handleCreate(ws, conn, msg) {
    if (conn.room) return sendError(ws, "BAD_REQUEST");
    const seed = Number(msg.seed);
    // MP-PVP §8.1：建房携带 mode，归一后落房间（缺省/非法一律 coop，旧客户端零影响）
    const mode = normalizeMode(msg.mode);
    // MP-PVP §10.1：建房携带 visibility，归一后落房间（缺省/非法一律 private，旧客户端零影响）
    const visibility = normalizeVisibility(msg.visibility);
    const room = createNewRoom(conn, { seed, mode, visibility });
    log(
      `玩家 ${conn.name}(${conn.id}) 创建房间 ${room.code} seed=${room.seed} mode=${room.mode} visibility=${room.visibility}`
    );
  }

  /** 加入公共路径：按码加入与 quickJoin 命中共用（phase/满员校验 + joined/peerEvent/roomState） */
  function joinExistingRoom(ws, conn, room) {
    if (room.phase !== "lobby") return sendError(ws, "GAME_STARTED"); // 对局中重进拒绝，v1 无重连
    if (room.players.size >= MAX_PLAYERS) return sendError(ws, "ROOM_FULL");
    addPlayer(room, conn);
    sendJoined(ws, room, conn);
    roomBroadcast(
      room,
      { t: MSG.PEER_EVENT, kind: "join", player: { id: conn.id, name: conn.name } },
      ws
    );
    broadcastRoomState(room);
    log(`玩家 ${conn.name}(${conn.id}) 加入房间 ${room.code}（${room.players.size}/${MAX_PLAYERS}）`);
  }

  function handleJoin(ws, conn, msg) {
    if (conn.room) return sendError(ws, "BAD_REQUEST");
    const code = String(msg.code ?? "").trim().toUpperCase();
    const room = roomsByCode.get(code);
    if (!room) return sendError(ws, "BAD_CODE");
    joinExistingRoom(ws, conn, room);
  }

  /**
   * quickJoin 匹配器（MP-PVP §10.1）：遍历「公开 + lobby 态 + 未满」房。
   * 请求带 mode 时仅匹配同模式（保持模式意图：宁可自动建房也不落进异模式房），
   * 未带 mode 则任意公开房即可。私密房/对局中房/满员房一律不进匹配池。
   */
  function findQuickJoinRoom(reqMode) {
    for (const room of roomsById.values()) {
      if (room.visibility !== VIS_PUBLIC) continue; // 私密房绝不匹配（免码快速加入的边界）
      if (room.phase !== "lobby") continue;
      if (room.players.size >= MAX_PLAYERS) continue;
      if (reqMode !== null && room.mode !== reqMode) continue;
      return room;
    }
    return null;
  }

  /** {t:"quickJoin", mode?}：命中走既有加入路径；无命中自动建公开房（mode=请求值或缺省 coop） */
  function handleQuickJoin(ws, conn, msg) {
    if (conn.room) return sendError(ws, "BAD_REQUEST");
    const reqMode = msg.mode == null ? null : normalizeMode(msg.mode);
    const hit = findQuickJoinRoom(reqMode);
    if (hit) {
      joinExistingRoom(ws, conn, hit);
      log(`玩家 ${conn.name}(${conn.id}) 快速加入房间 ${hit.code}（mode=${hit.mode}）`);
      return;
    }
    const room = createNewRoom(conn, {
      seed: undefined, // 服务器随机生成
      mode: normalizeMode(msg.mode), // 请求值或缺省 coop（normalizeMode 两者兼得）
      visibility: VIS_PUBLIC, // 自动建房恒公开——不然下一个 quickJoin 永远匹配不到它
    });
    log(
      `玩家 ${conn.name}(${conn.id}) 快速加入无匹配，自动创建公开房间 ${room.code} mode=${room.mode}`
    );
  }

  /** start / restart / lobby：仅房主放行；原样转发给其余成员并同步 phase */
  function handleHostControl(ws, conn, msg) {
    const room = conn.room;
    if (!room) return sendError(ws, "BAD_REQUEST");
    if (room.hostId !== conn.id) {
      log(`拒绝非房主 ${conn.id} 的 ${msg.t}`);
      return sendError(ws, "BAD_REQUEST");
    }
    room.phase = msg.t === MSG.LOBBY ? "lobby" : "playing";
    roomBroadcast(room, msg, ws);
    broadcastRoomState(room);
    log(`房间 ${room.code} ${msg.t}（房主放行，成员 ${room.players.size} 人）`);
  }

  /** 客户端→房主隧道：附发送者 id 转发（host-sim 需要 playerId 归属） */
  function handleToHost(ws, conn, msg) {
    const room = conn.room;
    if (!room) return sendError(ws, "BAD_REQUEST");
    const host = room.players.get(room.hostId);
    if (!host) return; // 房主缺位（此时房间应已解散）
    send(host.ws, { t: MSG.TO_HOST, from: conn.id, p: msg.p });
  }

  /** 房主→全员隧道：非房主发出的 fromHost 是伪造，静默丢弃绝不转发 */
  function handleFromHost(ws, conn, msg) {
    const room = conn.room;
    if (!room) return sendError(ws, "BAD_REQUEST");
    if (room.hostId !== conn.id) {
      log(`拒绝非房主 ${conn.id} 伪造 fromHost`);
      return;
    }
    for (const p of room.players.values())
      if (p.ws !== ws) send(p.ws, { t: MSG.FROM_HOST, p: msg.p });
  }

  function onMessage(ws, data) {
    const conn = conns.get(ws);
    if (!conn) return;
    const msg = decode(typeof data === "string" ? data : data.toString());
    if (!msg || typeof msg.t !== "string") return; // 坏帧：静默丢弃
    if (msg.t !== MSG.HELLO && !conn.helloed) return sendError(ws, "BAD_REQUEST");
    switch (msg.t) {
      case MSG.HELLO:
        return handleHello(ws, conn, msg);
      case MSG.CREATE_ROOM:
        return handleCreate(ws, conn, msg);
      case MSG.JOIN_ROOM:
        return handleJoin(ws, conn, msg);
      case MSG.QUICKJOIN:
        return handleQuickJoin(ws, conn, msg);
      case MSG.LEAVE:
        return removePlayer(conn, "leave");
      case MSG.START:
      case MSG.RESTART:
      case MSG.LOBBY:
        return handleHostControl(ws, conn, msg);
      case MSG.TO_HOST:
        return handleToHost(ws, conn, msg);
      case MSG.FROM_HOST:
        return handleFromHost(ws, conn, msg);
      default:
        log(`忽略未知消息类型: ${msg.t}`); // 服务器不认识的一律不处理
    }
  }

  // ---------- 连接生命周期 ----------

  function onOpen(ws) {
    sockets.add(ws);
    conns.set(ws, {
      ws,
      id: uid("p"),
      name: "未命名",
      helloed: false,
      room: null,
      alive: true,
    });
  }

  function onPong(ws) {
    const conn = conns.get(ws);
    if (conn) conn.alive = true;
  }

  function onClose(ws) {
    const conn = conns.get(ws);
    sockets.delete(ws);
    conns.delete(ws);
    if (conn && conn.room) removePlayer(conn, "disconnect");
  }

  // 心跳：30s 一轮；上一轮无 pong 的连接视为死链 terminate（触发 close 清理）
  const hb = setInterval(() => {
    for (const ws of sockets) {
      const conn = conns.get(ws);
      if (!conn) continue;
      if (!conn.alive) {
        log(`心跳超时，切断 ${conn.id}`);
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      conn.alive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, HEARTBEAT_MS);

  /**
   * 生成一条 /lan-info 房间摘要。
   * 私密房仍只回显人数，公开房回显房码、房主和成员名；房码就是大厅里的房间名。
   */
  function roomLanSummary(room) {
    const players = [...room.players.values()];
    if (room.visibility !== VIS_PUBLIC) {
      return { visible: false, mode: room.mode, phase: room.phase, n: players.length };
    }
    const host = room.players.get(room.hostId);
    return {
      code: room.code,
      mode: room.mode,
      visibility: room.visibility,
      phase: room.phase,
      players: players.length,
      host: host ? host.name : "",
      names: players.map((p) => p.name),
    };
  }

  /**
   * /lan-info 房间摘要（MP-PVP §12，index.js HTTP 层的数据源）。
   * 旧客户端继续读取顶层字段；新客户端读取 roomList，从而在同一台服务器
   * 上看到全部房间，行为接近传统大厅的房间列表。私密房只显示人数，不泄露房码。
   */
  function lanInfo() {
    const rooms = [...roomsById.values()];
    if (!rooms.length) return { running: true, rooms: 0, roomList: [] };
    const first = roomLanSummary(rooms[0]);
    return { ...first, roomList: rooms.map(roomLanSummary) };
  }

  function dispose() {
    clearInterval(hb);
    for (const room of [...roomsById.values()]) dissolve(room, "服务器关闭");
    for (const ws of [...sockets]) {
      try {
        ws.terminate();
      } catch {}
    }
    sockets.clear();
    conns.clear();
  }

  return {
    onOpen,
    onMessage,
    onClose,
    onPong,
    lanInfo,
    dispose,
    stats() {
      return { sockets: sockets.size, rooms: roomsByCode.size };
    },
  };
}
