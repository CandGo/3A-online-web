# 化身建模交接文档（给外部 AI / 美术重画第三人称士兵）

> 目标：重画第三人称玩家化身（当前版本被认为不够好看）。本文自包含全部约束，读完即可动手。
> 工程根目录：`G:\ai\code\saltline`（Three.js r180 vendored，Vite，纯 JS 无框架）

## 1. 你只能改的文件

| 文件 | 角色 |
|---|---|
| `src/net/avatar.js` | **建模+动画本体（你要重写的）**，现 ~700 行 |
| `src/net/remote-players.js` | 消费方（尽量不动；只在挂点协议必须变时微调） |

**只许 import 不许改**：`src/weapons/weapon.js`（导出 `buildGunWorldModel(opts)` 现成 PAC-9 世界枪，0.8775m/30,660 三角，含铭文+HX-2 瞄具）、`src/weapons/rig.js`（导出 `Vv` = 第一人称手套构建器，1:1 真实尺度，可继续 graft 也可不用）、其它一切。

## 2. 导出接口（一字不可变，74 条断言会查）

```js
export function createAvatar(THREE, opts) → {
  root,                 // THREE.Group，挂场景；yaw 旋转作用于 root
  applyPose(state, dt), // 每帧姿态驱动（动画全在这里，帧率无关，吃 dt）
  setVisible(b),
  dispose(),            // 必须释放自建 geometry/material（共享资源走引用计数）
  setColor(slot),       // 四色位 0-3：青/橙/紫/黄（染头盔+背心，等 remote-players colorOf）
  setHitFlash(),        // 受击红闪（~120ms）
  muzzleWorld(out),     // 枪口世界坐标（枪口闪/曳光用；无枪时回退眼位偏移）
}
```
`THREE` 从参数传入（工程用 vendored three，**不许 `import * as THREE from 'three'`**）。

## 3. 枪械挂载（已有现成方案，建议沿用）

- `buildGunWorldModel()` → `{group, muzzle, grip, foregrip}`（枪枢轴原点=握把；muzzle/grip/foregrip 是定位节点）。
- 挂载基准：`grip` 对位右手，偏差 ≤2cm；`muzzleWorld()` 每帧从枪口节点取世界位。
- 左手托 `foregrip`（弹匣井→护木前 1/3）；ADS 时枪线抬至 ~1.44m。
- 若你重画手/臂，保持双手触枪（五姿态 idle/walk/sprint/crouch/ads 腕锚接触 ≤3cm）。
- 手套可继续用 `Vv`（9.7k 三角/只，含指节缝线）——那是第一人称同款，风格统一最省事。

## 4. applyPose(state, dt) 的 state 字段（消费方 remote-players.js 每帧喂）

`{ speed, vy, crouch, sprint, ads, alive, aboard, fireT, yaw, pitch }`（以 remote-players.js 实际调用点为准，动手前先读）。
动画谱系必须覆盖：idle 呼吸 / walk 腿摆正弦（频率随 speed）/ sprint 前倾大步 / crouch 屈腿降高 / ads 举枪至眼线 / fire 后坐（枪后移+上挑）/ **death 后倒 ~86° 0.45s 定格**（复活自愈复位）/ land 下沉回弹。全部程序化（正弦+缓动，禁 AnimationClip/gltf）。

## 5. 命中判定对齐（硬约束，模型必须和判定体咬合）

PvP 命中是解析几何（`src/net/hitbox.js`），模型部件几何中心必须落在下表 **±3cm** 内（站立）：

| 部位 | 中心(x,y,z) | 尺寸 |
|---|---|---|
| 头（球） | (0, 1.62, 0) | r=0.13（蹲伏 1.38） |
| 躯干（圆柱） | (0, 1.15, 0) | r=0.20 半高0.33（蹲 1.00/半高0.28） |
| 腿 | (±0.10, 0.42, 0) | r=0.09，**触地 y=0** |
| 臂 | (±0.27, 1.18, 0.04) | r=0.07 |
| 盔顶身高 | ~1.74-1.80 | |

看到在哪=打到在哪，超差就是"看着打中了没判定"。

## 6. 美术语言（这个游戏的画风）

- 全程序化几何：原语（Box/Cylinder/Sphere/Capsule）+形变/倒角/细几何做细节（参考 `src/world/props/basic-builders.js` 的集装箱、`src/enemies/models.js` 的机械敌人）。
- 细节层级对标 `src/weapons/rig.js` 的手套（指节/缝线/铆钉级）。
- 材质：`MeshStandardMaterial` 纯色+程序化做旧参数；**禁新建纹理文件**（canvas 代码内生成可以）。
- 预算：身体 ≤15,000 三角（当前 4,128——空间很大，往细节堆）；深色装备色（fatigues/gear/dark 三档），四色位只染头盔+背心。
- 港区雨夜冷色调世界，士兵要"读得清"但不出戏。

## 7. 验收（改完必须全绿）

```sh
node scripts/test-avatar-v2.mjs    # 74 断言：接口/对齐/面数/动画通道/换色/倒伏
npm run build                      # 构建绿
```
视觉自查：浏览器开 `scripts/avatar-preview.html?solo=1&pose=idle`（支持 `&pose=walk|sprint|crouch|ads|death`、`&yaw=`、`#相机` hash）。
最终 E2E（双人互见/爆头判定）由本仓库 owner 跑，你不用管。

## 8. 纪律

- 只动 `src/net/avatar.js`（+必要时 remote-players.js 微调），其余文件零改动。
- 别删功能通道（fire 后坐/land 回弹/setHitFlash 等都要在）。
- 分支 `zh-multiplayer`，改完不 commit 也行（owner 验收后统一提交）。
