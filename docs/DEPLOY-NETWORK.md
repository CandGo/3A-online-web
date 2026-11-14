# 公网部署与网络传输决策（DEPLOY-NETWORK）

> 2026-11-13 调研定稿。问题：公网部署时 WS/TCP 够不够、要不要上 UDP 系（WebTransport）、部署到哪。

## 0. 结论先行

| 场景 | 方案 | 说明 |
|---|---|---|
| 海外朋友局（现有美国节点） | **现状 WS 直接部署** | 零改动，跨太平洋 RTT 150-250ms 能玩但打折 |
| **国内玩家为主（推荐）** | **国内机器 + WS + lag compensation** | 对国内玩家体验最好的性价比组合，且不需要域名备案 |
| 追求极致 | 国内机器 + 域名备案 + WebTransport 双栈 | 消灭 TCP 队头阻塞，工程量+运维成本一档 |

**核心判断：对国内玩家，"国内机房 + WS(TCP) + 回溯判定"优于"美国机房 + WebTransport"**——150ms+ 跨洋链路上，主要矛盾是裸 RTT 和判定公平性，不是 TCP 队头阻塞。

## 1. 事实底座（2026-11 调研）

- **浏览器侧 WebTransport 已 Baseline**（2026-03，Safari 26.4 补齐最后一块）：Chrome 97+ / Edge 98+ / Firefox 114+ / Safari 26.4+。玩家浏览器不是障碍。
- **Node 侧**：核心 QUIC/HTTP3 已进 Node 但仍实验性且**无内置 WebTransport**；事实标准是社区库 `@fails-components/webtransport`（Socket.IO/Colyseus 同款后端）。
- **已知风险**：该库 issue #417 报告 v1.4.2 在 **Node 24 上有兼容故障**（我们是 24.14）——采用前必须验证，或服务器侧跑 Node 22 LTS 容器。
- **运维约束**：QUIC 走 UDP 且**无法过 nginx 等 TCP 反代**，必须应用直收 UDP 端口；强制 TLS（生产需域名+证书，Let's Encrypt 即可；自签证书浏览器侧需指纹钉扎，只适合开发）。
- 延迟参考：同城 5-20ms / 国内跨省 20-50ms / 中国→美西 150-250ms（晚高峰劣化更狠）。

## 1.5 零服务器模式（§13 Trystero）的国内实测（2026-11-15，scripts/stun-probe.mjs）

从国内家宽（湖南电信）全链路实测：

| 层 | 实测 | 结论 |
|---|---|---|
| 信令（Nostr relay） | 默认池 30 个抽样 10 个：**5 通 5 死**（wellorder/azzamo/ditto/yabu/guggero 通；primal/snort/soloco 死） | ✅ 信令层可用，Trystero 取子集即可配对 |
| 打洞（公共 STUN） | **"国内公共 STUN"全灭**：stun.miwifi.com / stun.qq.com / stun.chat.bilibili.com 的 DNS 仍解析，但指向陈年死 IP（111.206.x 联通 / 43.138.x 腾讯云客户机 / 106.12.x 百度云）——**TCP 443 + UDP 3478 双杀全超时**，服务器本体已死 | ❌ 国内无活的公共 STUN，网上流传清单是陈年烂货 |
| 国际 STUN | stun.cloudflare.com / global.stun.twilio.com（3478 TCP+UDP）国内不通 | ❌ 被国际线路拦，有代理的玩家才可用 |
| 本机网络 | UDP 53/123 国内通、TCP 443/465/993 通、ICMP 出户进骨干网正常；Tailscale 已停、防火墙全关、WinDivert/XLWFP 驱动在场但未拦常规流量 | 网络本身健康，问题在上表 |

**推论**：
1. 零服务器模式的真实能力圈 = **局域网**（ICE host 候选，不需要 STUN）+ **有代理的公网玩家**（Cloudflare STUN 可达）。
2. 国内公网零服务器无解——不是 NAT 问题，是**没有活的国内公共 STUN/TURN 可蹭**。自建 coturn 技术上一行 iceServers 就接入，但那就"有服务器"了，此时不如直接跑 ws 模式（§0 推荐路线）。
3. 因此**不给 trystero-transport.js 配置任何公共 STUN**（配死服务器无意义）；Trystero 默认 rtcConfig 原样保留（对能出国的玩家 Google STUN 反而可达）。

## 2. 三阶段路线


### Phase 0：现状直接上美国节点（今天可做）

```sh
# 腾讯云美国节点上：
git clone <repo> && cd saltline && git checkout zh-multiplayer
npm ci && npm run build
PORT=8787 node server/index.js        # 或 pm2 start
# 安全组放行 TCP 8787
```
- HTTP 静态 + WS 同端口，纯 IP 访问，无域名无证书无备案需求。
- 诚实预期：自己走动/开火零延迟（本地模拟），看别人有 RTT+100ms 插值延迟，中弹反馈晚一个 RTT。

### Phase 1（对国内玩家的正确答案）：国内机器 + lag compensation

1. **机器**：腾讯云国内任意区域轻量服务器即可（带宽需求 ~10KB/s×4 人，极低）。IP:port 的 TCP/WS **不需要域名备案**。
2. **lag compensation（回溯判定）**——比换传输层优先级更高的公平性工程，TCP 上就能做：
   - host-sim 维护每玩家位置环形缓冲（15Hz×1.5s≈23 帧）
   - sh 射击消息带客户端时间戳；net 层维护每客户端时钟偏移（EMA，握手播种，类似 NTP）
   - onShot 判定时把所有玩家回溯到射击者的"过去时刻"再跑 `raycastPlayerParts`（分部位判定已参数化，直接喂回溯态）
   - 效果：高 ping 射手打的是"自己屏幕上看到的过去"，躲墙后被打死不再是延迟错判
   - 工程量：host-sim+net 约 300 行，一个工作流批次
3. 国内 RTT 10-50ms 下，这套做完体感已接近局域网。

### Phase 2（可选）：WebTransport 双栈

- 触发条件：晚高峰 WiFi/4G 场景远端玩家偶发抽搐（TCP 队头阻塞）成为主要抱怨时才值得做。
- 方案：`@fails-components/webtransport` 起 Http3Server（UDP 独立端口），net.js 传输层抽象——**不可靠数据报**走 ps/snap/ee（丢了等下一帧），**可靠流**走信令（join/start），WT 握手失败自动回落 WS。协议消息（protocol.js）零改动。
- 前置：①验证库在 Node 24 的兼容性（issue #417），不行就 Node 22 容器；②域名+证书（国内域名需备案）；③安全组放 UDP。
- 注意：上了国内域名就必须完成 ICP 备案（纯 IP 的 WS 不需要，这是 Phase 1 免备案的原因）。

## 3. 部署检查单（任何阶段通用）

- [ ] `npm ci && npm run build && node scripts/mp-smoke.mjs`（20 断言）
- [ ] 安全组：TCP 8787（Phase 2 另加 UDP 端口）
- [ ] pm2/systemd 守护 + 崩溃重启
- [ ] 房主权威架构提醒：host 掉线=房间终局（v1 设计），服务器本身重启不丢已建房间的只有 relay 内存态——**重启即清房**，告知玩家
- [ ] 监控：server.log 里 rooms 计数 + ws 连接数
