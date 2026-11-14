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

function probe(addr, timeout = 2500) {
  return new Promise((resolve) => {
    const [host, portStr] = addr.split(':');
    const port = parseInt(portStr, 10) || 3478;
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(12);
    const body = Buffer.alloc(20);
    body.writeUInt16BE(0x0001, 0); // Binding Request
    body.writeUInt16BE(0, 2); // 占位，末尾填长度
    body.writeUInt32BE(0x2112a442, 4); // magic cookie
    txid.copy(body, 8);
    // FINGERPRINT (RFC5389 0x8028)：部分严格服务器（如 Cloudflare）无此属性会静默丢弃
    const fp = Buffer.alloc(8); // type+len+crc32
    body.writeUInt16BE(20 + 8, 2); // 先给 CRC 计算定长
    const crc = (((zlib.crc32(body) >>> 0) ^ 0x5354554e) >>> 0);
    fp.writeUInt16BE(0x8028, 0);
    fp.writeUInt16BE(4, 2);
    fp.writeUInt32BE(crc, 4);
    const msg = Buffer.concat([body, fp]);
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
const results = await Promise.all(targets.map(probe));
for (const r of results) console.log(r.ok ? `OK   ${r.addr}  映射=${r.mapped}` : `FAIL ${r.addr}  (${r.err})`);

const mappedSet = new Set(results.filter(r => r.ok && r.mapped).map(r => r.mapped));
if (mappedSet.size === 0) console.log('NAT 判定: 所有 STUN 不可达(或UDP被拦) —— 打洞无从谈起');
else if (mappedSet.size === 1) console.log(`NAT 判定: 锥形NAT —— ${[...mappedSet][0]} 各服务器看到同一映射,打洞乐观`);
else console.log(`NAT 判定: 疑似对称NAT —— 映射不一致: ${[...mappedSet].join(' | ')} 打洞悲观,需TURN`);
