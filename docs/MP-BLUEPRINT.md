# Saltline 多人合作版集成蓝图（MP Blueprint）

> 版本：v1.0（2026-11-13）
> 目标：4 人在线合作——共同切断三座上行中继、全员登船撤离。
> 依据：六路只读侦察（runtime / flow / player-combat / enemies / world / UI）+ 汇总复核（行号锚点抽查吻合）。
> 行号基准：当前工作区 `G:/ai/code/saltline`。姊妹文档：[L10N-MANIFEST.md](L10N-MANIFEST.md)。

---

## ① 架构决策：房主权威模拟 + WS 纯中继房间服务器

**拓扑**：`Node + ws 房间服务器（纯中继） ⟷ 房主客户端（权威模拟） ⟷ 3 个普通客户端（提线木偶 + 本地预测）`

- 服务器职责仅限：房间生命周期（创建/加入/离开/满员 4）、消息路由与广播、房间码分发、断线清理。**不跑任何游戏逻辑**。依赖零新增——package.json:27 已预置 `ws ^8.22.2`。
- 房主（第一个玩家）独占：敌 AI 感知与状态机、波次/生成队列、追击期、全部伤害结算（玩家射击 hitscan、敌方射击、AoE、坠落/落水/回血）、切割进度与完成、撤离判定、房间时钟 c.time、retries。其余客户端：本地玩家移动/视角/开火手感全部本地（客户端预测），世界状态消费房主快照。
- 选型理由（对比三种方案）：
  1. **lockstep 不可行**：敌 AI 用会话级共享随机流 h.rng（enemies.js:72，`createRandom(eseed||9001)`），感知节流 0.11-0.19s、dt 钳 0.05 导致两端调用时序必然不同；flow.js 刷怪把 context.rng 抽样与本地玩家坐标混算（flow.js:439-474）；nav.randomPoint 用裸 Math.random（physics.js:313-314）。多端独立模拟必然得到三个不同的世界。
  2. **专用服务器模拟代价高**：碰撞盒不是独立数据文件，而是建关时从 mesh userData.colliders 经 matrixWorld 注册（buildings.js:201-246），服务器模拟需要 headless three + 碰撞重建（textures 依赖 document.createElement('canvas')，rb 有 typeof document 守卫但 mats.label 需 stub）——为一个 4 人 PVE 做这个不划算。
  3. **房主权威最便宜**：静态世界 seed 确定（见②）免几何同步；全 hitscan 无投射物；敌方开火令牌全局同时最多 2-3 只（enemies.js:161-180），事件天然稀疏；快照+事件带宽约 10KB/s 级；4 人合作 PVE 无对抗，信任边界宽松（朋友局），房主权威的作弊面可接受。
- 代价：房主掉线 = 房间终止（v1）或主机迁移（v2，见⑦-R8）。

## ② 确定性判定：同 seed ⇒ 同关卡（静态世界成立；动态实体不成立）

**成立**（免同步静态世界的地基，证据链）：
- runtime.js:38 — `rng: createRandom(+(params.seed || 4207))`：URL `?seed` 是世界种子唯一注入口。房间握手时服务器/房主生成 seed 下发，各端以同 seed 走 createLevel。
- buildings.js:35 — 关卡构建 `r = i.rng.fork()` fork 一次主 rng，驱动全部摆放抖动与集装箱变体 seed（buildings.js:318-331）→ 同 seed 同摆放。
- detail-geometry.js:564/569 — 每个道具内部 `rng = createRandom((seed+1)*7919 + name.length*131)`，**与调用顺序解耦**，由 seed 单值决定一切细节 → 同 seed 必得同关卡（几何/碰撞体/导航网格/贴纸逐字节一致）。
- 结论：房间只需广播一个整数 seed；晚加入者同 seed 重建 + 服务器补发房间状态（已切中继、房主快照）即可入局。

**不成立**（必须房主权威广播，不能各端自跑）：
- flow.js:439-474 — 刷怪落点选择把 context.rng 抽样与本地玩家坐标 n.pos、本地视线 lineOfSight 混算 → 各端发散。
- physics.js:310-322 — nav.randomPoint 用裸 Math.random，与房间 seed 完全脱钩。
- enemies.js:72 — 敌共享 h.rng 会话流，两端调用时序必异（死亡翻滚、感知节流、巡逻选点全走它）。
- 附注：buildings.js 存在 context.rng 缺失时的 Math.random 兜底分支——MP 下必须保证 rng 存在，否则静默 desync；未来任何新增随机消费一律 `rng.fork()` 独立流（weapon.js:373 / water.js:423 已是此模式），绝不抽主流。

## ③ 协议契约草案（JSON over WS，`t`=房间时钟秒；v1 文本帧，后续可换二进制）

### 信令层 C→S
```
{t:"hello", v:1, name}
{t:"createRoom", name, seed?}          // seed 缺省服务器生成并回发
{t:"joinRoom", code, name}
{t:"leave"}
{t:"start"}                            // 仅 host
{t:"restart", skipIntro, quick}        // 仅 host；keepRetries 语义见 flow.js:319
{t:"toHost", p:<游戏载荷>}              // 客户端→房主隧道
```
### 信令层 S→C
```
{t:"joined", roomId, code, you:{id}, hostId, seed, players:[{id,name,ready}]}
{t:"roomState", phase:"lobby|playing|debrief|ended", players:[{id,name,alive,aboard,kills,deaths}], code}
{t:"peerEvent", kind:"join|leave|kick|disconnect", player}
{t:"fromHost", p:<游戏载荷>}            // 房主→全员隧道
{t:"error", code, msg}                  // ROOM_FULL / GAME_STARTED / HOST_GONE / BAD_CODE
```

### 游戏载荷（经 toHost/fromHost 隧道）

**上行 C→H：**
- playerState @15Hz：`{k:"ps", id, seq, t, pos:[x,y,z], yaw, pitch, vel:[vx,vy,vz], fl:位集(crouch|sprint|ads|alive|aboard|fire), hp}` — 传结果不传输入，规避输入重放一致性（player.js 移动是无固定步长的指数平滑物理，无法重放）。
- interact：`{k:"ix", id, relay, on:true|false}` — 切割开始/停止；房主校验距离 ≤2.2m（GAME_FLOW.interactRange）与朝向 ≥0.45（interactFacing）后累计进度。
- shot：`{k:"sh", id, o:[3], d:[3], t}` — 房主执行 combat.playerShot 逻辑并广播结果；同时校验发射频率（weapon.js 的 bloom/heat/burst 全在客户端，服务器至少拿时间戳限速）。
- evt（可选表现）：`{k:"ev", id, e:"jump|land|reload|melee", ...}`。

**下行 H→C：**
- peers @15Hz 批量：`{k:"peers", t, states:[playerState…]}`（不含接收者自己）。
- snap @10Hz（增量，阈值外重发全量）：`{k:"snap", t, cut:[bool×3], relayT, pursuit:{left}, enemies:[{nid,ty,pos:[3],yaw,vel:[3],hp,md,aim:[yaw,pitch]}]}`。字段依据：pos 直连 group.position（walker.js:100 / drone.js:125）；md=模式枚举（hound 的 es / gull 的 atk，或改用 telegraph 事件+本地计时）；每敌约 35-45 字节，池上限 18 只。
- eevt 敌事件：`{k:"ee", e:"spawn", nid, ty, pos, opts}`（**opts 原样下发**——passive/patrolLine/hover/state 决定初始姿态，drone.js:239 / walker.js:167）；`{e:"retire", nid}`（**必须新增**：enemies.js:286 现在完全无事件，池复用后不广播则客户端留幽灵木偶+netId 张冠李戴）；`{e:"fire", nid, pos, dir}`（视觉弹无伤害，源事件 walker.js:570 / drone.js:763）；`{e:"telegraph"|"melee", nid, …}`（walker.js:532 / drone.js:504,535,590）；`{e:"killed", nid, by:playerId, ds:deathSeed}`（ds 派生死亡动画随机：gull lostRotor/spin walker.js:261-283、hound dieRoll/diePitch drone.js:900-910——否则两端死亡动画不对齐）。
- combat：`{k:"cb", e:"impact"|"hitEnemy"|"hitPlayer"|"playerDead", …}` — 对应现有事件名（combat.js:42-48），hitEnemy 带 attacker 归属。
- obj：`{k:"ob", e:"progress", relay, t}` / `{e:"done", relay}` / `{e:"all"}` — 沿用 objective:progress/done/all（flow.js:626/663/676）事件语义，HUD/音效/罗盘路标（audio.js:877、flow.js:297 q()）全部免改。
- relay 状态：`{k:"rs", relay, s:"live|cutting|cut"}` — 驱动 setState（basic-builders.js:3407）；晚加入者在 level.js:20-49 的 place 选项传 `state:"cut"` 重建（builder 原生支持初始态，天线倒伏动画 80 帧内快进到位）。
- room：`{k:"rm", e:"aboard", id}` / `{e:"complete", stats:{time,retries,players:[{id,kills,accuracy,deaths}]}}` / `{e:"wipe"}`。

**带宽估算**：上行 4×15Hz×~48B ≈ 2.9KB/s 至房主；快照 18 敌×~45B×10Hz ≈ 8KB/s 广播——家庭宽带无压力。

## ④ 各模块挂钩点清单（file:line）

### 网络装配与主循环
| 挂钩点 | 说明 |
|---|---|
| src/app/runtime.js:30 startGame() | net 模块总装配入口 |
| runtime.js:67 initializeSystem(h,f,p,d) | `await initializeSystem("net","net",()=>createNet(context))`；**必须在 core/fallbacks.js:9 FALLBACKS 表加 `net` 兜底**——忘加则连接失败直接走 showFatalError 白屏（runtime.js:74-77 兜底链、game.js:6） |
| runtime.js:194 前（audio 之后、createPlayer 之前） | net 装配次序：快照消费早于玩家创建 |
| runtime.js:257 帧循环 + 270-273 | `updateSystem("net",p)` 插在 input tick（:270）之后、game.update（:273）之前：快照先于模拟应用；且 title/paused 态 net 照常 tick（支撑大厅/重连）。net 内部必须自兜 try/catch——updateSystem 每系统只记一次错（runtime.js:251-253） |
| runtime.js:38 ?seed | 房间 seed 注入：握手成功后写入 params.seed 再建关（晚加入者同 seed 重建） |
| runtime.js:148-152 showcase 分支 | ?show= 模式 stub 掉 player/enemies——net 装配需加 showcaseName 守卫跳过 |
| runtime.js:228 autostart | 联机构建抑制（截图/基准模式单方面开局=副作用） |
| src/core/events.js:1 | 事件桥：net 只单向订阅本地事件外发，入站走独立入口直接 emit——总线无 once()、同步派发、handler 抛错被吞（events.js:20-22），必须防"本地 emit→转发→远端 emit→再转发"回环；注意单 payload 约定（effects.js 的 .emit 是粒子发射器，同名不同物） |

### UI / 菜单
| 挂钩点 | 说明 |
|---|---|
| menus.js:83-87 title 屏 .m-actions | 插「创建房间/加入房间」按钮（data-act="host"/"join"），与 DEPLOY 并列 |
| menus.js:326 动作统一分发 | 新按钮自动进 flow.js:79-110 动作表；join 需房间码输入框（menus.js:342 焦点圈只收 button,input——加 input 没问题） |
| menus.js:372-383 show() + ui.css:1069-1071 | 新 lobby/connecting 屏：dataset.screen 加值要同步 CSS 选择器集合 + menus.js:295 H() 焦点逻辑 |
| menus.js:390+ setDead/setDebrief | 合作战绩：队伍总击杀、各队友卡、房级评级（本地 combat.stats 在 flow.js:707 取，多人需汇总） |
| menus.js:4/6 settings | 玩家昵称/房间偏好：开新 localStorage 键或扩 DEFAULT_SETTINGS（注意旧档字段过滤迁移） |
| menus.js:105 / :113 | 暂停屏 Restart、死亡屏 Retry 按钮语义房间化（房主权限/观战/等待） |
| menus.js:156 地点卡 | "one breacher, no backup" 单人叙事按队伍人数改写 |
| src/app/boot-screen.js:9 setBootProgress | WS 建连/等待房主阶段复用启动屏进度位 |
| flow.js:816 | 启动完成 l.show("title") 后分岔单机/多人入口 |

### 任务状态机 flow.js（改动最集中的文件）
| 挂钩点 | 说明 |
|---|---|
| flow.js:79-110 动作表 | deploy=建房或加入完成；restart/retry/redeploy 全部改 RPC（现在是本地 U() 直接重开） |
| flow.js:146 / :319 U() | 收房间 start 广播后各端统一调用；keepRetries 语义房级 |
| flow.js:152+392 G()、:380-384 | **暂停降级**：失焦/指针解锁/visibilitychange 只开本端覆盖菜单（停输入/停音频/释放指针），绝不切 game:state、绝不冻结模拟；:385-391 title 回车直接开局要移除（开局权归房主） |
| flow.js:158 update | 敌生成与中继完成两个分支改为消费服务器广播 |
| flow.js:159 debugCut | **封死**：跳过距离/朝向校验直接完成目标，联机是现成作弊后门 |
| flow.js:169 game:state | intro/playing/dead/complete 由房主广播（audio.js:1254、enemies.js:549 在消费）；paused 退化为本地态不上广播 |
| flow.js:247 H() 全量重置 | 重开由房主触发广播，c.time/retries 清零全端同步执行 |
| flow.js:501 F() + :523 X() + :566-574 | 波次构建/生成泵/存活计数：仅房主跑，生成结果（类型+位置+时刻）广播；maxAlive=9 全局上限按房间判定；Q() 选点参考最近玩家而非固定 n.pos；Contact 方位告警按全体玩家位置均值 |
| flow.js:619-639 ue() 切割循环 | 服务器权威：客户端上报 interact 开始/停止+位姿，房主校验后累计 L.t 并组播 objective:progress；建议任一玩家按住即推进、无人按住才倒扣（现松手 1.6x/s）；多人同时切割是否叠加加速=规则决策（建议叠加但上限 2 倍） |
| flow.js:660/663 me() + :676 objective:all | 完成与全灭开关房级唯一（房主权威），各端只做表现回放（震屏/电台/路标刷新） |
| flow.js:683 player:dead | **合作语义手术**：单人版直接终局；改为还有队友存活→倒地/观战，全员倒地才广播房间失败 |
| flow.js:697-706 ee() 撤离 | 改"全员登船"（见⑦-R6 语义决策）；time/retries 取房级，accuracy/kills 逐人聚合 |
| flow.js:712-717 评级 | 房级口径重定义（房级 time/retries + 队伍聚合命中率） |
| flow.js:744 c.time += dt | 房间权威时钟——生成队列时刻表（:517 c.time+1.6+i*0.85）、评级阈值（:714 270/400s）、出生点复用窗口（:451 6s）的共同基准；本地暂停绝不能冻结它 |
| flow.js:88/97 + :321 retries | 房间共享（房间整体 restart 计一次）；个人另设 deaths |

### 玩家 / 战斗 / 武器
| 挂钩点 | 说明 |
|---|---|
| player.js:53 createPlayer | 本地玩家保留（客户端预测）；远端玩家各建实例但 update()（:251）读 context.input 单例——远端走"网络位姿插值+航位推测"路径，禁止喂本地输入 |
| player.js:112 reset(spawn) | 服务器分配出生点：单一 playerStart（level.js:139-142，-32,0,6）按玩家 id 偏移（gate 走廊 -38..-24 有天然空间）+ 初始 yaw 广播 |
| player.js:153-170 damage / :171-173 heal | 房主权威结算并广播，客户端只表现；player:hit/player:dead 事件由房主下发 |
| player.js:366 坠落伤 / :374-382 落水救援 / :417-423 延迟回血 | 房主侧复制规则：落水救援=瞬移回 lastSafe+强制掉头+自伤 12，网络视角就是瞬移外挂，必须房主判定广播；lastSafe 更新规则（:371 仅 quay 一侧）多端一致 |
| player.js:258-261 死亡分支 | 死后仍跑下落物理但禁输入；远端死亡后停发 pos 只发姿态，防"尸体滑行" |
| combat.js:4 stats + :10-12 kills | **击杀归属**：enemy:killed 事件必须带 attacker 字段，否则 4 人各自把全队击杀记到自己头上 |
| combat.js:18 playerShot | 客户端只报 {origin,dir}，房主跑 hitscan（physics.raycast + enemies.raycast 双重检测，弱点×2.2）并广播 impact/player:hitEnemy |
| combat.js:66-79 enemyShot | **硬编码 context.player 单例**（圆柱判定：中心 pos+1、半径 0.38、半高 0.95）——房主侧遍历玩家列表逐个判定，对命中者下发 player:hit |
| combat.js:95-121 explode | AoE（含 lineOfSight、玩家半额）：房主对全体玩家结算；gull 自爆（walker.js:340）是调用方 |
| weapon.js:543 Be() + :580-585 weapon:fire | 广播源：{origin,dir,muzzle,ads}（dir 已含散布）驱动远端枪口闪/tracer/枪声 |
| weapon.js:519-536 Fe() reload | weapon:reload{phase,empty} 广播（远端换弹动画+可闻 cue） |

### 敌人子系统（host/puppet 缝合）
| 挂钩点 | 说明 |
|---|---|
| enemies.js:71-72 createEnemies | 每端一份实例：host 跑完整 AI，客户端 puppet 模式；eseed 本地随机流不做 lockstep |
| enemies.js:514/522 U.update | puppet 缝合点：把 :522 的 `_update` 换成 applySnapshot+只跑姿态半段；弹丸推进 _()（:342，含 :362 对玩家伤害）host 专属；探照灯 H()（:393）纯装饰客户端本地 |
| walker.js:343 x() 行级分界 | :344-440（think/轨道目标/三向触须避障/速度积分）host 专属；:445-473 姿态朝向/俯仰横滚/旋翼转速、:474-498 频闪、:499-517 云台/枪口、:583-598 受损冒烟全是**状态纯函数**，喂快照即活 |
| drone.js:450 S() 行级分界 | :450-707（think/导航/交战 es 状态机/分离推力/贴地）host 专属；步态 H()（:772）与 IK 姿态 O()（:833）、信标闪、镜头色、音频是状态纯函数；O() 内 :898 从 matrixWorld 刷新 headPos，puppet 本地照跑则 U.raycast（:462）弱点命中自动有效 |
| enemies.js:184 h.think | 感知写死 context.player 单目标（45m/200°锥/LOS）——host 抽象成 players[] 选最近可见者；快照带 targetId 供 HUD 威胁指示与云台推导 |
| enemies.js:439/453/456 spawn + 自增 id | host 广播 spawn{netId(用自增 id),type,pos,opts}；客户端同路调 spawn 并登记 netId→本地池对象映射 |
| enemies.js:286 retire | **必须补 enemy:retire 广播**（gull 坠毁、hound 沉底、残骸超 5、池腾位都会静默移除） |
| enemies.js:491 clear | 房间重开/回大厅 host 广播，客户端清 puppet 映射 |
| enemies.js:498 alert | 各端 weapon:fire/explosion 位置（:539-548 监听只认本地玩家）上报 host，由 host 统一警觉传播 |
| walker.js:151 / drone.js:216 damage | 房主权威伤害入口：客户端命中请求交 host 执行，enemy:hit/enemy:killed 结果广播；客户端不直接扣血 |
| walker.js:297-342 g() 死亡动画 | 末尾本地调 combat.explode AoE（:338-341）——puppet 端必须 gate 成纯视觉 |
| enemies.js:590 showcaseEnemies | 展示实例与对局共用池创建路径——隔离，避免 puppet 映射被打乱 |

### 世界 / 种子 / 目标物
| 挂钩点 | 说明 |
|---|---|
| level.js:13 createLevel | 多人核心契约：房间只广播 seed，四端各自 createLevel 得到逐字节一致世界+碰撞体+目标点 |
| level.js:20-49 + :128-131 relay 摆放 | 中继 seed 1/2/3；顺带修贴纸字母错位（'ABC'[seed%3]=B/C/A 与目标 A/B/C 颠倒，见⑦-R13） |
| basic-builders.js:3407 setState / :3452 e.state | relay 视觉状态 live/cutting/cut 广播；晚加入者初始态重建 |
| level.js:377 + placement.js:765 extraction | 撤离点 (29,0,20) 半径 2.5——**单人尺寸漏斗**，4 人合作放大半径或改多登船点（见⑦-R6） |
| buildings.js:257-263 placed 清单 | {name,x,y,z,yaw} 现成可序列化世界快照：服务器留档校验/未来增量同步 |
| physics.js:22 createPhysics / :310-322 | 服务器权威命中校验复用点：AABB 列表可脱离渲染 headless 重建（需 three 数学或 stub）；nav.randomPoint 的 Math.random 改种子化或房主下发 |
| props.js:19 props.build | 多人专属道具注册口（名牌/复活信标/共享弹药箱）：选项可序列化即自动获得全端一致 |

### HUD
| 挂钩点 | 说明 |
|---|---|
| hud.js:227-241 setRelays | 共享目标进度：消费服务器广播（任一玩家切割推进全员），本地 c.cut 弃用 |
| hud.js:243-272 setMarkers | 扩展 kind="mate" 队友方位标记（名字+距离），与中继/撤离同套罗盘+世界投影双渲染 |
| hud.js:300-309 + :552-572 radio | 电台队列为房间事件开放入队：队友加入/掉线/阵亡/登船/全灭走同一字幕通道（台词按 L10N-MANIFEST 调性新增） |
| hud.js:192-196 feed | enemy:killed 事件带 shooter id：区分"你击毁/队友 XX 击毁" |
| hud.js:273-292 setPrompt | 切割进度 t 服务器权威并广播（进度环才一致）；合作提示词"队友正在切割" |

## ⑤ 远端玩家化身方案

**现成素材盘点（含负发现）**：
- character-builders.js 名不副实——只注册 tarp_cargo/sandbags/cardboard_boxes，**全库无人形模型**，这是 MP 美术工作量最大的一项。
- 可复用资产：
  - enemies/models.js:301 createWalkerModel（四足腿足底盘）与 :801 createDroneModel（旋翼），以及 iu 骨架 + pm SkinnedMesh 蒙皮管线、程序化姿态函数（状态纯函数：drone.js:833 O()、walker.js:445-517 尾段——喂 pos/yaw/vel/flags 即活，与敌机同构）。
  - rig.js 的武器视图模型（PAC-9）可缩放挂到化身手部。
  - props.build 注册表（props.js:19）：新化身作为 prop 注册，选项可序列化即自动全端一致。
  - 名牌：复用 mats.label canvas 管线（textures.js:1170）或 Sprite+canvas，渲染"名字 + 距离"。

**分级方案**：
- **P0（首版可玩，1-2 天）**："装备胶囊"化身——胶囊体 + 头盔/配色区分玩家位 + 胸前名牌 + 手持步枪杆件，全用现有材质；死亡倒伏、 aboard 后消失。足够辨认与瞄准。
- **P1（打磨，约 1 周）**：复用 models.js 蒙皮管线新做轻量人形（躯干/头盔/四肢约 12 骨），程序化步态/冲刺前倾/蹲伏/ADS 举枪——输入即 playerState 的 flags，与敌机姿态函数同构。
- 不推荐：直接拿 hound 四足当队友形象（辨识混乱）。

## ⑥ 主循环插入点（汇总）

1. **装配**：runtime.js startGame() 内 audio 分支之后、createPlayer（:194）之前：`await initializeSystem("net","net",()=>createNet(context))`；core/fallbacks.js:9 FALLBACKS 加 `net: () => ({stub:true, update:()=>{}})` ——断网/房间满自动回落单机，启动永不因联机失败而死。
2. **帧循环**：runtime.js:257 setAnimationLoop 内，`updateSystem("input",p)`（:270）之后、`game.update`（:273）之前插 `updateSystem("net",p)` ——服务器快照先于本地模拟应用；title/paused 态照常 tick（大厅、断线重连都在跑）。net 自兜 try/catch + 断线重连状态机（updateSystem 错误吞噬坑，runtime.js:251-253）。
3. **host 模拟**：host 的 enemies/combat/flow 改造沿用现有循环位（runtime.js:273-280 的 [d] 门控分支）；client 侧 enemies.js:522 换 applySnapshot。
4. **事件桥**：net 单向订阅本地事件外发（weapon:fire / objective:* / enemy:* / game:state），入站独立入口直接 emit；防回环（events.js 无 once、同步派发）。
5. **开发环境**：vite.config.js:6-8 绑死 127.0.0.1:5173 strictPort——局域网联机改 `host:"0.0.0.0"`，并加 `server.proxy` 的 `/ws` 键（ws 服务器独立端口则免）；部署注意 `base:"./"` 相对路径假设。

## ⑦ 风险与未决问题

| # | 风险/问题 | 证据 | 对策 |
|---|---|---|---|
| R1 | **暂停即冻结全世界**：失焦/指针解锁/标签隐藏自动暂停 + 帧循环 paused 门 | flow.js:375-384、:392-408；runtime.js:319 state 门 | MP 下 pause 降级为纯本地覆盖（停输入/开菜单/停音频），不切 game:state；否则一人 Alt-Tab 全房冻结 |
| R2 | **刷怪 RNG 不可复现**：rng 抽样混本地玩家坐标+视线；nav 裸 Math.random | flow.js:439-474；physics.js:313-314 | 房主独占生成并广播；Q() 选点改参考最近玩家 |
| R3 | **单玩家假设遍布全链**：enemyShot 硬编码唯一玩家；敌 AI 只瞄本地玩家；击杀计数无归属 | combat.js:69-79；enemies.js:184、drone.js:450,589,743、walker.js:340；combat.js:10-12 | 房主侧 players[] 化 + enemy:killed 加 attacker；本子系统最大结构改造点 |
| R4 | **retire 无事件+池复用** | enemies.js:286 | 补 enemy:retire 广播，否则幽灵敌人/netId 错乱 |
| R5 | **作弊后门**：debugCut 跳过全部校验；autostart；title 回车开局 | flow.js:159、:385-391；runtime.js:228 | 联机构建封死或仅房主调试位可用 |
| R6 | **玩法语义未定**（决策点）：撤离半径 2.5m 4 人挤不下；全员登船 vs 任一登船；阵亡队友算不算失败；死亡后观战还是倒地可救；多人切割是否加速；4 人难度（waves 配比/maxAlive=9/pursuitExtra=5） | placement.js:765、level.js:377；flow.js:647-657、:683、:697；flow.js:6-38 | 建议：半径放大 4-5m 或多登船点；全员到齐才算（倒地可扶起为 P1）；切割叠加但上限 2 倍；4 人波次 1.5 倍、maxAlive 12 |
| R7 | **主 rng 流顺序敏感**：任何人在共享流上加一次抽取/改装配顺序，同 seed 两端世界错位 | runtime.js:38；各 props 构建期大量抽取 | 纪律：新增随机一律 fork；建议建关改显式 seed 参数不走全局 rng |
| R8 | **房主迁移未设计**：房主掉线=房间死 | 架构 | v1=房间结束回大厅并提示；v2=晋升新房主+全量快照交接（需快照可整局重建：cut/pursuit/敌人表/time/retries） |
| R9 | **落水救援=瞬移** | player.js:374-382 | 房主判定广播；lastSafe 规则多端一致 |
| R10 | **打字机速率按拉丁调校** | hud.js:567（58 字/秒）、:536（46 字/秒） | 与汉化联动：中文 8-12 字/秒或按台词时长反推 |
| R11 | **本地结算漂移**：伤害/回血/坠落伤各端自算 | player.js:153-170、:366、:417-423 | 全部房主权威；extraction 的 invulnerable/enabled 同步（flow.js:697-699） |
| R12 | **射击校验盲区**：射速/散布状态（bloom/heat/burst）全在客户端 | weapon.js:594-601 | 上报 fire 时间戳做限速；朋友局信任 + 事后回放校验 |
| R13 | **relay 贴纸字母与目标系统错位**（seed 1/2/3 → B/C/A） | level.js:20-49 vs objectives | MP 重构顺手修：place 选项补 id |
| R14 | **死亡动画随机取自共享 h.rng** | walker.js:261-283、drone.js:900-910 | killed 事件带 deathSeed（或以 netId 做种） |
| R15 | **命名交叉陷阱**：walker.js 造会飞的 gull、drone.js 造地面四足 hound；模型同样交叉（gull 用 createDroneModel，hound 用 createWalkerModel） | enemies.js:31-32 ENEMY_TUNING 映射 | 改文件前先对表，本子系统最高频翻车点 |
| R16 | **vite dev 绑 127.0.0.1 strictPort** | vite.config.js:6-8 | 局域网改 host 0.0.0.0 + /ws proxy；线上注意 base:"./" |
| R17 | **中文渲染**：无 CJK 字体 + stencil 切口切汉字 | fonts.css；textures.js:135-155 | 见 L10N-MANIFEST §2.1-2.2 |

**未决问题清单**（需产品决策）：房间码格式（4-6 位大写）与断线重连窗口（建议 60s 内可重进保留战绩）；观战实现（死亡后自由相机 vs 队友视角）；部署形态（公网 ws 服务器 vs 局域网直连）；协议版本握手（hello.v 不匹配即拒）；单人模式与多人模式共存开关（title 屏 DEPLOY=单机、创建/加入房间=多人，或 DEPLOY 进大厅）。

**里程碑建议**：M0 房间服务器+大厅 UI（创建/加入/房主开局）→ M1 双人可见（playerState 同步+胶囊化身+击杀归属）→ M2 房主权威敌人（快照+spawn/retire/fire 事件）→ M3 目标房间化（切割/撤离/结算聚合）→ M4 暂停降级+断线重连+4 人难度重调。
