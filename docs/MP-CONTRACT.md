# Saltline 多人版实施契约（MP Contract）v1

> 本文是并行实施的**唯一接口依据**。所有新模块按 §2 导出签名实现；所有存量文件改造按 §3 挂钩点调用。
> 协议消息名/字段以本文为准，与 MP-BLUEPRINT.md ③ 一致。违反契约 = 构建失败由集成者按本文裁决。

## 0. 产品决策（已定，不再讨论）

| 决策点 | 结论 |
|---|---|
| 模式 | 4 人 PVE 合作（切割中继→全员登船撤离）；单机 DEPLOY 完整保留 |
| 拓扑 | 房主权威模拟 + Node ws 纯中继（`ws ^8.22.2`） |
| 撤离 | 半径 2.5→4.5m；所有存活玩家登船才算完成（aboard 后锁定）；阵亡者无需登船 |
| 阵亡 | 即观战：相机切到最近存活队友身后 3m/高 2m 跟随（无输入）；全员阵亡→房间失败 |
| 死亡救援 | v1 无复活 |
| 多人切割 | 叠加：速率 = 1 + 0.5×(同时切割人数−1)，上限 2.0；松手倒扣照旧 1.6/s |
| 4 人难度 | host 按人数缩放：waves 数量 ×(1+0.4×(n−1)) 取整；maxAlive = 9+3×(n−1)；pursuitExtra = 5+3×(n−1) |
| 房间码 | 4 位大写（去 0/O/1/I）；满 4 人；host 掉线=房间终局回大厅（提示"房主已离开"） |
| 断线重连 | v1 无（掉线=离场，位置清出；对局中重进=拒绝 GAME_STARTED） |
| 暂停 | 联机时降级为纯本地覆盖（见 R1）：停输入/停本端音频/开菜单，绝不切 game:state |
| 作弊面 | 联机模式封死 debugCut/autostart/title 回车开局（R5） |
| 端口/部署 | server/index.js 单进程：HTTP 静态 dist/ + WS 同端口 8787；`npm run mp` 一键起；vite dev 5173 proxy /ws→8787 |

## 1. 目录与文件归属

```
server/index.js          # 新增：HTTP+WS 单进程入口（S 负责）
server/rooms.js          # 新增：房间生命周期/路由/广播（S）
src/net/protocol.js      # 新增：消息常量+编解码+房间码（S）
src/net/net.js           # 新增：createNet 传输+房间+节拍（N）
src/net/remote-players.js# 新增：createRemotePlayers 化身+插值+名牌（R）
src/net/puppet.js        # 新增：createEnemyPuppet 敌人提线木偶（P）
src/net/host-sim.js      # 新增：createHostSim 房主权威模拟胶水（H）
```

存量改造（集成阶段，按 §3）：runtime.js, core/fallbacks.js, game/flow.js, combat/combat.js, player/player.js, weapons/weapon.js, enemies/enemies.js, enemies/walker.js, enemies/drone.js, ui/menus.js, ui/hud.js, ui.css, vite.config.js, package.json。

## 2. 新模块导出签名（实现方必须逐字遵守）

### 2.1 src/net/protocol.js（S）
```js
export const PROTOCOL_VERSION = 1;
export const MSG = { /* 全部 t/k 常量："hello","createRoom","joinRoom","leave","start","restart","lobby",
  "joined","roomState","peerEvent","toHost","fromHost","error",
  "ps","ix","sh","ev","peers","snap","ee","cb","ob","rs","rm" */ };
export function makeRoomCode();            // 4位大写 去混淆字符
export function encode(obj);               // v1: JSON.stringify
export function decode(s);                 // v1: JSON.parse，坏帧返回 null
export const DEFAULT_PORT = 8787;
```

### 2.2 src/net/net.js（N）→ context.net
```js
export function createNet(context) → net {
  mode,            // 'offline' | 'connecting' | 'lobby-host' | 'lobby-client' | 'host' | 'client'
  update(dt),      // 每帧：出站节拍(15Hz ps)、重连退避、插值推进；内部自兜 try/catch
  connected(), roomCode(), selfId(), isHost(),
  players(),       // [{id,name,you,ready,alive,aboard,kills,deaths,lastSeen}] 房间视角
  latency(),       // ms
  createRoom(name, seed?),   // → Promise<{code,seed}>；host 身份
  joinRoom(code, name),      // → Promise<{seed,players}>；client 身份
  setName(name),
  disconnect(reason),
  // 对局控制（仅 host 可发 start/restart/lobby，net 内校验）
  startGame(opts), restartGame(opts), returnLobby(),
  // 房主侧：给 HostSim 的收发面
  host: { onClientPayload(fn),          // (playerId, payload) — ps/ix/sh/ev
          broadcast(payload), to(playerId, payload), playersState() },
  // 客户端侧：给 puppet/remote-players 的收发面
  client: { onHostPayload(fn),          // (payload) — peers/snap/ee/cb/ob/rs/rm
            send(payload) },
  // 本地通知（net 自己的 pub/sub，与 context.events 分离防回环）
  on(evt, fn), off(evt, fn),            // evt: 'phase'|'roomState'|'peerJoin'|'peerLeave'|'start'|'restart'|'lobby'|'error'|'hostGone'
}
```
- 连接：`ws(s)://location.host/ws`（dev 走 vite proxy /ws → 8787）；失败自动回 offline 并 emit error。
- **事件桥铁律**：net 订阅 context.events 的本地事件（weapon:fire/objective:*/enemy:spawn…）仅用于外发；入站消息绝不直接 emit 到 context.events —— 一律经 host-sim / puppet / remote-players 的显式入口（防 R 系回环）。
- peers 应用：15Hz 批量；ps 带 seq 丢弃乱序；远端位姿进插值缓冲（100ms）。

### 2.3 src/net/host-sim.js（H）→ 仅 host 装配
```js
export function createHostSim(context, net, api) → sim {
  update(dt),            // 收客户端载荷、跑房间时钟广播、快照节拍（ps 转发 peers、snap 10Hz）
  // 权威入口（flow/combat/enemies 改造点调用）：
  onInteract(playerId, relayId, on),              // 校验距离≤2.2/朝向≥0.45 后推进/倒扣（多人叠加规则§0）
  onShot(playerId, origin, dir, t),               // 权威 hitscan：physics.raycast+enemies.raycast，弱×2.2；广播 cb.{impact,hitEnemy}
  onEnemyFire(origin, dir),                       // enemies 敌射击钩子 → 对全体玩家圆柱判定 → cb.hitPlayer
  onExplode(pos, radius, dmg, source),            // AoE 对全体玩家（半额+LOS 规则照 combat.js:95-121）
  onPlayerDamage(playerId, dmg, kind),            // 坠落/落水救援等环境伤害的权威结算
  onSpawnRequest(type, pos, opts),                // flow 刷怪走这里（广播 ee.spawn + 本地 spawn）
  onRetire(netId), onClear(),                     // enemies 生命周期广播（ee.retire / clear）
  onObjectiveProgress(relayId, t), onObjectiveDone(relayId), onObjectiveAll(),
  onAboard(playerId), onWipe(), onComplete(stats),
  broadcastState(stateObj),                       // game:state 广播（intro/playing/dead/complete）
  roomTime(),                                     // 房间权威时钟（c.time 替身）
  difficulty(),                                   // 按人数返回缩放后的 waves/maxAlive/pursuitExtra
}
```
- api 参数：{players()} 由 net 提供；sim 不直接 import 其它系统，全部经 context（context.player 之外还需 context.netPlayers——见 §3-I3 注）。

### 2.4 src/net/remote-players.js（R）→ 所有端装配
```js
export function createRemotePlayers(context, net) → rp {
  update(dt),                    // 插值推进、名牌 billboard、死亡倒伏动画、aboard 消失
  count(), list(),               // [{id,name,pos,yaw,pitch,hp,alive,aboard,crouch,sprint,ads,color}]
  byId(id),
  setColorMap(fn) / colorOf(id), // 玩家位配色（0-3 固定四色）
  playFire(id, origin, dir),     // 远端开火表现：枪口闪/tracer/枪声（复用 fx/combat 现有视觉件）
  playReload(id), playDeath(id), playHit(id),
  nametag(id, text),             // 名牌 canvas（复用 mats.label 思路，独立实现避免碰 textures.js）
  dispose()
}
```
- 化身 P0 规格：胶囊体+头盔+四色位配色+胸前名牌+手持枪杆（复用现有材质体系，绝不新建纹理文件）；死亡=倒伏姿态，aboard=隐藏。
- 插值：缓冲 100ms，位置 hermite，yaw/pitch 角度插值；vel 供航位推测（外推上限 250ms）。

### 2.5 src/net/puppet.js（P）→ 仅 client 装配（host 不装）
```js
export function createEnemyPuppet(context, net) → puppet {
  update(dt),                 // 消费缓冲快照：位姿直接写 group.position/yaw、驱动姿态纯函数
  applySnapshot(snap),        // snap.enemies[{nid,ty,pos,yaw,vel,hp,md,aim}]；nid 池映射本地对象；缺失 nid 触发补 spawn 请求
  onSpawn(evt), onRetire(nid), onKilled(evt),   // ee 事件入口（evt.ds=deathSeed 驱动死亡动画随机）
  onFire(evt), onTelegraph(evt), onMelee(evt),  // 纯视觉
  setEnabled(b),              // showcase/bench 模式禁用
  clear()
}
```
- **walker.js 造 gull（会飞）、drone.js 造 hound（地面）**（R15 交叉陷阱）：ty 字段用逻辑名 "gull"/"hound"，映射在 puppet 内做，协议不碰文件名。
- puppet 端 enemies.update 走 §3-I4 的分支：跳过 think/导航/伤害，只跑姿态半段（walker.js:445+ / drone.js:772+ 状态纯函数）。

## 3. 存量文件挂钩（集成阶段实施）

| 文件 | 改造（谁实施谁读原文） |
|---|---|
| runtime.js | initializeSystem("net") 于 audio 后 player 前；FALLBACKS 加 net 离线兜底；帧循环 input 后 game.update 前插 updateSystem("net")；remote-players/puppet/host-sim 按 mode 条件装配（host: host-sim+remote-players；client: puppet+remote-players；offline: 皆无）；?seed 由房间握手写入 params（晚建关） |
| core/fallbacks.js | FALLBACKS.net = () => ({stub:true, mode:'offline', update(){}, on(){}, players:()=>[]}) |
| flow.js | 动作表加 host/join → net；net.on('start'/'restart') → U()；G() 联机降级（不切 game:state）；debugCut/回车开局联机封死；切割循环走 sim.onInteract；波次/追击仅 host 跑且经 sim.onSpawnRequest；c.time 联机取 sim.roomTime()；player:dead 改全员倒地判定（含 remote-players alive 状态）；ee() 撤离全员 aboard 判定（本地 player + remote-players）；评级用房级 time/retries+聚合命中率；目标进度 HUD 消费 ob 广播 |
| combat.js | stats.kills 按 attacker 归属（enemy:killed 加 by 字段）；playerShot 联机时本地只做视觉+net.client.send({k:"sh"})，host 走 sim.onShot；enemyShot 改 sim.onEnemyFire（host）或等待 cb.hitPlayer 表现（client）；explode 改 sim.onExplode |
| player.js | 联机出生点：playerStart 按 slot 偏移（gate 走廊 x±(slot*2.2)）；damage/heal/坠落/落水联机走 sim 权威（client 端仅表现）；死亡后 spectate 相机（跟随最近存活队友，禁输入）；aboard 标志 |
| weapon.js | weapon:fire/reload 事件外发 ev（net 事件桥订阅，本地不动）；远端玩家的开火表现走 rp.playFire |
| enemies.js/walker.js/drone.js | host：think 目标抽象 players[]（本地+remote，取最近可见）；spawn/retire/clear 包 sim 广播；damage 权威入口仅 host 执行（client 收 cb.hitEnemy 只表现血迹）；client：update 走 puppet 分支 |
| menus.js/ui.css | title 屏加「创建房间/加入房间」；lobby 屏（data-screen="lobby"：房间码大字+成员列表+ready+host 的开始按钮+复制码）；connecting/错误 toast；暂停/死亡屏联机文案（Retry→等待房主重开/观战中）；玩家名设置项（localStorage saltline.mp.name） |
| hud.js | 队友方位标记（rp.list→罗盘+世界投影 kind="mate"）；击杀流带射手名；peer join/leave/阵亡/登船电台行；切割进度环消费 ob 广播 |
| vite.config.js | server.host:'0.0.0.0'；proxy {'/ws': {target:'ws://127.0.0.1:8787', ws:true}} |
| package.json | scripts.mp = "node server/index.js"；scripts.dev 不动 |

## 4. 验收门（集成完成后必须全绿）

1. `npm run build` 通过；`node server/index.js` 起 8787 静态+WS。
2. 双端 E2E（自动化）：A 创建房间 → B 加入 → host start → 双端进 playing；B 移动 A 可见（化身+名牌）；B 开火 A 见 tracer；B 切中继 A 见进度环；三中继全切 → 双端撤离判定；A 阵亡 → B 继续打到撤离 → 双端结算。
3. 单机回归：不进房间直接 DEPLOY，全程无 net 副作用（console 无 net 报错）。
4. 断线行为：B 关页 → A 收 peerLeave+电台行；host 关 → B 回大厅提示房主离开。
