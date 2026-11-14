# Saltline 中文本地化清单（L10N Manifest）

> 版本：v1.0（2026-11-13）
> 依据：六路只读侦察（UI / flow / player-combat / enemies / world / runtime）+ 补充扫描（武器铭文 rig.js、贴纸纹理 textures.js、气体标签 detailed-builders.js）。
> 行号基准：当前工作区 `G:/ai/code/saltline`（抽查锚点 flow.js:717 / hud.js:55,99,190 / runtime.js:198 / menus.js:80,156 / rig.js:882 均已复核）。
> 术语基线：与 [GLOSSARY-zh.md](GLOSSARY-zh.md)（已锁定术语）严格对齐；本清单对其提出 2 处修订建议（见 §1.2）。
> 品牌红线：保留 SALTLINE 品牌与原作署名，诚实标注来源，不做"几猫"式贴牌。

---

## 0. 总则

**调性**：硬核港区军事风——短促、冷静、命令式。UI 短词用军事简洁体；无线电台词要有电流感和指挥腔（呼号开场、破折号停顿）；启动文案保持原版的"港务作业"隐喻。避免口语化、避免卖萌。

**一律保留不译**：
- 品牌名 `SALTLINE` / `Saltline`
- 型号与编号：`PAC-9`、`HX-2`、`HX-2291`、`SLT-R4`、`PA-004217`、`GEN-0`、`B4-07`、`SLTU 482915 7`（ISO 箱号 ×6）、机身编号前缀 `H-`/`G-`
- 罗盘方位字母 `N / NE / E / SE / S / SW / W / NW`（hud.js:10-19）
- 距离单位 `m`（hud.js:402）；撤离代号 `EX`（flow.js:312）
- 键帽：`WASD / E / Space / Shift / C / Ctrl / Esc / P / Enter / IJKL / RT / LT / A / B / X / Y / L3 / Start`
- 火力选择标记 `S / 1 / A`、轨距标记 `T2…T12`（rig.js:876-881）
- 触屏暂停图标 `II`（input.js:275）

**书写规范**：破折号统一 `—`（em dash），间隔号 `·`；中文与数字/字母之间不加空格（窄体视觉）；标点用全角。

---

## 1. 术语表

### 1.1 已锁定术语（沿用 GLOSSARY-zh.md）

| 原文 | 译名 |
|---|---|
| DEPLOY | 开始行动 |
| REDEPLOY | 再次部署 |
| relay | 中继 |
| uplink | 上行链路 |
| extraction | 撤离 |
| HARBORMASTER | 港务主控 |
| gull | 机械飞鸥（短名"飞鸥"） |
| hound | 机械猎犬（短名"猎犬"） |
| debrief | 行动简报 |
| rating | 行动评级 |
| signal lost | 信号中断 |
| apron | 装卸区 |
| berth | 泊位（Berth 4 → 4号泊位） |
| health | 生命状态 |

**评级六档**（flow.js:717，数组按索引 0-5 取值，顺序绝不可换）：Messy=险象环生 / Loud=火力全开 / Steady=稳扎稳打 / Clean=干净利落 / Sharp=精准果断 / Surgical=完美突击。

### 1.2 本清单新增术语

| 原文 | 译名 | 说明 |
|---|---|---|
| Breacher | 破障手 | 玩家角色呼号 |
| Port Authority Breach Unit | 港务局破障分队 | |
| Control（电台呼号） | 指挥部 | |
| yard / shed / quay（三中继分区） | 堆场 / 检修棚 / 岸壁 | 见修订建议② |
| Machines destroyed | 击毁机器 | 结算统计项 |
| Weak point | 弱点命中 | 击杀流后缀 |

**修订建议**（需回写 GLOSSARY-zh.md）：
1. 评级占位：menus.js:119 的默认 `Clean` 是占位符，运行时必被 flow.js:717 覆盖——两处都要换成"干净利落"，避免首帧闪英文。
2. `quay` 原映射"泊位"与 Berth 4（4号泊位）撞车：分区语境改译**岸壁**（码头岸壁），"Relay C — Quay" → "中继 C — 岸壁"；装卸区语境照旧。

---

## 2. 技术红线（动手前必读）

1. **字体无 CJK**：fonts.css 全部 22 个 woff2 的 unicode-range 只覆盖 latin/latin-ext/vietnamese/cyrillic。必须新增中文子集字体（推荐 Noto Sans SC / 思源黑体子集 woff2），插入 ui.css:18-22 的 `--f-display / --f-label / --f-mono` 三个变量栈；否则静默回退 Impact/Arial Narrow/system-ui，工业窄体风格全失。
2. **贴纸管线**：世界贴纸全部经 textures.js 的 `d()/qa()` canvas 栅格化（入口 textures.js:1170）。stencil 字体会逐字符画 destination-out 竖向"桥切口"，豁免集 `rA` 只含拉丁字符（textures.js:135-155）——**中文贴纸会被从正中划一道竖线**。对策：中文贴纸强制 `font:"sans"`，或把 CJK 码段加入豁免。`d()` 的 toUpperCase() 对中文无副作用，但 CJK 全宽字符会让固定构图贴纸溢出（qa 有 maxW 缩放但整块变矮）——每处翻译后核对 decal 四边形宽高比。
3. **源码转义陷阱**：`—` 以 `\u2014`、`·` 以 `\xB7` 转义书写（menus.js:80/156/117/148/152、flow.js:53/56/654/521、input.js:112/114 已证实）；校验脚本必须同时匹配转义形态与渲染形态。`"Cut relay "`（flow.js:641）、`"Relay "`（flow.js:304）、`"Contact — "`（flow.js:521）等字面量**含尾随空格**，替换时保留。
4. **运行时模板必须保形**：`Cut the remaining ${P} relays`（flow.js:358）、`Hold ${_e} — ${k}`（hud.js:292）、`Quality was picked for this device (${U || "default"})`（menus.js:227）、`<b>${ce}</b> destroyed`（hud.js:196）——插值与标签不动，只译文言。禁止全局查找替换，按本清单逐点改。
5. **存储值不可直译**：QUALITY_NAMES（menus.js:14）`low/medium/high/ultra` 同时是 localStorage 键 `saltline.settings.v1` 的存储值——**只做显示层映射**（低/中/高/极高），存储值不变，免旧档迁移。同理新增昵称等多人字段建议开新键（见 MP-BLUEPRINT §⑦）。
6. **无障碍一起翻**：aria-label 清单——menus.js:78/90/97/109/116/129、input.js:275（触屏按钮 Fire/Aim/Reload/Jump/Interact/Pause）。
7. **文档元数据**：index.html `lang="en"` → `zh-CN`；meta description 与 `<title>` 同步（§3.1）；boot 屏 SALTLINE 品牌字保留。
8. **打字机速率按拉丁调校**：电台字幕 58 字符/秒（hud.js:567）、目标行 46 字符/秒（hud.js:536）。中文信息密度高，建议中文降至约 8-12 字/秒（或按台词时长参数反推速率），并复核 .comms/.h-obj 容器宽度，否则长台词显示时长失衡。
9. **大写+窄体+字距视觉**：中文无大小写。`.m-word` SALTLINE 标题、按钮、眉头小字的 letter-spacing 需收窄重调；按钮文案保持 2-6 字。
10. **切屏 CSS 集合封闭**（多人联动提示）：ui.css:1069-1071 属性选择器只认 title/paused/dead/complete 四值；新增 lobby 屏要同步 CSS + menus.js:295 焦点逻辑 + menus.js:372-383 show() 分支。

---

## 3. 必译清单（131 条）

> 条目计数规则：一行多个并列词条（如速查栏一行 5 词）计 1 条，因为是同一次替换动作。

### 3.1 index.html（4 条：docs 2 + boot 2）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 12 | Saltline — cut the port's three uplinks and reach the boat. | meta description（搜索/分享卡片） | Saltline — 切断港区三条上行链路，登上撤离船。 |
| 14 | Saltline | `<title>` 浏览器标签页 | Saltline（保留） |
| 24 | SALTLINE | 启动屏品牌大字 `#boot .boot-mark` | SALTLINE（保留，不译） |
| 25 | Raising the terminal | 启动屏默认文案 `#boot-msg`（加载中被 runtime.js 覆盖） | 正在竖起港区终端 |

### 3.2 src/app/runtime.js — 启动进度（10 条，boot）

| 行 | 原文 | 语境（进度%） | 建议译文 |
|---|---|---|---|
| 83 | Waking the renderer | 4% 渲染器 | 正在唤醒渲染器 |
| 94 | Mixing paint, rust and rain | 12% 材质 | 调和油漆、铁锈与雨水 |
| 169 | Stacking containers | 34% 关卡 | 吊装集装箱 |
| 171 | Raising the cranes | 50% 远景吊车 | 立起龙门吊 |
| 175 | Flooding the apron | 58% 地面水面（GLOSSARY 锁定译法） | 淹没装卸区 |
| 189 | Loading tracers and smoke | 66% 特效 | 装填曳光弹与烟幕 |
| 196 | Checking the rifle | 74% 武器 | 检查步枪 |
| 198 | Waking the Harbormaster | 82% 敌人 | 唤醒港务主控 |
| 205 | Waiting for first light | 92% 首帧 | 等待第一缕天光 |
| 238 | Ready | 100% 完成后 boot 屏淡出 | 就绪 |

### 3.3 src/app/diagnostics.js（1 条，boot）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 18 | Saltline could not start:  | fatal 错误页前缀（`#fatal`，启动失败兜底） | Saltline 无法启动： |

### 3.4 package.json（1 条，docs）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 5 | Local, editable restoration of the published Saltline browser game. | 工程自述 description | 已发布 Saltline 浏览器游戏的本地可编辑复原版。 |

### 3.5 src/ui/menus.js（70 条，ui）

#### title 屏（14 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 78 | Saltline | title 屏 section aria-label | Saltline（保留） |
| 80 | B4 | 眉头泊位编号 `<span class="m-tag">` | B4（保留） |
| 80 | Port Authority Breach Unit | 眉头单位名 | 港务局破障分队 |
| 80 | Saltline Terminal \xB7 05:42 | 眉头时间地点（\xB7=·） | Saltline 港区 · 05:42 |
| 81 | SALTLINE | 主标题美术字 h1.m-word | SALTLINE（保留） |
| 82 | The port's security net has gone feral. Cut its three uplinks. Reach the boat. | 前提一句话（源码 port's） | 港区安防网已经失控。切断它的三条上行链路。登上那艘船。 |
| 84 | Deploy | 主按钮（多人版旁加 创建/加入房间，见 MP-BLUEPRINT） | 开始行动 |
| 85 | Settings | 按钮（同串另有 103 暂停屏 / 133 页签） | 设置 |
| 86 | Controls | 按钮（同串另有 104 暂停屏 / 134 页签） | 操作 |
| 88 | Every surface, machine and sound is generated in your browser. Nothing is downloaded. | 底部程序化生成声明 | 所有场景、机械与音效均在你的浏览器中实时生成，不下载任何资源。 |
| 90 | Controls at a glance | 右侧速查栏 aria-label | 操作速查 |
| 91 | Move / Look / Fire / Aim / Reload | 速查行1 标签词（键帽 WASD/Mouse/LMB/RMB/R 不译） | 移动 / 视角 / 开火 / 瞄准 / 换弹 |
| 92 | Cut relay / Jump / Sprint / Crouch / Pause | 速查行2 标签词（键帽 E/Space/Shift/C/Esc 不译） | 切断中继 / 跳跃 / 冲刺 / 蹲伏 / 暂停 |
| 93 | Touch / Left thumb moves / Right thumb looks / Fire \xB7 Aim \xB7 Reload \xB7 Jump on screen | 速查触屏行 | 触屏 / 左手拇指移动 / 右手拇指视角 / 开火 · 瞄准 · 换弹 · 跳跃均在屏幕上 |

#### paused 屏（5 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 97 | Paused / Signal lost | section aria-label | 已暂停 / 信号中断 |
| 98 | Operation on hold | 眉头小字 | 行动暂停 |
| 99 | Paused | 标题 h2 | 已暂停 |
| 102 | Resume | 主按钮（多人下只恢复本地，不停世界） | 继续 |
| 105 | Restart mission | 按钮（多人下须改房间级重启请求） | 重开任务 |

#### dead 屏（6 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 109 | Signal lost | section aria-label | 信号中断 |
| 110 | Breacher down | 眉头小字 | 破障手阵亡 |
| 111 | Signal lost | 标题 h2 | 信号中断 |
| 112 | Time survived | 统计项 dt | 存活时间 |
| 112 | Relays cut | 统计项 dt | 已切中继 |
| 113 | Retry | 主按钮（多人下改观战/等待队友） | 重试 |

#### complete 屏（10 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 116 | Debrief | section aria-label | 行动简报 |
| 117 | Berth 4 \xB7 Debrief | 眉头小字 | 4号泊位 · 行动简报 |
| 118 | Saltline is dark | 标题 h2 | Saltline 全网断电 |
| 119 | Rating | 评级行标签 | 评级 |
| 119 | Clean | 评级默认占位 b（运行时被 flow.js:717 覆盖，**两处都要换**） | 干净利落 |
| 121 | Time | 统计项 dt（用时） | 用时 |
| 122 | Accuracy | 统计项 dt | 命中率 |
| 123 | Machines destroyed | 统计项 dt | 击毁机器 |
| 124 | Retries | 统计项 dt | 重试次数 |
| 126 | Redeploy | 主按钮 | 再次部署 |

#### 设置对话框（14 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 129 | Settings and controls | 对话框 aria-label | 设置与操作 |
| 135 | Close | 关闭按钮 | 关闭 |
| 14 | low / medium / high / ultra | 画质分段按钮（QUALITY_NAMES，menus.js:139 渲染；**兼存储值，只做显示映射**） | 低 / 中 / 高 / 极高 |
| 138 | Graphics quality | 设置页标签 | 画质 |
| 140 | Mouse sensitivity | 设置页标签 | 鼠标灵敏度 |
| 141 | Invert Y | 设置页标签 | Y 轴反转 |
| 141 | On / Off | 反转开关文案（menus.js:224 运行时切换） | 开 / 关 |
| 142 | Master volume | 设置页标签 | 主音量 |
| 143 | Field of view | 设置页标签 | 视野（FOV） |
| 144 | Display | 显示行标签 | 显示 |
| 144 | Enter fullscreen / Exit fullscreen | 全屏按钮（menus.js:267 运行时随状态切换） | 进入全屏 / 退出全屏 |
| 227 | Quality was picked for this device (${U \|\| "default"}). Lower it if the frame rate struggles. | auto 档画质说明（含插值） | 画质已按本机自动选定（${U \|\| "默认"}）。帧率吃紧时可调低。 |
| 228 | Quality changes apply at once; shadows and reflections may take a moment to rebuild. | 手动档画质说明 | 画质更改即时生效；阴影与反射重建需要片刻。 |
| 250 | Fullscreen is not available here | 全屏失败提示（写 `#fs-t`） | 当前环境无法使用全屏 |

#### 操作对话框（19 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 148 | Keyboard \xB7 Mouse | 小节标题 | 键盘 · 鼠标 |
| 43 | Move / Look / Fire / Aim / Reload / Cut relay / Jump / Sprint / Crouch / Melee / Pause | 键盘表 dt 词表（与速查栏 91/92 同源，多 Melee；键帽不译） | 移动 / 视角 / 开火 / 瞄准 / 换弹 / 切断中继 / 跳跃 / 冲刺 / 蹲伏 / 近战 / 暂停 |
| 44 | Mouse | Look 行 dd | 鼠标 |
| 45 | Left button | Fire 行 dd（左键） | 左键 |
| 46 | Right button | Aim 行 dd（右键） | 右键 |
| 48 | Hold \<kbd>E\</kbd> | Cut relay 行 dd | 按住 E |
| 51 | \<kbd>C\</kbd> or \<kbd>Ctrl\</kbd> | Crouch 行 dd | C 或 Ctrl |
| 53 | \<kbd>Esc\</kbd> or \<kbd>P\</kbd> | Pause 行 dd | Esc 或 P |
| 149 | If the browser will not capture the mouse, hold a mouse button and drag to look (left also fires, right also aims). Arrow keys or IJKL turn, Enter fires. | 鼠标捕获说明长文 | 若浏览器无法锁定鼠标，按住鼠标键并拖动即可转动视角（左键同时开火，右键同时瞄准）。方向键或 IJKL 也可转向，回车开火。 |
| 150 | Touch | 小节标题 | 触屏 |
| 58 | Left thumb, anywhere | 触屏表 移动 dd | 左手拇指，任意位置 |
| 59 | Drag the right side | 触屏表 视角 dd | 拖动屏幕右侧 |
| 60 | Hold FIRE, drag to track | 触屏表 开火 dd（FIRE 为屏上按钮名） | 按住「开火」并拖动追踪 |
| 61 | AIM toggles | 触屏表 瞄准 dd | 「瞄准」为切换开关 |
| 62 | RLD / JUMP | 触屏表 换弹/跳跃 dd | 换弹 / 跳跃 |
| 64 | Hold USE at a relay | 触屏表 切断中继 dd（USE 为屏上按钮名） | 在中继旁按住「使用」 |
| 65 | Push the stick fully forward | 触屏表 冲刺 dd | 摇杆推满即冲刺 |
| 151 | Gamepad | 小节标题 | 手柄 |
| 152 | Sticks move and look \xB7 RT fire \xB7 LT aim \xB7 A jump \xB7 B crouch \xB7 X reload \xB7 Y cut relay \xB7 L3 sprint \xB7 Start pause. | 手柄映射长文（键名不译） | 双摇杆移动与视角 · RT 开火 · LT 瞄准 · A 跳跃 · B 蹲伏 · X 换弹 · Y 切断中继 · L3 冲刺 · Start 暂停。 |

#### 地点卡（2 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 156 | Saltline Terminal \xB7 Berth 4 \xB7 05:42 | 左下地点卡主行（menus.js:384 locationCard 控显隐） | Saltline 港区 · 4号泊位 · 05:42 |
| 156 | Port Authority Breach Unit \u2014 one breacher, no backup | 地点卡副行（单人叙事，**多人版需按队伍改写**） | 港务局破障分队 — 单人渗透，没有后援 |

### 3.6 src/ui/hud.js（15 条，hud）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 10-19 | N / NE / E / SE / S / SW / W / NW | 罗盘方位字母 GC 表 | 保留原文（罗盘刻度惯例） |
| 55 | Objective | 目标面板小标签 .h-k | 目标 |
| 55 | Relays | 中继计数行标签（旁随 0/3） | 中继 |
| 99 | Vitals | 生命面板小标签 .h-k | 生命体征 |
| 120 | Control | 电台字幕说话人标签 .comms-who | 指挥部 |
| 190 | Weak point | 击杀流弱点后缀 `<em>` | 弱点命中 |
| 194 | machine | 敌型名兜底（实际值 GULL/HOUND 转大写） | 机器 |
| 196 | `<b>${ce}</b> destroyed` | 击杀信息流模板（**建议渲染层把 GULL→飞鸥、HOUND→猎犬**；多人需加击杀者前缀） | `<b>${ce}</b> 已击毁` |
| 292 | Hold ${_e} — ${k} | 交互提示模板（键位 E/USE/Y 按设备自适应 hud.js:283-287） | 按住 ${_e} — ${k} |
| 402 | m | 标记距离单位后缀（`ut+"m"`） | 保留 m |
| 491 | Reloading | 弹药状态提示（换弹中） | 换弹中 |
| 494 | Reload | 弹药状态提示（触屏空仓） | 换弹 |
| 495 | R — Reload | 弹药状态提示（键鼠空仓） | R — 换弹 |
| 496 | Empty | 弹药状态提示（彻底无弹） | 弹尽 |
| 498 | Low ammo | 弹药状态提示（低弹量） | 弹药不足 |

### 3.7 src/game/flow.js（21 条：radio 7 + hud 14）

#### 无线电台词 _l（7 条，radio；打字机字幕 + radio:line 事件驱动配音）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 53 | Breacher, this is Control. The Harbormaster holds the berth. Cut its three uplinks \u2014 yard, shed, quay. | 开场简报（intro 约 1.3s 处播） | 破障手，这里是指挥部。港务主控把守着泊位。切断它的三条上行链路——堆场、检修棚、岸壁。 |
| 54 | It has seen you. Gulls fly, Hounds walk. Put them down. | 首次被敌发现（enemy:alert，一次性） | 它看见你了。飞鸥在天上飞，猎犬在地上走。把它们全部放倒。 |
| 56 | One relay dark. It felt that \u2014 machines inbound. | 切第 1 座中继后 | 一座中继已断电。它察觉到了——机器正在逼近。 |
| 57 | Two dark. It is throwing everything it has left at you. | 切第 2 座中继后 | 两座断电。它把压箱底的火力全砸过来了。 |
| 59 | All three dark. The boat is holding at the quay ladder, south end. Run. | 三中继全灭、撤离船就位 | 三座全部断电。船就候在岸壁南端的舷梯旁。快跑。 |
| 60 | You are hit hard. Get behind steel and breathe. | 血量首次低于 30（一次性） | 你伤得不轻。退到钢板后面，喘口气。 |
| 61 | Breacher is aboard. Saltline is dark. Good work. | 登船撤离成功瞬间 | 破障手已登船。Saltline 全网断电。干得漂亮。 |

#### HUD 目标/提示/评级（14 条，hud）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 352 | Get to the boat | 目标行动态文案 D()（全切后） | 登船撤离 |
| 355 | Cut the three uplink relays | 目标行初始文案 | 切断三座上行中继 |
| 357 | Cut the last relay | 目标行（剩 1 座） | 切断最后一座中继 |
| 358 | Cut the remaining ${P} relays | 目标行（剩 N 座，模板字面量） | 切断剩余 ${P} 座中继 |
| 402 | Resume recaptures the mouse. | 暂停屏 lookMode 行提示 | 「继续」会重新锁定鼠标。 |
| 641 | "Cut relay " + V.short | 交互提示前缀（short 为 A/B/C；**含尾随空格**；多人下改队友切割提示） | "切断中继 " + A/B/C |
| 654 | Relays still live \u2014 the boat will not wait under fire | 未切完进撤离圈提示（8s 冷却） | 中继未全部断开 — 船不会在火线下久留 |
| 312 | EX | 撤离点罗盘/世界标记短码 | 保留 EX |
| 313 | Boat | 撤离点标记 label 字段（当前 HUD 只渲染 short，label 备用） | 撤离船 |
| 717 | Messy, Loud, Steady, Clean, Sharp, Surgical | 评级六档数组（**按索引取值，顺序不可换**） | 险象环生、火力全开、稳扎稳打、干净利落、精准果断、完美突击 |
| 41 | NORTH / NORTH-EAST / EAST / SOUTH-EAST / SOUTH / SOUTH-WEST / WEST / NORTH-WEST | 罗盘方位数组 jC（8 档 45°，拼入 Contact 警告=广播方位，GLOSSARY 规范） | 北方 / 东北方 / 东方 / 东南方 / 南方 / 西南方 / 西方 / 西北方 |
| 304 | "Relay " + V.short | 罗盘路标标签兜底（**含尾随空格**） | "中继 " + A/B/C |
| 521 | "Contact — " + jC[方位] | 波次来袭方向警告前缀（**含尾随空格**） | "接敌 — " |
| 599 | Hauled out of the water | 落水获救浮动消息（player:rescued） | 已从水中捞起 |

### 3.8 src/input/input.js（6 条，ui）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 110 | Touch controls active | lookmode 触屏模式描述（暂停屏/开局消息） | 触屏操作已启用 |
| 112 | Mouse capture unavailable \u2014 move the mouse to look, rest it at a screen edge to keep turning \xB7 click fires \xB7 arrows or IJKL also turn | lookmode 拖拽降级模式描述 | 无法锁定鼠标 — 移动鼠标转动视角，指针停在屏幕边缘可持续转向 · 点击开火 · 方向键或 IJKL 亦可转向 |
| 114 | Mouse captured \u2014 Esc releases it | lookmode 已捕获描述 | 鼠标已锁定 — 按 Esc 释放 |
| 115 | Click the view to capture the mouse | lookmode 待点击描述 | 点击画面以锁定鼠标 |
| 275 | FIRE / AIM / RLD / JUMP / USE（II 为暂停图标） | 触屏 HUD 按钮字（span 文本） | 开火 / 瞄准 / 换弹 / 跳跃 / 使用（II 保留） |
| 275 | Fire / Aim / Reload / Jump / Interact / Pause | 触屏按钮 aria-label（无障碍） | 开火 / 瞄准 / 换弹 / 跳跃 / 互动 / 暂停 |

### 3.9 src/world/level/level.js — 目标标签（3 条，hud）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 146 | Relay A — Yard | 目标 relay_a 标签（坐标 1.5,7.5） | 中继 A — 堆场 |
| 153 | Relay B — Shed | 目标 relay_b 标签（棚屋内 -2,0.03,-19.5） | 中继 B — 检修棚 |
| 160 | Relay C — Quay | 目标 relay_c 标签（码头 23,0,0） | 中继 C — 岸壁 |

---

## 4. 可选翻译 — 世界内贴纸与铭文（49 条，signage）

> 定位：世界模型上的 canvas 贴纸/铭牌，属氛围资产。**建议 P0 全部保留原文**（真实港区本来就满是英文标牌，且 CJK 走 stencil 管线有划字风险，见 §2.2）；P1 择高可见度者翻译（加 ! 标记的 12 条优先）。
> 注意：translate 后必须核对 decal 宽高比；含双空格的串替换时保留格式。

### 4.1 src/world/level/placement.js（5 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 512 | BOAT STN 4 ! | 码头墙面模板字（梯子旁 stencil 黄字） | 接驳船站 4（或保留） |
| 1311 | LANE 1 ! | 门区车道牌（Sf 立柱 stencil 黑字） | 车道 1 |
| 1312 | LANE 2 | 车道牌（1314 行堆场东侧 x+ 侧同串再现，一并改） | 车道 2 |
| 1313 | LANE 3 | 车道牌 | 车道 3 |
| 1315 | BERTH 4 WORKSHOP ! | 棚屋南墙大字 stencil | 4号泊位 检修车间 |

### 4.2 src/world/props/basic-builders.js（17 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 2667 | KELVAR  MARINE  REFRIGERATION（双空格） | 冷藏箱制冷机组厂牌 | KELVAR 船运冷藏（GLOSSARY：公司名音译保留） |
| 535 | MAX GROSS  | 箱门规格贴纸模板（拼 a.gross 数值，如 30,480 KG） | 最大总重（或保留） |
| 542 | TARE  | 皮重贴纸模板 | 皮重（或保留） |
| 549 | CU.CAP.  | 容积贴纸模板（33.2 CU.M 等） | 容积（或保留） |
| 1502 | GATE CONTROL ! | 门卫室标牌 | 门禁管控 |
| 2357 | LOT  | 货架库位批号模板（拼 1000-9999） | 批号（或保留） |
| 2514 | BAY  | 货架巷道标牌模板（拼 A-F + 10-49） | 巷道（或保留） |
| 2527 | MAX 2000 KG / LEVEL | 货架层载重警示 | 每层限重 2000 KG |
| 3058 | RELAY  | 中继面板型号贴纸模板（拼 'ABC'[seed%3]；**与目标系统 A/B/C 错位，见 MP-BLUEPRINT §⑦**） | 中继 |
| 3071 | HARBORMASTER UPLINK ! | 中继面板白字贴纸 | 港务主控上行链路 |
| 3111 | WIRING DIAGRAM  SLT-R4（双空格） | 中继背面接线图小字 | 接线图  SLT-R4 |
| 3123 | ISOLATE BEFORE SERVICE | 中继侧板检修警示 | 检修前先隔离断电 |
| 1827 | AUTHORISED PERSONNEL ONLY ! | 标志牌表 E3 第 1 条（seed 轮换） | 仅限授权人员 |
| 1828 | NO PEDESTRIANS | E3 第 2 条 | 禁止行人 |
| 1829 | HI-VIS AND HELMET | E3 第 3 条 | 反光衣·安全帽 |
| 1830 | AUTOMATED VEHICLES | E3 第 4 条 | 自动化车辆 |
| 1831 | KEEP CLEAR | E3 第 5 条 | 保持净空 |

### 4.3 src/render/materials/textures.js（3 条）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 444 | ARCTIC  \xB7  ATLANTIC  \xB7  FEEDER（双空格） | 集装箱航线贴纸 | 北极 · 大西洋 · 支线运输（GLOSSARY 已定） |
| 568 | INTERMODAL  FREIGHT（双空格） | 集装箱多式联运贴纸 | 多式联运（GLOSSARY 已定） |
| 1073 | SAFETY APPROVAL PLATE | CSC 安全铭牌标题（下有 7 行 mono 小字 APPROVAL REF 等；现实 CSC 铭牌为英文） | 安全检验铭牌（GLOSSARY 已定；小字建议保留） |

### 4.4 src/weapons/rig.js — 手中武器铭文（9 条；第一人称常驻可见，优先级高于其他贴纸）

| 行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| 867 | PAC-9 | 枪身型号铭刻 | PAC-9（保留，型号） |
| 868 | LONGSHORE ARMS WORKS  \xB7  SALTLINE（双空格） | 制造商铭刻 | 岸务兵工厂 · SALTLINE（或整串保留） |
| 869 | CAL 5.8\xD740   SN PA-004217 | 口径/序列号铭刻 | 保留（CAL 5.8×40   序列号 PA-004217 或原样） |
| 872 | PROPERTY OF PORT AUTHORITY \u2014 BERTH 4 ARMOURY ! | 财产归属铭刻 | 港务局资产 — 4号泊位军械库 |
| 876-878 | S / 1 / A | 火力选择标记 | 保留（通用枪械标记） |
| 879 | B4-07 | 架位编号 | 保留 |
| 880-881 | T2…T12 | 导轨刻度 | 保留 |
| 882 | HX-2 REFLEX ! | 瞄具铭刻 | HX-2 反射瞄具（GLOSSARY 已定；铭刻位可只译 REFLEX→反射） |
| 883 | 900 LM  IPX8 | 战术灯参数铭刻 | 保留（规格代码） |
| 890-892 | WARNING \u2014 CLEAR CHAMBER BEFORE / STOWAGE. AUTHORISED BREACH / PERSONNEL ONLY. PA-REG 44/7 | 枪身三行警示小字（三行一句） | 警告——存放前先退膛/仅限授权破障/人员使用 PA-REG 44/7 |

### 4.5 其余贴纸（15 条）

| 文件:行 | 原文 | 语境 | 建议译文 |
|---|---|---|---|
| world/props/geometry.js:622-628 | SLTU 482915 7 等 6 个 ISO 箱号 | 箱号贴纸（seed%6 轮换） | 保留（现实箱号即拉丁字符） |
| world/props/character-builders.js:549 | FRAGILE | 纸箱贴纸（第 1 箱） | 易碎 |
| character-builders.js:565 | KEEP DRY | 纸箱贴纸（第 2 箱） | 保持干燥（GLOSSARY 已定） |
| character-builders.js:612 | HX-2291 | 第 5 小箱物料编号 | 保留 |
| world/props/cargo-builders.js:306 | SALTLINE | 叉车配重厂牌 | 保留（品牌） |
| cargo-builders.js:798 | LPG | 煤气罐组红 stencil | 液化气（或保留 LPG） |
| cargo-builders.js:1285 | GEN-0 | 发电机型号贴纸（拼 1/2） | 保留（GEN-1/GEN-2） |
| cargo-builders.js:1484 | DANGER ! | 发电机红色警示 | 危险 |
| cargo-builders.js:1614 | DIESEL ! | 发电机燃油标识 | 柴油 |
| cargo-builders.js:1806 | B4 WASTE  | 垃圾箱编号（拼 11/12，尾随空格） | B4 废料 |
| cargo-builders.js:2172 | MAINT  | 工具车编号（拼 1/2，尾随空格） | 维保 |
| world/props/detailed-builders.js:869 | SALTLINE TERMINAL | 电缆卷筒铭牌（三元组选一） | Saltline 港区（或保留） |
| detailed-builders.js:1408 | ACETYLENE / OXYGEN / ARGON / PROPANE | 气体钢瓶标签四选一（seed 轮换） | 乙炔 / 氧气 / 氩气 / 丙烷（GLOSSARY 危险品类已定） |
| src/enemies/drone.js:102 | H- | hound 机身编号前缀（H-03…H-10） | 保留（涂装编号） |
| src/enemies/walker.js:83 | G- | gull 机体编号前缀（G-11…G-20） | 保留（涂装编号） |

---

## 5. 多人版联动新增文案（待补，不计入本清单）

多人化后会新增一批本清单没有的文案，按本清单调性另行撰写：房间大厅（创建房间/加入房间/房间码/等待玩家/房主开局）、断线与重连提示、队友事件字幕（"队友已登船""全员阵亡"）、队伍结算卡、地点卡多人版副行（替换 menus.js:156 的单人叙事）。挂载点见 [MP-BLUEPRINT.md](MP-BLUEPRINT.md) §④。

---

## 6. 统计

| 类别 | 条数 |
|---|---|
| ui（menus.js 70 + input.js 6） | 76 |
| hud（hud.js 15 + flow.js 14 + level.js 3） | 32 |
| boot（index.html 2 + runtime.js 10 + diagnostics.js 1） | 13 |
| radio（flow.js 电台台词） | 7 |
| docs（index.html meta/title + package.json） | 3 |
| **必译小计** | **131** |
| signage（世界贴纸与铭文，可选翻译） | 49 |
| **总计** | **180** |
