// STUN 可达性 + NAT 类型探测（诊断工具）
// 用法: node scripts/stun-probe.mjs [host:port ...]
// 判定: 向多个 STUN 发 Binding Request——各服务器看到的映射 ip:port 相同 → 锥形NAT(打洞乐观)
//       不同 → 对称NAT(打洞悲观,需TURN)
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const DEFAULTS = [
  'stun.miwifi.com:3478',
  'stun.qq.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
];

function probe(addr, timeout = 6000) {
  return new Promise((resolve) => {
    const [host, portStr] = addr.split(':');
    const port = parseInt(portStr, 10) || 3478;
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(12);
    // 裸 Binding Request(20B,无 FINGERPRINT)。实测教训:2026-11-15 曾用 gzip-CRC32
    // 和 CRC-32c 两种指纹约定均被 Cloudflare 静默丢弃(RFC 规定指纹无效必丢),
    // 而裸包各家均应答——诊断探针统一裸包;浏览器/ICE 自己的实现不受此影响。
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); // Binding Request
    msg.writeUInt16BE(0, 2);
    msg.writeUInt32BE(0x2112a442, 4); // magic cookie
    txid.copy(msg, 8);
    const done = (r) => { try { sock.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => done({ addr, ok: false, err: 'timeout' }), timeout);
    sock.on('message', (buf) => {
      clearTimeout(timer);
      const type = buf.readUInt16BE(0);
      let mapped = null;
      for (let off = 20; off + 4 <= buf.length; ) {
        const at = buf.readUInt16BE(off);
        const len = buf.readUInt16BE(off + 2);
        if (at === 0x0020 && len >= 8 && off + 8 + 4 <= buf.length) {
          const xport = buf.readUInt16BE(off + 6) ^ 0x2112;
          const xip = buf.readUInt32BE(off + 8) ^ 0x2112a442;
          mapped = `${(xip >>> 24) & 255}.${(xip >>> 16) & 255}.${(xip >>> 8) & 255}.${xip & 255}:${xport}`;
        }
        off += 4 + len + ((4 - (len % 4)) % 4);
      }
      done({ addr, ok: type === 0x0101 && !!mapped, mapped });
    });
    sock.on('error', (e) => { clearTimeout(timer); done({ addr, ok: false, err: e.message }); });
    sock.send(msg, port, host, (e) => { if (e) { clearTimeout(timer); done({ addr, ok: false, err: e.message }); } });
  });
}

const targets = process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS;
// 注意:必须显式传单参——map(probe) 会把数组索引漏给 timeout 参数(0ms/1ms/2ms...秒判超时)
const results = await Promise.all(targets.map((t) => probe(t)));
for (const r of results) console.log(r.ok ? `OK   ${r.addr}  映射=${r.mapped}` : `FAIL ${r.addr}  (${r.err})`);

// NAT 判定必须同 socket 问多个服务器(不同 socket 各有自己的映射端口,比不出结论)
const alive = results.filter((r) => r.ok && r.mapped);
if (alive.length >= 2) {
  const sock2 = dgram.createSocket('udp4');
  const seen = new Map(); // server -> 映射
  const askAgain = (addr) =>
    new Promise((res) => {
      const [host, port] = addr.split(':');
      const txid = crypto.randomBytes(12);
      const msg = Buffer.alloc(20);
      msg.writeUInt16BE(0x0001, 0);
      msg.writeUInt16BE(0, 2);
      msg.writeUInt32BE(0x2112a442, 4);
      txid.copy(msg, 8);
      const handler = (buf) => {
        if (buf.readUInt16BE(0) !== 0x0101) return;
        for (let off = 20; off + 4 <= buf.length; ) {
          const at = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 2);
          if (at === 0x0020 && len >= 8) {
            const xport = buf.readUInt16BE(off + 6) ^ 0x2112;
            const xip = buf.readUInt32BE(off + 8) ^ 0x2112a442;
            const ip = [24, 16, 8, 0].map((s) => (xip >>> s) & 255).join('.');
            sock2.off('message', handler);
            clearTimeout(timer);
            res(`${ip}:${xport}`);
            return;
          }
          off += 4 + len + ((4 - (len % 4)) % 4);
        }
      };
      const timer = setTimeout(() => { sock2.off('message', handler); res(null); }, 6000);
      sock2.on('message', handler);
      sock2.send(msg, parseInt(port, 10) || 3478, host);
    });
  for (const r of alive.slice(0, 3)) {
    seen.set(r.addr, await askAgain(r.addr));
    await new Promise((r2) => setTimeout(r2, 200));
  }
  try { sock2.close(); } catch {}
  const maps = [...new Set([...seen.values()].filter(Boolean))];
  console.log('--- 同socket复测: ' + [...seen.entries()].map(([k, v]) => `${k.split(':')[0]}=${v}`).join(' | '));
  if (maps.length === 1) console.log(`NAT 判定: 锥形NAT —— 同一socket所有服务器看到同一映射 ${maps[0]} → 打洞乐观`);
  else console.log(`NAT 判定: 疑似对称NAT —— 映射随目的地变: ${maps.join(' | ')} → 打洞悲观,需TURN`);
} else if (alive.length === 1) {
  console.log('NAT 判定: 只有1个STUN可达,无法比对(需≥2)');
} else {
  console.log('NAT 判定: 所有 STUN 不可达(或UDP被拦) —— 打洞无从谈起');
}
