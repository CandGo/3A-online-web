// 局域网 HTTPS 静态服务器 —— 零服务器模式的安全上下文测试通道
// 为什么需要:crypto.subtle(Web Crypto)只在安全上下文可用,http://192.168.x.x 不是
// 安全上下文 → 手机/电脑经局域网 IP 打开时零服务器模式被前置检查拦下。
// 自签 HTTPS:手机首次访问会出证书警告,点"高级→继续访问"即可,之后 crypto 可用。
// 用法: node scripts/https-serve.mjs [端口=8443] [目录=./dist]
//   手机(同WiFi)访问 https://<本机局域网IP>:8443/  → 接受证书警告 → 零服务器可用
//   跨网测试技巧:手机经 WiFi 把页面加载完后切 5G,页面驻留内存,Nostr 中继会经 5G 重连
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

const PORT = parseInt(process.argv[2] || '8443', 10);
const ROOT = path.resolve(process.argv[3] || './dist');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const KEY = path.join(HERE, '..', 'dev-key.pem');
const CERT = path.join(HERE, '..', 'dev-cert.pem');

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && i.address.startsWith('192.168.')) return i.address;
    }
  }
  return '127.0.0.1';
}
const IP = lanIp();

if (!fs.existsSync(KEY) || !fs.existsSync(CERT)) {
  console.log('生成自签证书(30天,SAN=' + IP + ')...');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY}" -out "${CERT}" -days 30 -nodes ` +
      `-subj "/CN=${IP}" -addext "subjectAltName=IP:${IP},DNS:localhost"`,
    { stdio: 'pipe' },
  );
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

https
  .createServer(
    { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) },
    (req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (e, buf) => {
        if (e) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
    },
  )
  .listen(PORT, '0.0.0.0', () => {
    console.log(`HTTPS 就绪(自签,目录 ${ROOT})`);
    console.log(`  本机:     https://localhost:${PORT}/`);
    console.log(`  局域网:   https://${IP}:${PORT}/   ← 手机同 WiFi 打开这个,证书警告点"高级→继续访问"`);
  });
