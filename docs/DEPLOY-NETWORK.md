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

## 1.5 零服务器模式（§13 Trystero）的国内实测（2026-11-15，scripts/stun-probe.mjs；**2026-11-15 晚修正版**）

> ⚠️ 本节首版结论"国内公共 STUN 全灭"是**错的**，根因是探针两个 bug（`targets.map(probe)` 把数组
> 索引漏给了 timeout 参数导致 0-2ms 秒判超时；以及"TCP 443 不通=主机死"的过度推断——STUN 服务器
> 只听 UDP 3478，不监听 TCP 443 是常态）。修正后的全链路实测（湖南电信家宽）：

| 层 | 实测 | 结论 |
|---|---|---|
| 信令（Nostr relay） | 默认池 30 个抽样 10 个：**5 通 5 死** | ✅ 能配对 |
| 国内公共 STUN | **stun.miwifi.com / stun.chat.bilibili.com 活着**，家宽秒应答（stun.qq.com 死；syncthing DNS 已无） | ✅ 可用，勿信"清单全烂"的传言，也别盲信清单——逐一实测 |
| 国际 STUN | global.stun.twilio.com 稳定通；stun.cloudflare.com **时通时断**（高丢包，浏览器 ICE 重试可拿到）；Google 被墙 | ⚠️ twilio 可用作备份 |
| 浏览器侧 | Chrome 157 + Firefox 159 实测：无 STUN 只有 mDNS host 候选；配 STUN（含 trystero 默认的 Cloudflare）可拿到 srflx `175.8.93.47` | ✅ 浏览器栈正常 |
| NAT 类型（同 socket 三服务器比对） | miwifi / bilibili / twilio 看到同一映射 `175.8.93.47:64043` | ✅ **锥形 NAT**——打洞最友好 |
| 本机网络 | 无 IPv6（路由器未开 RA，WLAN 仅 link-local）；出口公网 IPv4 175.8.93.47（电信，非 CGNAT）；UDP 53/123/6881 国际均通（国际 UDP **不是**一刀切拦） | 网络健康 |

**结论（修正）**：
1. **零服务器模式国内公网是活的**：信令通 + 国内 STUN 活 + 本网络锥形 NAT（对方只要不是对称 NAT/CGNAT 也大概率能成）。已把实测活的 iceServers 配进 trystero-transport.js（国内 miwifi/bilibili 优先 + twilio/cloudflare 备份 + Google 留给海外玩家）。
2. 已知边界：双方都是手机热点/移动宽带（CGNAT 对称）时打洞仍可能失败——那是 TURN 的领域，零服务器无解，属预期内降级（ws 模式兜底）。
3. 排障方法论沉淀：①探针先自证（`map(probe)` 索引泄漏这种 bug 会批量制造假"timeout"）；②UDP 服务不监听 TCP 是常态，别拿 TCP 推断主机死活；③NAT 判定必须同 socket 多服务器比对；④单发 UDP 探测 ≠ 浏览器 ICE（后者持续重试，能穿透高丢包链路）——最终以真实浏览器候选收集为准（本次用 Chrome headless 裸 CDP + Firefox 双证）。
4. BT 网络对照（回答"为什么 BT 能通"）：BT 的发现层是活的分布式 DHT（自举节点 6 域名 5 烂尾但 1 个活即可进网；`router.bittorrent.com` 现指向 Facebook 段——域名烂尾常态）；原生客户端有裸 socket（监听端口/主动连任意 ip:port/UPnP/靠被动连接学公网映射）；下载 best-effort 可换源。浏览器只有 WebRTC 一个笼子，门票就是 STUN/TURN——但实测这张门票国内是买得到的。

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
