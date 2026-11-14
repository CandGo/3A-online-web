# MP-CONTRACT 附录 §8：对抗模式（PvP FFA）v1

> 主契约见 MP-CONTRACT.md §1-7。本附录只写增量，铁律同主契约。

## 8.0 产品决策（已定）

| 决策点 | 结论 |
|---|---|
| 模式 | **FFA 自由混战**（2-4 人，人人敌对；团队 2v2 留 v2） |
| 胜利 | 队伍总分先到 **20 杀**，达到即结束 |
| 重生 | 阵亡 3 秒倒计时 → 在"离击杀者最远"的出生点满血满弹重生 |
| 伤害 | PAC-9 照旧：身体 28/发，无爆头倍率（v1 简化；弱点系统只属于机械敌） |
| 敌人/中继/撤离 | 全无——纯玩家对抗 |
| 弹药 | 换弹制照旧（30/120 起始，打空自动进入换弹循环不变） |
| 阵亡视角 | 死亡相机（原死亡镜头照用）+ 屏幕中央 3-2-1 重生倒计时 |
| 计分板 | 按住 Tab 显示（名次/名字/杀/死）；顶部常驻小条「你 X 杀 · 领先者 Y」 |
| killfeed | 「击杀者 ▸ 被杀者」走现有击杀流通道，己方击杀高亮 |
| 模式选择 | 创建房间弹层加「合作 / 对抗」切换（默认合作）；加入者在房间码下看到模式徽章；房间模式创建后不可改 |
| 单机 | 对抗仅联机可玩；单机开始行动=合作单机照旧 |

## 8.1 协议增量

- `createRoom` 增加 `mode:'coop'|'pvp'`；`joined`/`roomState` 回显 `mode`。
- toHost 复用 `sh`（host 在 pvp 模式对 players[] 做圆柱命中判定）。
- fromHost 新增载荷族：
  - `{k:"pvp", e:"score", board:[{id,name,kills,deaths}]}` — 分数变化时+1Hz 心跳
  - `{k:"pvp", e:"killed", by:killerId, victim:victimId}` — 驱动 killfeed/死亡流程
  - `{k:"pvp", e:"respawn", id, pos:[x,y,z], yaw, in:3.0}` — 面向受害端：倒计时与出生点
  - `{k:"pvp", e:"roundEnd", board:[...], timeUp:bool}` — 结算：排名列表；对抗为一局制，结算后由房主把全员带回原房间大厅

## 8.2 模块增量

| 模块 | 增量 |
|---|---|
| server/rooms.js | room.mode 透传与回显；不解析 pvp 载荷（纯中继不变） |
| src/net/protocol.js | MSG.PVP 载荷常量；createRoom 携带 mode |
| src/net/net.js | createRoom(name, {mode})；net.roomMode()；pvp 载荷经 client.onHostPayload 原样回调（零特殊处理） |
| src/net/host-sim.js | pvp 分支：onShot 命中判定加 players[] 圆柱测试（几何参数与 combat.js enemyShot 完全一致：中心 pos+1、半径 0.38、半高 0.95，取最近命中距离与敌/墙比较）；击杀→kills++/respawn 排程（出生点=level.enemySpawns 里离击杀者最远且 walkable）/20 杀 roundEnd 判定；score 心跳广播 |
| src/game/pvp.js（新） | createPvpFlow(context, deps) —— 与 createGameFlow 同外壳（state: title/intro/countdown/playing/dead/roundend；start/pause/resume/update/applySettings 同名同义），pause 本地降级照主契约 R1；倒计时 3s 开局；消费 pvp 载荷驱动计分/重生/结束；无中继/撤离/波次逻辑 |
| src/app/runtime.js | 房间 mode==='pvp' 时装配 createPvpFlow 替代 createGameFlow（其余装配不变） |
| src/combat/combat.js | pvp 模式 playerShot 本地射线加 remote-players 圆柱命中（纯视觉命中反馈：曳光止点/命中标记）；伤害不本地扣——host 权威 |
| src/player/player.js | pvp 消费 respawn 载荷：倒计时锁输入→满血满弹→瞬移出生点；pvp 下不自愈（延迟回血关闭） |
| src/ui/menus.js | 建房弹层模式切换；lobby 模式徽章；roundEnd 屏（排名列表+退出房间）；死亡屏 pvp 变体（重生倒计时） |
| src/ui/hud.js | 顶部计分小条；Tab 计分板（按住显示）；killfeed 击杀者▸被杀者；重生倒计时覆盖层 |
| src/ui.css | 上述元素样式（军事风一致） |

## 8.3 化身升级（本批同步做，替代 P0 胶囊）

新文件 `src/net/avatar.js`：导出 `createAvatar(THREE, mats, opts)` → `{root, applyPose(state, dt), setVisible(b), dispose()}`：
- **多关节士兵**（全 THREE 几何体拼装，匹配游戏程序化美术风格）：作战靴/小腿/大腿（髋+膝双关节）/腰胯/战术背心/肩/上臂/小臂（肘关节，双手持枪）/颈部/头盔（护目暗缝）/背囊；身高 ~1.8m
- 位色：背心+头盔染四色位色（青/橙/紫/黄），其余深色装备
- `applyPose` 程序化动画（纯函数，吃 state）：idle 呼吸微摆；walk/run 腿摆正弦（频率随速度）+手臂反摆+躯干起伏；sprint 前倾 8°大步幅；crouch 屈腿降高；ads 举枪至眼线；fire 后坐肩缩一帧；death 后倒/侧倒（0.45s easeOut）定格；land 下沉回弹
- remote-players.js 改为经 avatar.js 构建化身（名牌/插值/航位推测逻辑不动，只换视觉件）

## 8.4 验收门（增量）

1. 构建+冒烟绿；合作模式全回归（含单机）零差异
2. PvP E2E：双端建房（对抗）→ 双方可见新化身 → 对射：命中方掉血→击杀→killfeed→3s 重生→计分板更新 → 达到击杀上限出结算屏 → 退出房间
3. 化身：走路腿摆/跑姿前倾/蹲伏/开火后坐/死亡倒伏全部可见（截图取证）

---

# 附录 §9：分部位命中判定 + 爆头 + 化身精致化 v2（2026-11-13）

> 背景：v1 PvP 判定为单圆柱（中心 pos+1/r0.38/半高0.95），脚部 y<0.05 无判定体、四肢与头盔外凸打不中、无爆头倍率。本批全部重做。

## 9.0 分部位判定体（解析几何，双端同参，随 ps 状态驱动）

新模块 `src/net/hitbox.js`：`playerHitboxes(state)` → `[{part, shape, center, r|half, mult}]`，state={pos,yaw,crouch}。
局部系（x 右/y 上/z 前）绕 yaw 旋转，**站立**：

| 部位 | 形状 | 中心(x,y,z) | 尺寸 | 倍率 |
|---|---|---|---|---|
| head 头 | 球 | (0, 1.62, 0) | r=0.13 | **×2.2** |
| torso 躯干 | 圆柱 | (0, 1.15, 0) | r=0.20, 半高 0.33 | ×1.0 |
| hips 骨盆 | 圆柱 | (0, 0.86, 0) | r=0.18, 半高 0.10 | ×1.0 |
| leg_L/R 腿 | 圆柱 | (±0.10, 0.42, 0) | r=0.09, 半高 0.42（**触地 y=0**） | ×0.7 |
| arm_L/R 臂 | 圆柱 | (±0.27, 1.18, 0.04) | r=0.07, 半高 0.27 | ×0.7 |

**蹲伏**：head→(0,1.38,0) r0.13；torso→(0,1.00,0) 半高0.28；hips→(0,0.74,0)；腿→(±0.11,0.32,0) 半高0.32 r0.10；臂→(±0.25,1.05,0.10)。
射线取**最近命中部位**；同距离重叠按 mult 高者优先。28 伤/发换算：头 61.6（两枪倒）/躯干 28（四枪）/四肢 19.6（六枪）。

## 9.1 落点

- host-sim `pvpShot`：圆柱单测替换为 hitbox.js 分部位遍历（与墙/敌距离比较逻辑不变），命中载荷 cb.hitPlayer 增加 `part` 字段。
- combat `pvpVisualHit`：同参数替换，本地命中标记区分爆头（hitmarker 高亮+专属音效 cue，查 library.js 现有 hit 类 cue 复用）。
- 击杀流：pvp:killed 载荷加 `headshot:bool`——killfeed 爆头行「A ▸ B ✚爆头」高亮；死亡屏「被 XX 爆头击杀」变体。
- 合作模式敌判定（弱点×2.2）与本批互不影响。

## 9.2 化身 v2（视图模型级精致度，枪械移植完成后实施）

对标 rig.js 手部细节层级（指节几何/缝线/袖口卷边）+ props 做旧体系：
- 全身重制：作战靴（鞋底纹+鞋带袢）/护膝（绑带扣）/战术背心（弹匣袋×3 带翻盖+电台天线+线缆）/肩甲板/护肘/头盔（导轨+护目翻片）
- **视图模型双手 graft**：Vv 手部为 1:1 真实尺度，直接移植到枪的握把/护木位（第三人称也用那双精致手套持枪）
- 材质走 mats 做旧/贴纸管线（与集装箱同风格），四色位照旧；总面数目标 ≤20k 三角
- applyPose 动画谱系照旧全保留（新部件挂到既有关节层级）

---

# 附录 §10：公开房 + 团队对抗 + CF 式重生 + 无限弹药（2026-11-13）

## 10.0 决策（已定）

| 决策点 | 结论 |
|---|---|
| 房间可见性 | 建房弹层加「私密(默认)/公开」切换；公开房免码快速加入；可见性与模式(合作/对抗)正交 |
| 快速加入 | 加入弹层顶部新增「快速加入」主按钮 → 服务器匹配**公开且未满且 lobby 态**的房 → 无匹配则自动创建公开房并返回房码（界面照常显示可分享） |
| 对抗改团队死斗 | 自动分队：加入序 0,2→蓝队 1,3→红队（2 人=1v1）；**队伍总分先到 20 杀**即结束；队友免伤 |
| 队伍出生点 | 蓝队=闸门区（playerStart 侧）固定点集；红队=码头/撤离区固定点集；重生从**本队点集**选离击杀者最远者 |
| 重生保护 | 重生后 **3 秒免疫一切伤害**（invulnerable）；**开火立即解除**（CF 语义，防蹲点滥用）；HUD 显示保护倒计时 |
| 无限弹药 | **仅对抗模式**：备弹无限（弹匣 30 + R 换弹照旧，备弹位显示 ∞）；合作/单机保持原版稀缺 |
| 击杀流 | 敌我配色（击杀敌队=高亮，被击杀红字）；Tab 板按队分组 |

## 10.1 协议增量

- `createRoom` + `visibility:'private'|'public'`（缺省 private）；`joined`/`roomState` 回显 `visibility` 与每玩家 `team:0|1`（仅 pvp 房有意义，coop 恒 0）
- 新增 C→S：`{t:"quickJoin", mode?}` → 匹配公开 lobby 未满房（mode 给了则优先匹配同模式）→ 无则服务器自动建房（visibility=public，mode=请求值或缺省 coop）→ 走既有 `joined` 回包
- `pvp.score` 的 board[] 每项 + `team`；新增 `{k:"pvp", e:"teamscore", blue, red}`（变化即发+1Hz 心跳）
- `pvp.respawn` + `prot:3.0`（保护秒数）
- `pvp.roundEnd` + `{blueKills, redKills, winner:'blue'|'red'|'draw'}`
- server：公开房注册表/quickJoin 匹配（lobby 态+未满+公开）/心跳清理照旧/旧客户端无 visibility 缺省 private

## 10.2 落点清单

| 模块 | 增量 |
|---|---|
| server/rooms.js | visibility 存储/透传/回显；quickJoin 匹配器+自动建房；team 序号分配 |
| protocol.js | QUICKJOIN 常量+visibility/team/prot/teamscore/winner 字段 |
| net.js | `net.quickJoin(mode?)`→Promise；`net.roomVisibility()`；`net.myTeam()` |
| host-sim.js | 分队表；pvpShot **友军免伤门**+**保护期吞伤**；队伍比分（kills 归队）/20 杀终局；重生选点限**本队点集**内最远；保护 3s 计时+收 sh 解除；teamscore 广播 |
| pvp.js | 消费 teamscore/团队 roundEnd；出生保护黑板 `context.pvpProt`；队伍配色上下文 |
| player.js | 重生 invulnerable 3s；开火解除（weapon:fire 订阅） |
| combat.js | pvpVisualHit 跳过队友（无 hitmarker）+保护期目标跳过 |
| weapon.js | pvp 房 reserve=∞（reload 照旧）——只挂 pvp 门 |
| menus.js | 建房弹层「私密/公开」切换；加入弹层「快速加入」主按钮+码输入次选；lobby 队伍分组（蓝/红）；roundend 团队结算（蓝 X:Y 红+胜利方横幅），房主可返回原房间大厅 |
| hud.js | 顶部计分条=队伍比分（己方高亮）；Tab 板按队分组；killfeed 敌我配色；重生保护倒计时（"重生保护 2.4s"）；备弹 ∞ 显示 |
| ui.css | 队伍色（蓝 #4da3ff 系/红 #ff5a4d 系）、保护提示、团队结算样式 |

## 10.3 验收门

1. 全量测试链绿（smoke+hitbox+avatar+lagcomp+新增断言：quickJoin 匹配/友军免伤/保护期吞伤/开火解除/团队比分）
2. E2E：双端快速加入同一公开房；对抗 2v2（或 1v1）各队固定侧重生；保护期挨打不掉血；开火即解除；队友互射零伤害；弹药 ∞；团队结算屏

---

# 附录 §11：敌方坐标提醒（火力暴露 + 受击方向）（2026-11-13，排队执行：待 §10 批次交卷后开工，同文件不并行）

## 11.0 决策

| 机制 | 规格 |
|---|---|
| 火力暴露 | 敌方玩家每次开火 → **敌队全员**罗盘出现红色威胁标记（方位+距离米数），1.8s 渐隐，续射续曝；友军开火不标；保护期开火（解除保护那一枪）同样暴露 |
| 受击方向 | 被命中瞬间屏幕边缘受击方位**红色扇形** 1.2s（CF/CS hit-direction）；多方向叠加显示 |
| 不做 | 穿墙世界标记（只罗盘方位+距离，不透视）；持续雷达（敌方实时位置不播——只有开火才暴露）；队友报点（击中标记敌 2s，留 v2） |

## 11.1 协议与落点

- host-sim：处理 sh（权威结算时）广播 `{k:"pvp", e:"fire", id, pos:[x,y,z]}`（每射限频 4/s 防刷屏）；client 端 pvp.js 翻译为本地事件 `pvp:enemyFire{id,pos}`（敌队过滤在 HUD 侧按 team 做）
- hud.js：罗盘标记通道复用 setMarkers 体系新增 `kind:"threat"`（红色，带距离，1.8s 生命）；受击扇形新 DOM 元素（方位角从 cb.hitPlayer 的 attacker → remote-players byId(pos) 计算，无位姿则跳过）
- ui.css：威胁标/扇形样式（红系 #ff5a4d）
- combat.js：cb.hitPlayer 消费点补 attacker 位姿透传（若现有载荷缺 pos，从 roster 带出）
- 验收：E2E 敌方开火→己方罗盘见红标含距离；己方开火→敌方见标己方不见；受击→扇形方位与实际来弹方向一致；断言 ≥8 条

---

# 附录 §12：局域网自动发现（扫 /24 找服务器）（2026-11-13，排队：待 §10/§11 及后台保活批次交卷后开工）

## 12.0 决策

| 项 | 结论 |
|---|---|
| 形态 | 加入界面新增「自动发现」：并发扫描本网段 /24 的 8787 端口，列出应答房间的模式/人数/房主名，点选直连 |
| 前提 | 有人在跑 server（node 或未来打包 exe）；队友侧零输入（不输 IP 不输码） |
| 网段推断 | 客户端无权限直接读本机 IP——用 WebRTC ICE candidate 收集 host 候选提取本机内网 IP（mDNS 关闭场景），失败则手输网段兜底 |
| 端点 | server 新增 GET /lan-info：CORS 全开（ACAO *），顶层保留首房兼容字段，并返回 `roomList` 全部房间；公开房回显 {code,mode,visibility,phase,players,host,names}，私密房脱敏为人数（无码无名） |

## 12.1 落点

- server/index.js+rooms.js：/lan-info 路由 + CORS 头 + 全部房间摘要（私密房返回 {visible:false, mode, phase, n}）
- net.js 或新 src/net/lan-scan.js：scanLan(port, timeoutMs, onFound)——254 并发 fetch（AbortController 超时 400ms，分批 64 防压满），返回发现列表
- menus.js：加入弹层「自动发现」按钮 → 扫描中状态 → 房间列表（模式徽章/人数/房主）→ 点选 net.joinRoom(code)
- ui.css：扫描/列表样式
- 验收：本机双实例（不同端口模拟）可被扫出；私密房脱敏；扫描 ≤3s；file:// 打开也能扫（CORS \* 生效验证）

> 备注：纯浏览器互扫不可行（浏览器无监听能力）——本方案扫的是服务器进程；真零服务器场景走 §11 之外另议 WebRTC+QR。

---

# 附录 §13：零服务器模式（Trystero P2P，2026-11-14 排队）

> 依据：用户侧独立样例已实测跑通（trystero-demo.html）——Nostr 信令配对、host↔host UDP 直连、
> 位置同步 20Hz、RTT 1.2ms、信令断开后 DataChannel 存活；MQTT 4/4、Torrent 3/3 可连。

## 13.0 决策

| 项 | 结论 |
|---|---|
| 定位 | 第三种联机方式：**服务器(ws) / 零服务器(Trystero) / 局域网自动发现(扫 ws 服务器)** 三选一 |
| 依赖 | `trystero` npm 打包进前端（样例 600KB 全家桶实测可行）；server/ 零改动 |
| 房间语义 | 房间码=Trystero 房间名（appId 前缀隔离）；进房=joinRoom，无 create/join 信令 |
| 房主选举 | 私人房由建房者优先担任 host；建房者不在场时才按稳定 peerId 选接管者。公共分片无固定建房者，仍按最小 peerId 选 host；host 掉线 v1=房间终局（同现架构） |
| 消息面 | makeAction('m') 单通道承载 protocol.js 既有全部消息；roomState/teamscore 等由 host 经同通道广播 |
| 策略 | 默认 nostr；连接失败自动轮换 mqtt→torrent；全败提示回落服务器模式 |
| 限制（实测已知） | 首次配对需联网（公共信令可达）；严格 NAT 无 TURN 可能建连失败；房间目录依赖固定目录房间，记录按心跳 TTL 过期 |

## 13.1 落点

| 模块 | 增量 |
|---|---|
| package.json | +trystero 依赖 |
| src/net/trystero-transport.js（新） | 传输适配层：实现 net.js 传输缝（连接/收发/players/host 面），消息经 makeAction('m') |
| src/net/net.js | 传输选择：mode 'p2p'；createRoom/joinRoom 在 p2p 下走 joinRoom+选举；其余逻辑零改 |
| src/ui/menus.js | 建房弹层第三钮「零服务器(同文件同房号)」+策略提示；加入侧同步 |
| 验收 | 两浏览器同房名零服务器进局；合作+对抗全功能与 ws 模式等价；信令断开对局继续（DataChannel 存活）；host 掉线房间终局提示 |

### 13.3 零服务器房间目录

- 固定目录房间：`saltline-directory-v1`。房主发布房号、模式、昵称、人数和阶段，5 秒心跳，18 秒无心跳自动过期。
- 目录成员各自保存房间记录副本；当前目录主为最小 Peer ID，目录主掉线后在线成员自动得出下一任。
- 加入弹层进入「零服务器」面板即可刷新列表，点选房间直接走原有 P2P 房号加入；公共分片仍是另一条免房号匹配轨道。
- Nostr 仍是目录和游戏房间的引导信令，不保存游戏状态；严格意义上不是完全无网络依赖。

## 13.2 补充（用户 2026-11-14 指定）：零服务器模式公私双轨

| 轨 | 房间名 | 流程 |
|---|---|---|
| 私人房 | `slp-{4位码}`（appId 命名空间内） | 建：本地生成 4 位码→joinRoom→等 peer 选举；进：输码 joinRoom——与 ws 模式的码体验一致 |
| 公共房（免码） | `slpub-{mode}-{n}`，n=1..9 分片 | 点「公共匹配」→ 依次探测分片 n=1,2,3…（joinRoom 后 1.5s 数 peer）：<4 人即留驻；≥4 人离房试下一片——分布式匹配，无需房列表 |

- 公共房到达 4 人后：后续探测者跳走下一分片；房内 5th peer（竞态同到）由 host 广播"满员"礼貌驱逐（回 lobby 提示试下一片）
- 公共房无房码概念：lobby 显示「公共房 · {mode} · 分片 {n}」；分享按钮改为复制"同文件+公共匹配"指引
- 选举/满员/驱逐判定全部由 peer 集合本地可算（peers+selfId），无中心
