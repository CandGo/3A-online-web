// src/net/protocol.js — Saltline 多人协议 v1（JSON over WS 文本帧）
// 契约依据：docs/MP-CONTRACT.md §2.1 与 §③ 协议表；docs/MP-PVP.md §8.1/§9.1/§10.1（对抗/命中/公开房增量）。
// 消息名 t/k 值与字段名以契约为准，不可擅改；服务器与客户端共用本文件。

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;

// 房间码字符集：4 位大写，剔除易混淆的 0/O/1/I（契约 §0「房间码」）
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 4;

/** 全部信令 t 值 + 游戏载荷 k 值（后 12 个经 toHost/fromHost 隧道透传） */
export const MSG = Object.freeze({
  // 信令层 C→S
  HELLO: "hello",
  CREATE_ROOM: "createRoom",
  JOIN_ROOM: "joinRoom",
  // 快速加入（MP-PVP §10.1）：{t:"quickJoin", mode?} —— 免码匹配「公开 + lobby 态 + 未满」房；
  // 请求带 mode 则优先（仅）匹配同模式；无命中服务器自动建公开房（mode=请求值或缺省 coop），
  // 回包走既有 joined。旧服务器不认识本消息：静默忽略 → 客户端 8s 握手超时。
  QUICKJOIN: "quickJoin",
  LEAVE: "leave",
  START: "start",
  RESTART: "restart",
  LOBBY: "lobby",
  TO_HOST: "toHost",
  // 信令层 S→C
  JOINED: "joined",
  ROOM_STATE: "roomState",
  PEER_EVENT: "peerEvent",
  FROM_HOST: "fromHost",
  ERROR: "error",
  // 游戏载荷 k 值（上行：ps/ix/sh/ev；下行：peers/snap/ee/cb/ob/rs/rm/pvp）
  PS: "ps",
  IX: "ix",
  SH: "sh",
  EV: "ev",
  PEERS: "peers",
  SNAP: "snap",
  EE: "ee",
  CB: "cb",
  OB: "ob",
  RS: "rs",
  RM: "rm",
  // PvP 载荷族（MP-PVP §8.1）：{k:"pvp", e:<事件名>} 走 fromHost 隧道，
  // 服务器纯中继不解析；客户端 net 零特殊处理原样回调。
  PVP: "pvp",
  PVP_SCORE: "score", // {k:"pvp",e:"score",board:[{id,name,kills,deaths,team}]} —— §10.1：board 每项 + team:0|1（0=蓝 1=红）
  PVP_KILLED: "killed", // {k:"pvp",e:"killed",by:killerId,victim:victimId,headshot:bool}（§9.1）
  PVP_RESPAWN: "respawn", // {k:"pvp",e:"respawn",id,pos:[x,y,z],yaw,in:3.0,prot:3.0} —— §10.1：prot=重生保护秒数（免疫一切伤害，开火立即解除，CF 语义）
  PVP_ROUND_END: "roundEnd", // {k:"pvp",e:"roundEnd",board:[...],timeUp:bool,blueKills,redKills,winner} —— §10.1 团队结算：winner='blue'|'red'|'draw'
  PVP_TEAMSCORE: "teamscore", // {k:"pvp",e:"teamscore",blue,red} —— §10.1：队伍总分（先到 20 杀胜），变化即发 + 1Hz 心跳
});

/** 房间模式（MP-PVP §8.1）：createRoom 携带、joined/roomState 回显；创建后不可改 */
export const MODE_COOP = "coop";
export const MODE_PVP = "pvp";

/** 房间可见性（MP-PVP §10.1）：与模式（合作/对抗）正交。
 *  - createRoom + visibility:'private'|'public'，**缺省 private** —— 旧客户端不带该字段天然等价私密房
 *  - joined/roomState 回显 visibility；public 房可被 quickJoin 免码匹配
 *  - joined/roomState 玩家列表每项 + team:0|1 —— pvp 房按加入序 0,2→蓝(0) 1,3→红(1)，coop 恒 0；
 *    team 是房间元数据（lobby 分组/装配层取用），对局内权威分队表在 host-sim（服务器仍纯中继） */
export const VIS_PRIVATE = "private";
export const VIS_PUBLIC = "public";

/** PvP 回溯判定（lag compensation）共用窗口参数（docs/DEPLOY-NETWORK.md Phase 1 /
 *  MP-PVP §9.1 判定链增量）。host 与 client 同源取参，测试脚本直接复用：
 *  - peers/snap 批量载荷附 ht（host epoch ms 时钟回声）；client net 据此估计
 *    主机时刻，sh.t 改写为该估计（shotT）——t 原为客户端本地时间戳且 host 侧
 *    从未消费，语义收编为主机时刻估计，向后兼容
 *  - host 侧把 shotT 夹到 [now-rewindMaxMs, now-rewindMinMs] 再查环形缓冲 */
export const LAGCOMP = Object.freeze({
  rewindMinMs: 50, // 回溯下限：防“零延迟回溯”（不放大当下优势）
  rewindMaxMs: 1000, // 回溯上限：防时间戳作弊（不翻 1 秒前的旧账）
  historyMs: 1500, // 环形缓冲深度：15Hz×1.5s≈23 帧
  historyCap: 24, // 缓冲帧数硬上限（防时钟异常撑爆）
  trustWindowMs: 300000, // shotT 时钟域信任窗（±5min）：域外（如 performance.now 相对时基）视为无时间戳
});

/** 模式归一：非 "pvp" 一律归 "coop" —— 缺省/旧客户端（不带 mode 字段）天然等价合作 */
export function normalizeMode(v) {
  return v === MODE_PVP ? MODE_PVP : MODE_COOP;
}

/** 可见性归一：非 "public" 一律归 "private" —— 缺省/旧客户端（不带 visibility 字段）天然等价私密 */
export function normalizeVisibility(v) {
  return v === VIS_PUBLIC ? VIS_PUBLIC : VIS_PRIVATE;
}

/** 生成 4 位大写房间码（去 0/O/1/I） */
export function makeRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++)
    code += ROOM_CODE_CHARS[(Math.random() * ROOM_CODE_CHARS.length) | 0];
  return code;
}

/** v1 编码：JSON 文本帧。不可序列化的输入兜底为 "null"，绝不抛错 */
export function encode(obj) {
  try {
    return JSON.stringify(obj) ?? "null";
  } catch {
    return "null";
  }
}

/** v1 解码：JSON.parse。坏帧（非字符串/解析失败/非普通对象）一律返回 null */
export function decode(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    const obj = JSON.parse(s);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}
