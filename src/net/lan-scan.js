// src/net/lan-scan.js — 局域网自动发现扫描器（MP-PVP §12）
// 用途：加入界面「自动发现」—— 并发探测本网段 /24 内跑着 server 的主机（GET /lan-info），
//       列出应答房间的模式/人数/房主名，点选直连；队友侧零输入（不输 IP 不输码）。
// 网段推断：浏览器无权限直接读本机 IP —— 用 WebRTC ICE host 候选提取内网 IPv4
//       （RTCPeerConnection + createDataChannel + createOffer，零连接零流量）。
//       现代浏览器默认 mDNS 混淆，host 候选可能是 xxx.local —— 提取不到 IPv4 时
//       getLocalSubnet() 返回 null，调用方（menus.js）降级为手输网段兜底（§12.0）。
// file:// 页面可用性：fetch 跨源读取依赖服务器 /lan-info 的 CORS 全开（ACAO:*）——
//       file:// 页 origin 为 null，非凭据跨源请求在 ACAO:* 下同样放行；
//       WebRTC 候选收集在 file:// 页同样可用（不要求安全上下文）。验证记录见 scripts/mp-smoke.mjs。
// 备注（§12）：纯浏览器互扫不可行（浏览器无监听能力）—— 本模块扫的是 server 进程。

import { DEFAULT_PORT } from "./protocol.js";

const SUBNET_PROBE_TIMEOUT_MS = 1200; // ICE 收集兜底超时：候选通常毫秒级出，mDNS 场景拖满即放弃
const HOSTS = 254; // /24 扫描主机数：.1 起 .254 止（跳过网络地址与广播地址）

const IPV4_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;

/** 仅认 RFC1918 内网段（10/8、172.16-31/16、192.168/16）；回环/组播/公网候选一律不认 */
function isRfc1918(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

/** 网段优先级：家用场景 192.168 最常见，其次 10.x，最后 172.16-31（多网卡全命中时取最像"战场局域网"的） */
function subnetRank(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  return 2;
}

/** 从 ICE candidate 行提取 host 候选的内网 IPv4；非 host 候选 / mDNS(.local) / 非内网段返回 null */
function hostIpv4Of(candidateLine) {
  if (typeof candidateLine !== "string" || !candidateLine.includes("typ host"))
    return null;
  const m = candidateLine.match(IPV4_RE);
  if (!m) return null; // mDNS 混淆下候选是 xxx.local，无 IPv4 可提
  return isRfc1918(m[1]) ? m[1] : null;
}

/**
 * 推断本机所在网段（§12.0「网段推断」）。
 * @returns {Promise<string|null>} '192.168.31' 形式（前三段，无尾点）；失败返回 null，
 *          调用方降级为手输网段。非浏览器环境（无 RTCPeerConnection，如 Node 测试进程）同样返回 null。
 */
export function getLocalSubnet() {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection !== "function") return resolve(null);
    let pc = null;
    let settled = false;
    const ips = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (pc) pc.close();
      } catch {}
      const best = ips.slice().sort((a, b) => subnetRank(a) - subnetRank(b))[0];
      resolve(best ? best.split(".").slice(0, 3).join(".") : null);
    };
    const timer = setTimeout(finish, SUBNET_PROBE_TIMEOUT_MS);
    try {
      pc = new RTCPeerConnection({ iceServers: [] }); // 零服务器：不产生任何出站流量
      pc.createDataChannel("saltline-scan-probe"); // 无 DataChannel 的 offer 不收集候选
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish(); // null 候选 = 收集完毕
        const ip = hostIpv4Of(e.candidate.candidate);
        if (ip && !ips.includes(ip)) ips.push(ip);
      };
      Promise.resolve(pc.createOffer())
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish());
    } catch {
      finish();
    }
  });
}

/** 归一手输网段：'192.168.31' / '192.168.31.' / '192.168.31.55'（整 IP）/ '192.168.31.0/24'
 *  均归一为 '192.168.31'；非法输入返回 null。 */
function normalizeSubnet(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw
    .trim()
    .replace(/\/\d+$/, "")
    .replace(/\.$/, "")
    .split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const head = parts.slice(0, 3);
  if (head.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return head.join(".");
}

/** /lan-info 应答形状门：公开房带 code；私密房 visible:false；
 *  无房哨兵（{running,rooms:0}）与网段里无关设备的任意 JSON 一律不计入发现列表 */
function isLanInfo(info) {
  return (
    !!info &&
    typeof info === "object" &&
    (typeof info.code === "string" || info.visible === false)
  );
}

/**
 * 局域网扫描（§12.1）：254 地址按 concurrency 分批并发 fetch http://{ip}:{port}/lan-info，
 * AbortController 超时；应答 JSON 解析失败/形状不符跳过；结果按响应先后排序（先应答先入列）。
 * @param {object} [opts]
 * @param {number}  [opts.port=8787]        目标端口（server 进程端口）
 * @param {number}  [opts.timeoutMs=400]    单探针超时（AbortController）
 * @param {number}  [opts.concurrency=64]   分批并发（防压满网卡/路由器）
 * @param {function}[opts.onFound]          每发现一台即回调（{ip, info}）—— 供 UI 流式上屏
 * @param {string}  [opts.subnet]           显式网段（手输兜底入口）；缺省自动推断，
 *                                          推断失败（mDNS 混淆/无 WebRTC）返回 []
 * @param {function}[opts.fetchImpl]        fetch 替身（测试注入 node:http 单发请求；浏览器调用方无需关心）
 * @returns {Promise<Array<{ip:string, info:object}>>} 发现列表（按响应排序）
 */
export async function scanLan(opts = {}) {
  const {
    port = DEFAULT_PORT,
    timeoutMs = 450,
    concurrency = 24, // ⚠️ 浏览器连接池上限：64 并发时后派发的探针被死 IP 待定连接饿死（真机复现：.234 在波尾必 miss，≤32 全命中）；Node 侧无此限但统一参数
    onFound = null,
    subnet = null,
    fetchImpl = null,
  } = opts;
  const net = normalizeSubnet(subnet) || (await getLocalSubnet());
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!net || !doFetch) return []; // 网段不可得：调方手输网段兜底；无 fetch 环境（老 Node）同样空手而归

  const results = [];
  for (let base = 1; base <= HOSTS; base += concurrency) {
    const wave = [];
    for (let h = base; h < base + concurrency && h <= HOSTS; h++)
      wave.push(`${net}.${h}`);
    await Promise.all(
      wave.map(async (ip) => {
        const info = await probeHost(ip);
        if (!info) return;
        const entry = { ip, info };
        results.push(entry); // 批内按响应完成序入列 ≈ 全程按响应排序
        if (typeof onFound === "function") {
          try {
            onFound(entry);
          } catch {} // 上屏回调异常不拖垮扫描
        }
      })
    );
  }
  return results;

  async function probeHost(ip) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(`http://${ip}:${port}/lan-info`, {
        signal: ac ? ac.signal : undefined,
        mode: "cors",
        cache: "no-store",
        redirect: "manual",
      });
      if (!res || !res.ok) return null;
      const info = await res.json(); // 解析失败 → catch → 跳过（§12.1「应答 JSON 解析失败跳过」）
      return isLanInfo(info) ? info : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
