#!/usr/bin/env node
// scripts/test-pvp-hitbox.mjs — PvP 分部位命中判定无头断言（MP-PVP §9.0/§9.1）
// 覆盖：站立/蹲伏两张表逐字数值、pos 平移 + yaw 旋转换算（yaw 语义以 player.js
// 实测为准：forward=(0,0,-1) 绕 Y 旋 yaw → 局部 z 前 = 世界 (-sin,0,-cos)）、
// §9.0 表逐部位打点、边界（正好打脚 y=0 / 脚尖 0.01 / 头顶 1.75 擦边 / 1.76 脱靶）、
// 最近部位优先（手臂遮挡躯干）、俯射球体入射、空射 null、
// 倍率换算（头 61.6 两枪致死 / 躯干 28 四枪 / 四肢 19.6 六枪）。
// 运行：node scripts/test-pvp-hitbox.mjs（退出码 0/1）

import { playerHitboxes, raycastPlayerParts } from "../src/net/hitbox.js";

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed.push(label);
}
function close(a, b, label, eps = 1e-6) {
  ok(Math.abs(a - b) <= eps, `${label} (${a} ≈ ${b})`);
}
function shoot(origin, dir, state) {
  return raycastPlayerParts(origin, dir, state);
}
const STAND = { pos: [0, 0, 0], yaw: 0, crouch: false };
const CROUCHED = { pos: [0, 0, 0], yaw: 0, crouch: true };
const FWD = [0, 0, 1]; // 从目标前方（-Z 侧）射来的水平弹道
const FROM_X = [-1, 0, 0]; // 从目标右侧（+X 侧）射来

// ———— 表结构（§9.0 逐字）————
let boxes = playerHitboxes(STAND);
ok(boxes.length === 7, "站立 7 部位");
const byName = Object.fromEntries(boxes.map((b) => [b.part, b]));
ok(
  ["head", "torso", "hips", "leg_L", "leg_R", "arm_L", "arm_R"].every((n) => byName[n]),
  "部位命名 head/torso/hips/leg_L/leg_R/arm_L/arm_R",
);
close(byName.head.center[1], 1.62, "head 中心 y=1.62");
close(byName.head.r, 0.13, "head r=0.13");
ok(byName.head.mult === 2.2, "head mult=2.2");
close(byName.torso.center[1], 1.15, "torso 中心 y=1.15");
close(byName.torso.r, 0.2, "torso r=0.20");
close(byName.torso.half, 0.33, "torso 半高 0.33");
close(byName.hips.center[1], 0.86, "hips 中心 y=0.86");
close(byName.leg_L.center[1] - byName.leg_L.half, 0, "腿触地 y=0（中心 0.42 - 半高 0.42）", 1e-9);
ok(byName.leg_L.mult === 0.7 && byName.arm_R.mult === 0.7, "四肢 mult=0.7");
close(byName.arm_R.center[0], 0.27, "arm_R 局部 x=+0.27");
close(byName.arm_R.center[2], -0.04, "arm_R 局部 z=+0.04（前方=-Z）", 1e-9);

// pos 平移
let moved = playerHitboxes({ pos: [10, 0, 5], yaw: 0 });
close(moved[0].center[0], 10, "head center 含 pos.x 平移");
close(moved[0].center[2], 5, "head center 含 pos.z 平移");

// yaw 旋转（yaw=π/2：前 → -X，右 → -Z；局部 (x,z) → 世界 (−z, −x)）
let spun = Object.fromEntries(
  playerHitboxes({ pos: [0, 0, 0], yaw: Math.PI / 2 }).map((b) => [b.part, b]),
);
close(spun.leg_R.center[0], 0, "yaw=π/2 leg_R 世界 x=0", 1e-9);
close(spun.leg_R.center[2], -0.1, "yaw=π/2 leg_R 世界 z=-0.10", 1e-9);
close(spun.arm_R.center[0], -0.04, "yaw=π/2 arm_R 世界 x=-0.04", 1e-9);
close(spun.arm_R.center[2], -0.27, "yaw=π/2 arm_R 世界 z=-0.27", 1e-9);

// 蹲伏表（§9.0 逐字）
let cr = Object.fromEntries(playerHitboxes(CROUCHED).map((b) => [b.part, b]));
close(cr.head.center[1], 1.38, "蹲伏 head y=1.38");
close(cr.torso.half, 0.28, "蹲伏 torso 半高 0.28");
close(cr.hips.center[1], 0.74, "蹲伏 hips y=0.74");
close(cr.leg_L.r, 0.1, "蹲伏腿 r=0.10");
close(cr.leg_L.center[1] - cr.leg_L.half, 0, "蹲伏腿仍触地 y=0", 1e-9);
close(cr.arm_R.center[1], 1.05, "蹲伏 arm y=1.05");
close(cr.arm_R.center[2], -0.1, "蹲伏 arm 局部 z=+0.10", 1e-9);

// ———— 逐部位打点（站立，yaw=0）————
let r1 = shoot([0, 1.62, -5], FWD, STAND);
ok(r1 && r1.part === "head" && r1.mult === 2.2, "头线 y=1.62 → head ×2.2");
let r2 = shoot([0, 1.75, -5], FWD, STAND);
ok(r2 && r2.part === "head", "头顶 1.75 擦边（切线 epsilon）→ head");
ok(shoot([0, 1.76, -5], FWD, STAND) === null, "1.76 高于头顶 → null");
let r3 = shoot([0, 1.15, -5], FWD, STAND);
ok(r3 && r3.part === "torso" && r3.mult === 1, "胸线 y=1.15 → torso ×1.0");
close(r3.dist, 4.8, "torso 入射距 5-0.20=4.80");
let r4 = shoot([0, 0.79, -5], FWD, STAND);
ok(r4 && r4.part === "hips", "腰线 y=0.79（躯干下沿 0.82 之下、腿之上的 hips 露出带）→ hips");
let r5 = shoot([5, 0.3, 0], FROM_X, STAND);
ok(r5 && r5.part === "leg_R", "+X 侧射小腿 → leg_R");
close(r5.dist, 4.81, "leg_R 入射距 5-0.19=4.81");
let r6 = shoot([5, 0, 0], FROM_X, STAND);
ok(r6 && r6.part === "leg_R", "正好打脚 y=0（板边界含端）→ leg_R");
let r7 = shoot([5, 0.01, 0], FROM_X, STAND);
ok(r7 && r7.part === "leg_R", "脚尖 y=0.01（v1 空判区）→ leg_R");
ok(shoot([5, -0.05, 0], FROM_X, STAND) === null, "y=-0.05 入地 → null");
let r8 = shoot([5, 1.18, -0.04], FROM_X, STAND);
ok(r8 && r8.part === "arm_R" && r8.mult === 0.7, "+X 侧射臂 → arm_R ×0.7");
close(r8.dist, 4.66, "arm_R 入射距 5-0.34=4.66");
let r9 = shoot([-5, 1.15, 0], [1, 0, 0], STAND);
ok(r9 && r9.part === "arm_L", "-X 侧胸线：arm_L 先于 torso（最近部位优先）");
close(r9.dist, 5 - 0.27 - Math.sqrt(0.07 * 0.07 - 0.04 * 0.04), "arm_L 入射距（遮挡躯干）");
let r10 = shoot([0, 3, 0], [0, -1, 0], STAND);
ok(r10 && r10.part === "head", "垂直俯射中轴 → head");
close(r10.dist, 1.25, "俯射入射距 3-1.75=1.25");
ok(shoot([0, 1.0, -5], [0, 0, -1], STAND) === null, "空射（背向）→ null");
ok(shoot({ x: 0, y: 1.62, z: -5 }, { x: 0, y: 0, z: 1 }, STAND) !== null, "Vector3 鸭子型入参可用");

// ———— 蹲伏变体 ————
ok(shoot([0, 1.62, -5], FWD, CROUCHED) === null, "站立头线打蹲伏 → null（头已降）");
let c1 = shoot([0, 1.38, -5], FWD, CROUCHED);
ok(c1 && c1.part === "head", "蹲伏头线 y=1.38 → head");
let c2 = shoot([5, 0.05, 0], FROM_X, CROUCHED);
ok(c2 && c2.part === "leg_R", "蹲伏腿 y=0.05 → leg_R");
close(c2.dist, 4.79, "蹲伏 leg_R 入射距 5-0.21=4.79");
let c3 = shoot([5, 1.05, -0.1], FROM_X, CROUCHED);
ok(c3 && c3.part === "arm_R", "蹲伏臂 → arm_R");
close(c3.dist, 4.68, "蹲伏 arm_R 入射距 5-0.32=4.68");
let c4 = shoot([-5, 1.18, -0.27], [1, 0, 0], { pos: [0, 0, 0], yaw: Math.PI / 2 });
ok(c4 && c4.part === "arm_R", "yaw=π/2 侧后射臂 → arm_R（旋转生效）");

// ———— 倍率换算（28 伤/发，§9.0 落点清单）————
const DMG = 28;
function dmgOf(hit) {
  return Math.round(DMG * hit.mult * 10) / 10; // host-sim applyPlayerDamage 同式
}
close(dmgOf(r1), 61.6, "爆头 28×2.2=61.6");
close(dmgOf(r3), 28, "躯干 28×1.0=28");
close(dmgOf(r5), 19.6, "四肢 28×0.7=19.6");
let hp = 100;
hp -= dmgOf(r1);
ok(hp > 0, "一枪爆头不死（38.4）");
hp -= dmgOf(r1);
ok(hp <= 0, "两枪爆头致死链");
hp = 100;
for (let i = 0; i < 3; i++) hp -= dmgOf(r3);
ok(hp > 0, "三枪躯干不死（16）");
hp -= dmgOf(r3);
ok(hp <= 0, "四枪躯干致死");
hp = 100;
for (let i = 0; i < 5; i++) hp -= dmgOf(r5);
ok(hp > 0, "五枪四肢不死（2）");
hp -= dmgOf(r5);
ok(hp <= 0, "六枪四肢致死");

console.log(`PASS pvp-hitbox: ${passed.length} 断言全绿`);
