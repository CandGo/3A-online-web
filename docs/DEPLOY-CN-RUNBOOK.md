# 国内公网部署手册（腾讯云轻量 + pm2）

> 面向 Saltline 多人模式（房主权威 + WS 中继，单进程 `server/index.js`，HTTP 静态 + WS 同端口）。
> 方案依据 [DEPLOY-NETWORK.md](DEPLOY-NETWORK.md)：国内机房 + WS(TCP) + IP 直连，
> **不上域名、不做 WebTransport，就不需要 ICP 备案**（详见 §7）。
> 部署套件在 `deploy/`：`remote-setup.sh`（服务器初始化，一次）+ `pack.sh`（打包）
> + `deploy.sh`（总入口）+ `ecosystem.config.cjs`（pm2 配置）。

## 0. 全景：三步上线

| 步骤 | 在哪 | 命令 | 频率 |
|---|---|---|---|
| 1. 服务器初始化 | 本机发起 | `ssh root@<IP> 'bash -s' < deploy/remote-setup.sh` | 一次 |
| 2. 首次部署/每次更新 | 本机 | `npm run deploy -- root@<IP>` | 每次发版 |
| 3. 验收 | 浏览器 | 打开 `http://<IP>:8787` | 每次 |

`deploy.sh` 做的事：本机 `npm run build` + 打 tar → scp 到服务器 `/opt/saltline/` →
远程解包 + `npm ci --omit=dev` + `pm2 startOrReload` + `pm2 save` → curl 健康检查（非 200 即报错退出）。

## 1. 腾讯云控制台购机

1. **产品**：轻量应用服务器（Lighthouse），**2 核 2G** 起步足够（4 人房带宽约 10KB/s×4，内存占用远低于 300M 重启线）。
2. **地域**：选离玩家最近的（朋友都在广东就选广州；全国分布选上海/广州这类骨干节点）。同省 RTT 20-50ms，体感接近局域网。
3. **镜像**：**Debian 12**（本套件按 Debian/Ubuntu + apt 编写；Ubuntu 22.04/24.04 也可）。
4. **登录方式**：**密钥对**——创建/绑定已有密钥对，本机 `~/.ssh/id_ed25519.pub` 对应私钥要能免密登录 root（`ssh-copy-id root@<IP>` 或控制台直接绑定）。`deploy.sh` 是无交互的（BatchMode），只支持密钥认证。
5. **防火墙**：轻量服务器控制台 →「防火墙」页签 → 添加规则：**协议 TCP、端口 8787、来源 0.0.0.0/0**（只开这一个应用端口；SSH 22 默认已开）。

> 提醒：轻量的「防火墙」就是它的安全组，不要去 CVM 的安全组页面找。

## 2. 第一次上线

```bash
# 本机，仓库根目录（G:/ai/code/saltline）

# 步骤 1:初始化服务器(装 Node 22 LTS + npmmirror 源 + pm2,建 /opt/saltline)
ssh root@<IP> 'bash -s' < deploy/remote-setup.sh

# 步骤 2:打包 + 上传 + 启动(build -> tar -> scp -> npm ci -> pm2 -> 健康检查)
npm run deploy -- root@<IP>
```

- `remote-setup.sh` 的 Node 安装策略：先走 NodeSource 官方 apt 源（标准做法，后续可 `apt-get upgrade`）；
  国内网络不通时自动回落 npmmirror 镜像的二进制直装到 `/usr/local`。npm 源统一切 `https://registry.npmmirror.com`。
- `ecosystem.config.cjs` 是 CommonJS：仓库 `package.json` 是 `"type": "module"`，pm2 用 `require()` 读配置，
  ESM 写法的 `.js` 会被包成 `{__esModule, default}` 导致 "No script path" 启动失败（实测 pm2 7.1.2），故用 `.cjs`。

## 3. 验收清单（每次发版过一遍）

- [ ] `deploy.sh` 末尾输出 `OK: 服务器本机 8787 端口返回 200`（HTTP 静态已通）
- [ ] 浏览器开 `http://<IP>:8787`：标题画面正常加载（无白屏/404 资源）
- [ ] 服务器上跑冒烟：`ssh root@<IP>` 然后 `cd /opt/saltline && node scripts/mp-smoke.mjs` → 打印 `PASS`（20 项断言：建房/加入/满员/host 掉线解散/pvp 管道）
- [ ] **双端实测**：两台设备（或一台 + 手机流量）分别建房/加入同一房间码，能看到对方移动、开火命中生效
- [ ] `pm2 status`：`saltline-mp` 为 online，重启次数没有持续上涨

## 4. 日常更新发布

改完代码（本机测试过）之后只需：

```bash
npm run deploy -- root@<IP>
```

pm2 `startOrReload` 会平滑重启进程。**注意：服务器进程重启会清空所有房间（房间态在中继内存里）**，
线上有人玩的时候挑空档发版（详见 §6 提示）。

## 5. pm2 常用命令（服务器上）

| 命令 | 作用 |
|---|---|
| `pm2 status` | 看进程状态（online / 重启次数 / 内存） |
| `pm2 logs saltline-mp` | 跟踪日志（Ctrl-C 退出，不影响进程） |
| `pm2 restart saltline-mp` | 手动重启（**会清房**） |
| `pm2 reload deploy/ecosystem.config.cjs --update-env` | 按配置重载（同 deploy.sh 内部） |
| `pm2 monit` | 终端监控面板（CPU/内存/日志） |
| `pm2 save` | 持久化当前进程表（重启服务器后自动拉起靠它） |
| `pm2 startup systemd` | （已由 remote-setup 配好）重装系统后需重跑 |

日志文件位置（`ecosystem.config.cjs` 里指定）：

- 标准输出：`/opt/saltline/logs/saltline-mp-out.log`
- 错误输出：`/opt/saltline/logs/saltline-mp-error.log`

## 6. 故障排查

| 症状 | 排查 |
|---|---|
| 浏览器打不开页面 | ① 控制台「防火墙」是否放行 TCP 8787；② 服务器上 `curl -I http://127.0.0.1:8787/` 本机都不通则是应用问题，看 `pm2 logs saltline-mp`；③ `pm2 status` 是否 online |
| 端口被占用 | `ss -ltnp \| grep 8787` 看占用进程；要换端口：改 `deploy/ecosystem.config.cjs` 里 `env.PORT` + 防火墙新端口，`pm2 reload` 后同步改本机 `deploy/deploy.sh` 里健康检查的 URL |
| `pm2 status` 里 restarts 持续上涨 | `pm2 logs saltline-mp --err 100` 看崩溃原因；常见是 `npm ci` 后 `dist/` 缺失（重新 `npm run deploy` 会连 dist 一起重传） |
| `npm ci` 报 lock 不同步 | 本机改了 `package.json` 没提交 lock；在本机跑一次 `npm install` 让 `package-lock.json` 同步再 deploy |
| Node/npm 下载慢或失败 | remote-setup 已切 npmmirror；手动确认 `npm config get registry`；Node 二进制回落源：`https://registry.npmmirror.com/-/binary/node/` |
| 玩家突然全体掉线、房间消失 | 进程重启会清房（pm2 重启/发版/服务器重启都算）——这是 v1 设计（房主权威，房间态在内存）；确认没人误跑 `pm2 restart`，看 `pm2 status` 的 uptime |
| SSH 连不上 | 安全组/防火墙 22 端口、密钥是否对应；`ssh -v root@<IP>` 看卡在哪一步 |
| 内存告警 | `max_memory_restart: 300M` 会自动重启（也会清房）；2G 机器上正常占用远低于此，触发了就 `pm2 monit` 查泄漏 |

## 7. 为什么 IP 直连免备案

- ICP 备案约束的是**域名**（国内服务器上绑域名提供 web 服务）。纯 `IP:8787` 的 HTTP/WS 访问不需要备案。
- 这套方案刻意**不上域名、不做 TLS、不做 WebTransport**：WS 走 TCP 8787 直连，国内 RTT 20-50ms 下体验已达标（依据 DEPLOY-NETWORK.md §0 结论）。
- 将来若要上域名/WebTransport（UDP），国内域名必须先完成 ICP 备案，属于 Phase 2 范畴。

## 8. 目录与文件对照

```
/opt/saltline/            # 服务器部署根目录（REMOTE_DIR 可改）
├── dist/                 # 前端构建产物（pack 时本机 build 出来的）
├── server/               # index.js + rooms.js（HTTP 静态 + WS 房间中继）
├── src/net/protocol.js   # server 的运行时依赖（协议编解码）
├── scripts/mp-smoke.mjs  # 服务器上可跑的冒烟自测
├── docs/*.md             # 手册与契约文档
├── deploy/ecosystem.config.cjs  # pm2 配置
├── logs/                 # pm2 日志（out/error）
├── package.json / package-lock.json
└── node_modules/         # npm ci --omit=dev 装出（只有 ws 一个生产依赖）
```

本机侧：`deploy/out/`（部署包产物，已 gitignore，只留最近 5 个）。
