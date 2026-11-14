// PvP 分部位命中判定体（MP-PVP §9.0/§9.1）——纯解析几何，双端同参：
// host 权威结算（host-sim.js pvpShot）与 client 视觉命中（combat.js pvpVisualHit）
// 都吃这两张表，杜绝两端口径漂移。无 THREE 依赖，可 node 无头直测。
//
// 局部系（x 右 / y 上 / z 前，§9.0）→ 世界系，yaw 语义以现有代码实测为准：
//   player.js C.forward.set(0,0,-1).applyEuler(YXZ)（forward=(0,0,-1) 绕 Y 旋 yaw，
//   host-sim forwardOf 同式；avatar.js 化身前方=-Z 同一约定），故
//   局部 z 前 → 世界 (-sin yaw, 0, -cos yaw)；局部 x 右 → 世界 (cos yaw, 0, -sin yaw)：
//     world.x = pos.x + x·cos(yaw) − z·sin(yaw)
//     world.y = pos.y + y
//     world.z = pos.z − x·sin(yaw) − z·cos(yaw)
//
// 倍率（PAC-9 28 伤/发换算，§9.0）：头 ×2.2=61.6（两枪倒）/躯干 ×1.0=28（四枪）/
// 四肢 ×0.7=19.6（六枪）。射线取最近命中部位；同距重叠 mult 高者优先。

// —— §9.0 站立表（逐字；leg 半高 0.42 配中心 0.42 → 触地 y=0）——
var STAND = [
  { part: "head", shape: "sphere", x: 0, y: 1.62, z: 0, r: 0.13, half: 0, mult: 2.2 },
  { part: "torso", shape: "cylinder", x: 0, y: 1.15, z: 0, r: 0.2, half: 0.33, mult: 1 },
  { part: "hips", shape: "cylinder", x: 0, y: 0.86, z: 0, r: 0.18, half: 0.1, mult: 1 },
  { part: "leg_L", shape: "cylinder", x: -0.1, y: 0.42, z: 0, r: 0.09, half: 0.42, mult: 0.7 },
  { part: "leg_R", shape: "cylinder", x: 0.1, y: 0.42, z: 0, r: 0.09, half: 0.42, mult: 0.7 },
  { part: "arm_L", shape: "cylinder", x: -0.27, y: 1.18, z: 0.04, r: 0.07, half: 0.27, mult: 0.7 },
  { part: "arm_R", shape: "cylinder", x: 0.27, y: 1.18, z: 0.04, r: 0.07, half: 0.27, mult: 0.7 },
];

// —— §9.0 蹲伏表（逐字；未注明的半径/半高沿用站立值。腿 0.32±0.32 → 仍触地 y=0）——
var CROUCH = [
  { part: "head", shape: "sphere", x: 0, y: 1.38, z: 0, r: 0.13, half: 0, mult: 2.2 },
  { part: "torso", shape: "cylinder", x: 0, y: 1.0, z: 0, r: 0.2, half: 0.28, mult: 1 },
  { part: "hips", shape: "cylinder", x: 0, y: 0.74, z: 0, r: 0.18, half: 0.1, mult: 1 },
  { part: "leg_L", shape: "cylinder", x: -0.11, y: 0.32, z: 0, r: 0.1, half: 0.32, mult: 0.7 },
  { part: "leg_R", shape: "cylinder", x: 0.11, y: 0.32, z: 0, r: 0.1, half: 0.32, mult: 0.7 },
  { part: "arm_L", shape: "cylinder", x: -0.25, y: 1.05, z: 0.1, r: 0.07, half: 0.27, mult: 0.7 },
  { part: "arm_R", shape: "cylinder", x: 0.25, y: 1.05, z: 0.1, r: 0.07, half: 0.27, mult: 0.7 },
];

var TIE = 1e-4; // 同距重叠容差（m）：入射距离差 < 0.1mm 视为同距，mult 高者优先
var DISC_EPS = 1e-7; // 判别式/半径容差：头顶 1.75、脚 y=0 等擦边几何不被浮点噪声吞掉

function toXYZ(v) {
  // 容错接收 Vector3 / [x,y,z] / {x,y,z}（host-sim 传 Vector3，测试传数组）
  if (!v) return null;
  if (Array.isArray(v)) {
    if (v.length >= 3) {
      var a = +v[0],
        b = +v[1],
        c = +v[2];
      if (isFinite(a) && isFinite(b) && isFinite(c)) return [a, b, c];
    }
    return null;
  }
  var x = +v.x,
    y = +v.y,
    z = +v.z;
  return isFinite(x) && isFinite(y) && isFinite(z) ? [x, y, z] : null;
}

// state = {pos, yaw, crouch}（pos 容错 Vector3/数组/对象；crouch 亦认 state.flags.crouch）
// → [{part, shape, center:[x,y,z], r, half, mult}]（center 已含 pos 平移与 yaw 旋转）
function playerHitboxes(state) {
  var p = toXYZ(state && state.pos);
  if (!p) return [];
  var yaw = +(state && state.yaw) || 0;
  var crouch = !!(state && (state.crouch || (state.flags && state.flags.crouch)));
  var tbl = crouch ? CROUCH : STAND;
  var cs = Math.cos(yaw),
    sn = Math.sin(yaw);
  var out = [];
  for (var i = 0; i < tbl.length; i++) {
    var b = tbl[i];
    out.push({
      part: b.part,
      shape: b.shape,
      center: [
        p[0] + b.x * cs - b.z * sn,
        p[1] + b.y,
        p[2] - b.x * sn - b.z * cs,
      ],
      r: b.r,
      half: b.half,
      mult: b.mult,
    });
  }
  return out;
}

// 射线-球解析求交（dir 已归一）：返回入射距离 t，未命中 -1。
// disc 轻微为负按切线处理（头顶擦边）；起点在球内取远根（贴脸枪口不空枪）。
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  var mx = ox - cx,
    my = oy - cy,
    mz = oz - cz;
  var b = mx * dx + my * dy + mz * dz;
  var c = mx * mx + my * my + mz * mz - r * r;
  var disc = b * b - c;
  var sq = 0;
  if (disc < 0) {
    if (disc < -DISC_EPS) return -1;
  } else sq = Math.sqrt(disc);
  var t = -b - sq;
  if (t <= 0) t = -b + sq;
  return t > 0 ? t : -1;
}

// 射线-直立圆柱（Y 轴对齐；yaw 旋转不改变轴走向）：侧面二次求交 + y 板校验，
// 顶/底端盖平面圆盘求交，取最近 t，未命中 -1。垂直射线（侧面退化）由端盖覆盖。
function rayCylinderY(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, half) {
  var best = Infinity;
  var mx = ox - cx,
    mz = oz - cz;
  var a = dx * dx + dz * dz;
  if (a > 1e-12) {
    var b = mx * dx + mz * dz;
    var c = mx * mx + mz * mz - r * r;
    var disc = b * b - a * c;
    if (disc >= -DISC_EPS) {
      var sq = disc > 0 ? Math.sqrt(disc) : 0;
      var t0 = (-b - sq) / a,
        t1 = (-b + sq) / a;
      if (t0 > 0 && Math.abs(oy + t0 * dy - cy) <= half) {
        if (t0 < best) best = t0;
      } else if (t1 > 0 && Math.abs(oy + t1 * dy - cy) <= half && t1 < best)
        best = t1;
    }
  }
  if (dy > 1e-12 || dy < -1e-12) {
    for (var k = 0; k < 2; k++) {
      var capY = cy + (k ? half : -half);
      var t = (capY - oy) / dy;
      if (t > 0 && t < best) {
        var px = ox + t * dx - cx,
          pz = oz + t * dz - cz;
        if (px * px + pz * pz <= r * r + DISC_EPS) best = t;
      }
    }
  }
  return best === Infinity ? -1 : best;
}

// 射线 × 玩家分部位判定：最近命中部位；同距（±TIE）重叠 mult 高者优先。
// origin/dir 容错 Vector3 / [x,y,z] / {x,y,z}（dir 内部归一）。
// 返回 {part, dist, mult} | null。射程/墙体比较由调用方做（dist < 墙距即先中人体）。
function raycastPlayerParts(origin, dir, state) {
  var o = toXYZ(origin),
    d = toXYZ(dir);
  if (!o || !d) return null;
  var len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-9)) return null;
  var dx = d[0] / len,
    dy = d[1] / len,
    dz = d[2] / len;
  var boxes = playerHitboxes(state);
  var best = null;
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i],
      c = b.center;
    var t =
      b.shape === "sphere"
        ? raySphere(o[0], o[1], o[2], dx, dy, dz, c[0], c[1], c[2], b.r)
        : rayCylinderY(
            o[0],
            o[1],
            o[2],
            dx,
            dy,
            dz,
            c[0],
            c[1],
            c[2],
            b.r,
            b.half,
          );
    if (t <= 0) continue;
    if (!best) best = { part: b.part, dist: t, mult: b.mult };
    else if (t < best.dist - TIE) best = { part: b.part, dist: t, mult: b.mult };
    else if (t < best.dist + TIE && b.mult > best.mult)
      best = {
        part: b.part,
        dist: t < best.dist ? t : best.dist,
        mult: b.mult,
      };
  }
  return best;
}

export { playerHitboxes, raycastPlayerParts };
