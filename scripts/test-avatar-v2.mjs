#!/usr/bin/env node
// scripts/test-avatar-v2.mjs — 化身 v2 无头断言（MP-PVP §9.2/§9.0）
// 覆盖：接口完整性 / Vv 手套 graft 1:1 / 面数账本（身体 ≤15k，手+枪分列）/
// §9.0 判定表逐部件坐标（站立+蹲伏：头球心/躯干中心/hips/腿触地/腿位）/
// 腕锚对位（IK+瞄准）/ 枪挂点不动 / 动画通道冒烟（idle/walk/sprint/ads/fire/
// death/land）/ 四色位换色 / 受击红闪 / muzzleWorld / 双化身共享缓存引用计数。
// 运行：node scripts/test-avatar-v2.mjs（退出码 0/1）

import * as THREE from "../src/vendor/three-r180.js";
import { createAvatar } from "../src/net/avatar.js";

const passed = [];
const failed = [];
function ok(cond, label) {
  if (cond) {
    passed.push(label);
  } else {
    failed.push(label);
    console.error("  ✗ " + label);
  }
}
function close(a, b, label, eps) {
  ok(Math.abs(a - b) <= (eps == null ? 1e-4 : eps), `${label} (${a.toFixed(4)} ≈ ${b})`);
}

const T = THREE;
const DT = 1 / 60;

// —— 工具：世界矩阵更新 + 网格世界几何中心 / 世界 AABB ——
function settle(avatar, state, frames) {
  for (let i = 0; i < (frames || 90); i++) avatar.applyPose(state, DT);
  avatar.root.updateMatrixWorld(true);
}
function meshWorldCenter(mesh) {
  mesh.geometry.computeBoundingBox();
  const c = mesh.geometry.boundingBox.getCenter(new T.Vector3());
  return c.applyMatrix4(mesh.matrixWorld);
}
function nodeWorldBox(node) {
  const box = new T.Box3();
  node.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    box.union(b);
  });
  return box;
}
function findNode(root, name) {
  let out = null;
  root.traverse((o) => {
    if (o.name === name && !out) out = o;
  });
  return out;
}
function trisOf(node) {
  let n = 0;
  node.traverse((o) => {
    if (o.isMesh && o.geometry) {
      if (o.geometry.index) n += o.geometry.index.count / 3;
      else n += o.geometry.attributes.position.count / 3;
    }
  });
  return Math.round(n);
}

// ———— 1. 接口完整性（导出一字不变）————
const av = createAvatar(T, { color: 0x2ee6d6, castShadow: true });
ok(!!av, "createAvatar 返回对象");
for (const k of [
  "root",
  "applyPose",
  "setVisible",
  "setColor",
  "setHitFlash",
  "muzzleWorld",
  "dispose",
])
  ok(typeof av[k] === "function" || (k === "root" && !!av[k]), `接口键 ${k}`);

// ———— 2. Vv 手套 graft 1:1（视图模型锚位）————
const gun = findNode(av.root, "gunR");
ok(!!gun, "枪枢轴 gunR 存在");
let gloveMeshes = [];
gun.traverse((o) => {
  if (o.isMesh && o.geometry.attributes.color && o.geometry.index &&
      o.geometry.index.count / 3 > 5000) gloveMeshes.push(o);
});
ok(gloveMeshes.length === 2, `Vv 双手 graft 就位（${gloveMeshes.length}/2 网格，>5k 三角带顶点色）`);
const handGroups = gun.children.filter((c) => c.isGroup && c !== gun.children.find((x) => x.name === "worldmodel-pac9"));
const gR = gloveMeshes[0] ? gloveMeshes[0].parent : null;
const gL = gloveMeshes[1] ? gloveMeshes[1].parent : null;
ok(!!gR && !!gL && gR !== gL, "双手各自独立手组（挂枪枢轴）");
// 右腕锚（视图模型 1:1 换算）：-(b·(0.006,-0.031,-0.085))
const bR = new T.Quaternion()
  .setFromEuler(new T.Euler(-0.24, 0, 0))
  .multiply(new T.Quaternion().setFromEuler(new T.Euler(0, 0, -Math.PI / 2)));
const qL = new T.Quaternion()
  .setFromEuler(new T.Euler(0, 0, Math.PI / 2))
  .multiply(new T.Quaternion().setFromEuler(new T.Euler(0.06, 0, 0)));
const wrExp = new T.Vector3(0.006, -0.031, -0.085).applyQuaternion(bR).negate();
const grip = [0, -0.1, 0.073];
const wlExp = new T.Vector3(-0.015, -0.062, -0.236)
  .sub(new T.Vector3(grip[0], grip[1], grip[2]))
  .sub(new T.Vector3(0, -0.015, -0.055).applyQuaternion(qL));
{
  const rMesh = gloveMeshes.find((m) => m.position.lengthSq() === 0 && Math.abs(m.parent.position.z - wrExp.z) < 0.01);
  const grpR = gloveMeshes.map((m) => m.parent).find((p) => p.position.distanceTo(wrExp) < 0.01);
  const grpL = gloveMeshes.map((m) => m.parent).find((p) => p.position.distanceTo(wlExp) < 0.01);
  ok(!!grpR, "右手组位置=-(b·掌心偏移)（握把握手 1:1）");
  ok(!!grpL, "左手组位置=护木抓握位（视图模型关键帧 G 1:1）");
  if (grpR) ok(grpR.quaternion.angleTo(bR) < 1e-3, "右手组姿态=b（视图模型握把手姿态）");
  if (grpL) ok(grpL.quaternion.angleTo(qL) < 1e-3, "左手组姿态=H（视图模型托护木手姿态）");
}

// ———— 3. 面数账本（身体 ≤15k；手/枪分列）————
const gunSubtreeTris = trisOf(gun);
const handTris = gloveMeshes.reduce((a, m) => a + m.geometry.index.count / 3, 0);
const bodyTris = trisOf(av.root) - gunSubtreeTris;
const gunOnlyTris = gunSubtreeTris - handTris;
ok(bodyTris <= 15000, `身体面数 ${bodyTris} ≤ 15000`);
ok(handTris > 15000, `Vv 双手面数 ${Math.round(handTris)}（1:1 视图模型量级）`);
ok(gunOnlyTris > 25000, `PAC-9 世界枪面数 ${gunOnlyTris}（不删减）`);

// ———— 4. §9.0 判定表对齐（站立 idle 定格后量坐标）————
const IDLE = { speed: 0, vy: 0, crouch: false, sprint: false, ads: false, alive: true, pitch: 0, fireT: 0, reload: -1 };
settle(av, IDLE, 120);
{
  const head = findNode(av.root, "head");
  const helmet = findNode(av.root, "helmet");
  const vest = findNode(av.root, "vest");
  const hc = meshWorldCenter(head);
  close(hc.y, 1.62, "§9.0 站立头球心 y=1.62", 0.03);
  const hBox = nodeWorldBox(helmet);
  ok(hBox.min.y < hc.y + 0.03, `头盔包覆头球心（盔沿 ${hBox.min.y.toFixed(2)} ≤ 头心+3cm）`);
  ok(hBox.max.y > 1.7 && hBox.max.y < 1.82, `头盔顶 ~1.75（实测 ${hBox.max.y.toFixed(2)}，§8.3 身高 ~1.8m）`);
  close(meshWorldCenter(vest).y, 1.15, "§9.0 躯干中心 y=1.15（背心几何中心）", 0.03);
  const hipsBox = nodeWorldBox(findNode(av.root, "thighL").parent); // pelvis 子树（腿+躯干）
  // hips 部件 = 骨盆腰带块（pelvis 直挂 mesh：腰胯 chamferBox 0.3×0.16×0.21）
  const pelvisChildren = [];
  av.root.traverse((o) => {
    if (o.name === "mp_avatar") return;
  });
  // 直接量 pelvis 组的躯干/腰胯：用 torso 首子件（腰胯盒）中心
  const torsoPivot = findNode(av.root, "shoulderL").parent;
  const hipMesh = torsoPivot.children[0]; // 第一个 part = 腰胯
  close(meshWorldCenter(hipMesh).y, 0.86, "§9.0 hips 中心 y=0.86（腰胯块）", 0.03);
  // 腿：触地 + 中心 + 间距
  const legLBox = nodeWorldBox(findNode(av.root, "thighL"));
  const legRBox = nodeWorldBox(findNode(av.root, "thighR"));
  ok(Math.abs(legLBox.min.y) <= 0.03, `左腿触地（min.y=${legLBox.min.y.toFixed(3)}）`);
  ok(Math.abs(legRBox.min.y) <= 0.03, `右腿触地（min.y=${legRBox.min.y.toFixed(3)}）`);
  const legsCenterY = (legLBox.min.y + Math.max(legLBox.max.y, legRBox.max.y)) / 2;
  close(legsCenterY, 0.42, "§9.0 腿中心 y=0.42（0..0.86 触地带）", 0.035);
  close((legLBox.min.x + legLBox.max.x) / 2, -0.1, "左腿 x=-0.10", 0.03);
  close((legRBox.min.x + legRBox.max.x) / 2, 0.1, "右腿 x=+0.10", 0.03);
  // 臂（视觉上段对位 ±0.27 柱带上沿）
  const armRBox = nodeWorldBox(findNode(av.root, "shoulderR"));
  ok(armRBox.max.y > 1.4 && armRBox.max.y < 1.5, `右臂上沿 ~1.45（实测 ${armRBox.max.y.toFixed(2)}，臂柱 0.91..1.45）`);
}

// ———— 5. §9.0 蹲伏表对齐 ————
const CROUCH = { ...IDLE, crouch: true };
settle(av, CROUCH, 120);
{
  const head = findNode(av.root, "head");
  const vest = findNode(av.root, "vest");
  close(meshWorldCenter(head).y, 1.38, "§9.0 蹲伏头球心 y=1.38", 0.03);
  close(meshWorldCenter(vest).y, 1.0, "§9.0 蹲伏躯干中心 y=1.00", 0.03);
  const torsoPivot = findNode(av.root, "shoulderL").parent;
  close(meshWorldCenter(torsoPivot.children[0]).y, 0.74, "§9.0 蹲伏 hips y=0.74", 0.03);
  const legLBox = nodeWorldBox(findNode(av.root, "thighL"));
  const legRBox = nodeWorldBox(findNode(av.root, "thighR"));
  ok(Math.abs(legLBox.min.y) <= 0.03 && Math.abs(legRBox.min.y) <= 0.03, `蹲伏脚仍触地（${legLBox.min.y.toFixed(3)}/${legRBox.min.y.toFixed(3)}）`);
  const crLegsCenter = (Math.min(legLBox.min.y, legRBox.min.y) + Math.max(legLBox.max.y, legRBox.max.y)) / 2;
  ok(Math.abs(crLegsCenter - 0.32) <= 0.06, `蹲伏腿中心 ~0.32（实测 ${crLegsCenter.toFixed(2)}；模型大腿根连髋 0.74，表腿柱 0..0.64）`);
}

// ———— 6. 腕锚对位（Vv graft 与 FK/IK 的接触质量：小臂端点 vs 腕锚世界位）————
{
  for (const [name, st] of [
    ["idle", IDLE],
    ["ads", { ...IDLE, ads: true }],
    ["sprint", { ...IDLE, sprint: true, speed: 6.5 }],
    ["pitch+1.0", { ...IDLE, pitch: 1.0 }],
    ["pitch-1.0", { ...IDLE, pitch: -1.0 }],
  ]) {
    settle(av, st, 90);
    av.root.updateMatrixWorld(true);
    const grpR = gloveMeshes.map((m) => m.parent).find((p) => p.position.distanceTo(wrExp) < 0.2);
    const grpL = gloveMeshes.map((m) => m.parent).find((p) => p.position.distanceTo(wlExp) < 0.3);
    const frEnd = findNode(av.root, "elbowR").children.find((c) => c.type === "Group");
    const flEnd = findNode(av.root, "elbowL").children.find((c) => c.type === "Group");
    const rEnd = frEnd.localToWorld(new T.Vector3(0, -0.26, 0));
    const lEnd = flEnd.localToWorld(new T.Vector3(0, -0.26, 0));
    const gRw = grpR.getWorldPosition(new T.Vector3());
    const gLw = grpL.getWorldPosition(new T.Vector3());
    ok(
      rEnd.distanceTo(gRw) <= 0.03,
      `${name} 右小臂端点贴腕锚（Δ=${rEnd.distanceTo(gRw).toFixed(3)}m，瞄准+轴向伸缩）`,
    );
    ok(
      lEnd.distanceTo(gLw) <= 0.03,
      `${name} 左小臂端点贴腕锚（Δ=${lEnd.distanceTo(gLw).toFixed(3)}m，IK 对位）`,
    );
  }
}

// ———— 7. 枪挂点不动（GUN_OFF + 抵偿公式语义）————
{
  settle(av, IDLE, 90);
  const baseY = gun.position.y;
  ok(
    Math.abs(gun.position.x - -0.02) < 1e-6 && Math.abs(gun.position.z - -0.01) < 1e-6,
    "枪枢轴 (GUN_X, GUN_Z) 不动",
  );
  settle(av, { ...IDLE, ads: true }, 90);
  ok(
    Math.abs(gun.position.y - (baseY + 0.1)) < 0.01,
    "ADS 枪位 +0.1 上抬（v1 公式保留）",
  );
  ok(gun.parent.name === "elbowR", "枪仍挂右肘（挂点父级不变）");
}

// ———— 8. 动画通道冒烟 ————
{
  // idle 呼吸：躯干 y 微摆
  settle(av, IDLE, 30);
  const y1 = findNode(av.root, "shoulderL").parent.position.y;
  settle(av, IDLE, 45);
  const y2 = findNode(av.root, "shoulderL").parent.position.y;
  ok(Math.abs(y2 - y1) > 1e-5, "idle 呼吸通道活（躯干 y 微摆）");

  // walk：腿摆正弦（相位推进，两腿反相）
  const WALK = { ...IDLE, speed: 2.2 };
  settle(av, WALK, 40);
  const tL1 = findNode(av.root, "thighL").rotation.x;
  const tR1 = findNode(av.root, "thighR").rotation.x;
  settle(av, WALK, 30);
  const tL2 = findNode(av.root, "thighL").rotation.x;
  const tR2 = findNode(av.root, "thighR").rotation.x;
  ok(Math.abs(tL2 - tL1) > 0.01, "walk 腿摆推进（左腿相位）");
  ok(Math.abs(tL1 - tR1) > 0.02 || Math.abs(tL2 - tR2) > 0.02, "walk 双腿反相");

  // sprint：大步幅 + 躯干保持 ≥16° 前倾（v1 公式：0.14 冲刺附加项 + hunch 衰减并存）
  settle(av, { ...IDLE, speed: 2.2 }, 60);
  let walkMin = 9,
    walkMax = -9;
  for (let i = 0; i < 120; i++) {
    av.applyPose({ ...IDLE, speed: 2.2 }, DT);
    const r = findNode(av.root, "thighL").rotation.x;
    walkMin = Math.min(walkMin, r);
    walkMax = Math.max(walkMax, r);
  }
  const walkRange = walkMax - walkMin;
  settle(av, { ...IDLE, sprint: true, speed: 6.5 }, 60);
  let sprMin = 9,
    sprMax = -9;
  for (let i = 0; i < 120; i++) {
    av.applyPose({ ...IDLE, sprint: true, speed: 6.5 }, DT);
    const r = findNode(av.root, "thighL").rotation.x;
    sprMin = Math.min(sprMin, r);
    sprMax = Math.max(sprMax, r);
  }
  const sprRange = sprMax - sprMin;
  ok(sprRange > walkRange * 1.25, `sprint 大步幅（${sprRange.toFixed(2)} > 走 ${walkRange.toFixed(2)}×1.25）`);
  const leanSprint = findNode(av.root, "shoulderL").parent.rotation.x;
  ok(leanSprint <= -0.28, `sprint 躯干前倾 ≥16°（实测 ${(-leanSprint * 57.3).toFixed(0)}°）`);

  // fire 后坐：枪后移+上挑（net 枪口上挑 = kick·0.22 − 臂链踢回 0.21，视觉以后移为主）
  settle(av, IDLE, 60);
  const gz1 = gun.position.z;
  const gx1 = gun.rotation.x;
  av.applyPose({ ...IDLE, fireT: 0.16 }, DT);
  ok(gun.position.z > gz1 + 0.03, `fire 后坐枪后移（+${(gun.position.z - gz1).toFixed(3)}m）`);
  ok(gun.rotation.x - gx1 > 0.005, `fire 净枪口上挑为正（+${(gun.rotation.x - gx1).toFixed(3)}rad）`);

  // death：后倒 ~86° 定格 + 复活自愈
  settle(av, { ...IDLE, alive: false }, 45);
  const tiltNode = av.root.children[0];
  close(tiltNode.rotation.x, 1.5, "death 倒伏角 ~86°(1.5rad)", 0.02);
  close(tiltNode.rotation.z, 0.38, "death 侧倒分量 0.38rad", 0.02);
  ok(tiltNode.position.y > 0.03, "death 垫高防半埋地");
  settle(av, IDLE, 10);
  ok(
    Math.abs(tiltNode.rotation.x) < 1e-6 && tiltNode.position.y === 0,
    "复活自愈（倒伏残留清零）",
  );

  // land：垂直骤停 → 下沉回弹
  settle(av, { ...IDLE, vy: -4.5 }, 30);
  const pelvisNode = findNode(av.root, "thighL").parent;
  const py1 = pelvisNode.position.y;
  av.applyPose({ ...IDLE, vy: 0 }, DT);
  av.applyPose({ ...IDLE, vy: 0 }, DT * 0.5);
  const py2 = pelvisNode.position.y;
  ok(py2 < py1 - 0.005, `land 下沉回弹（${py1.toFixed(3)}→${py2.toFixed(3)}）`);
}

// ———— 9. 四色位换色 + 受击红闪 ————
{
  const helmet = findNode(av.root, "helmet");
  const vest = findNode(av.root, "vest");
  ok(helmet.material === vest.material, "头盔+背心共享位色材质（一键四色染）");
  const before = helmet.material.color.getHex();
  av.setColor(0xff8a3c);
  ok(helmet.material.color.getHex() === 0xff8a3c, "setColor 即时换色（橙位）");
  av.setColor(before);
  av.setHitFlash(1);
  ok(helmet.material.emissive.r > 0.4, "setHitFlash 红闪（emissive 偏红）");
  av.setHitFlash(0);
  ok(helmet.material.emissive.r < 0.3, "红闪退去（emissive 回落）");
}

// ———— 10. muzzleWorld ————
{
  settle(av, IDLE, 60);
  const m = av.muzzleWorld(new T.Vector3());
  ok(!!m, "muzzleWorld 返回枪口世界位");
  ok(m.z < -0.3, `枪口在身前（z=${m.z.toFixed(2)}）`);
  ok(m.y > 1.1 && m.y < 1.6, `枪口高度合理（y=${m.y.toFixed(2)}）`);
  settle(av, { ...IDLE, ads: true }, 60);
  const m2 = av.muzzleWorld(new T.Vector3());
  ok(m2.y > m.y, "ADS 举枪枪口抬高");
}

// ———— 11. 双化身共享缓存引用计数 ————
{
  const av2 = createAvatar(T, { color: 0xb45cff, castShadow: false });
  ok(!!av2 && !!av2.root, "第二化身创建成功（共享枪/手缓存）");
  av2.applyPose(IDLE, DT);
  const m2 = av2.muzzleWorld(new T.Vector3());
  ok(!!m2, "第二化身 muzzleWorld 正常");
  av2.dispose();
  const m1 = av.muzzleWorld(new T.Vector3());
  ok(!!m1, "第二化身 dispose 后第一化身枪/手资源仍活（引用计数）");
  const av3 = createAvatar(T, { color: 0xffd84d });
  av3.applyPose(IDLE, DT);
  ok(!!av3.muzzleWorld(new T.Vector3()), "缓存全释放后可重建（第三化身）");
  av3.dispose();
}

// ———— 12. setVisible / dispose 收尾 ————
{
  av.setVisible(false);
  ok(av.root.visible === false, "setVisible(false)");
  av.setVisible(true);
  av.dispose();
  let threw = false;
  try {
    av.applyPose(IDLE, DT);
  } catch {
    threw = true;
  }
  ok(!threw, "dispose 后 applyPose 静默空转");
  ok(av.root.children.length === 0, "dispose 清空场景树");
}

console.log(
  failed.length === 0
    ? `PASS avatar-v2: ${passed.length} 断言全绿（面数：身体/手/枪分列见上）`
    : `FAIL avatar-v2: ${failed.length}/${passed.length + failed.length} 断言失败`,
);
console.log(`  面数账本：身体 ${bodyTris} · 双手 ${Math.round(handTris)} · 枪 ${gunOnlyTris} · 总计 ${bodyTris + Math.round(handTris) + gunOnlyTris}`);
process.exit(failed.length === 0 ? 0 : 1);
