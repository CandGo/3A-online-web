// src/net/avatar.js — procedural human tactical operator.
// Soft anatomical cloth volumes, an exposed human face, fitted helmet and
// compact sewn equipment. Body budget <= 15k triangles; no external textures.
// Public API / skeleton / PAC-9 / Vv glove graft / pose channels are preserved.
// THREE is supplied by the caller; shared gun/hand resources remain ref-counted.

import { buildGunWorldModel } from "../weapons/weapon.js";
import { Vv, Bf, Wv } from "../weapons/rig.js";
import { patchMaterialShader } from "../render/materials/materials.js";
import { Euler, Quaternion, Vector3 } from "../vendor/three-r180.js";

var TAU = Math.PI * 2;

// First-person glove surface technique, available without a renderer argument:
// bake a repeatable weave into colour/tint, normal and packed AO/roughness/metal
// maps, then use the SAME triplanar/wetness shader as context.mats.get().
// The CPU bake is deliberately independent of DOM/WebGL so headless consumers
// and the synchronous createAvatar API retain their original behaviour.
var avatarSurfaceCache = new WeakMap();
function acquireAvatarSurfaces(T) {
  var cached = avatarSurfaceCache.get(T);
  if (!cached) {
    var size = 256;
    function hash(x, y) {
      var n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    }
    function noise(u, v, period, seed) {
      var x = u * period,
        y = v * period;
      var ix = Math.floor(x),
        iy = Math.floor(y);
      var fx = x - ix,
        fy = y - iy;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      function h(dx, dy) {
        return hash(
          ((((ix + dx) % period) + period) % period) + seed * 97,
          ((((iy + dy) % period) + period) % period) + seed * 37,
        );
      }
      return (
        (h(0, 0) * (1 - fx) + h(1, 0) * fx) * (1 - fy) +
        (h(0, 1) * (1 - fx) + h(1, 1) * fx) * fy
      );
    }
    function texture(bytes, name, srgb) {
      var t = new T.DataTexture(bytes, size, size, T.RGBAFormat);
      t.name = name;
      t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.magFilter = T.LinearFilter;
      t.minFilter = T.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    }
    function bake(rubber) {
      var height = new Float32Array(size * size);
      var albedo = new Uint8Array(size * size * 4);
      var orm = new Uint8Array(size * size * 4);
      var normals = new Uint8Array(size * size * 4);
      for (var y = 0; y < size; y++)
        for (var x = 0; x < size; x++) {
          var u = (x + 0.5) / size,
            v = (y + 0.5) / size;
          var px = u * 36,
            py = v * 36;
          var ix = Math.floor(px),
            iy = Math.floor(py);
          var pw = Math.sin((px - ix) * Math.PI);
          var pf = Math.sin((py - iy) * Math.PI);
          // Same alternating warp/weft profile as Tn.fabric in surface-shaders.
          var top = (ix + iy) % 2;
          var h = top ? pw * (0.6 + 0.4 * pf) : pf * (0.6 + 0.4 * pw) * 0.85;
          var fuzz = noise(u, v, 128, 1);
          var broad = noise(u, v, 4, 2);
          var thread = hash(top ? ix : iy, top + 3);
          var tint =
            0.9 *
            (0.55 + 0.45 * h) *
            (0.85 +
              0.2 * (thread - 0.5) +
              0.2 * (fuzz - 0.5) +
              0.2 * (broad - 0.5));
          var ao = 0.5 + 0.5 * h,
            rough = 0.92;
          var i = y * size + x,
            q = i * 4;
          if (rubber) {
            h = noise(u, v, 96, 7) * 0.55 + noise(u, v, 48, 9) * 0.45;
            tint = 0.86 + (broad - 0.5) * 0.1 + (h - 0.5) * 0.06;
            ao = 0.91 + h * 0.09;
            rough = 0.75 + h * 0.16;
            height[i] = h * 0.16;
          } else height[i] = 0.2 + h * 0.7 + (fuzz - 0.5) * 0.15;
          // SL_TINT=1: RGB is an additive stain, alpha modulates base colour.
          albedo[q + 3] = Math.round(Math.min(1, tint) * 255);
          orm[q] = Math.round(ao * 255);
          orm[q + 1] = Math.round(rough * 255);
          orm[q + 2] = 0;
          orm[q + 3] = 255;
        }
      function at(x, y) {
        return height[((y + size) % size) * size + ((x + size) % size)];
      }
      // The original texture baker's eight-tap height-to-normal derivative.
      var strength = (0.0004 * size) / 0.05;
      for (var y = 0; y < size; y++)
        for (var x = 0; x < size; x++) {
          var gx =
            (at(x + 1, y) - at(x - 1, y)) * 0.5 +
            (at(x + 1, y + 1) +
              at(x + 1, y - 1) -
              at(x - 1, y + 1) -
              at(x - 1, y - 1)) *
              0.25;
          var gy =
            (at(x, y + 1) - at(x, y - 1)) * 0.5 +
            (at(x + 1, y + 1) +
              at(x - 1, y + 1) -
              at(x + 1, y - 1) -
              at(x - 1, y - 1)) *
              0.25;
          var nx = -gx * strength,
            ny = -gy * strength;
          var len = Math.hypot(nx, ny, 1),
            q = (y * size + x) * 4;
          normals[q] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
          normals[q + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
          normals[q + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
          normals[q + 3] = 255;
        }
      var name = rubber ? "avatar_rubber" : "avatar_woven_fabric";
      return {
        map: texture(albedo, name + "_tint", true),
        normalMap: texture(normals, name + "_normal", false),
        orm: texture(orm, name + "_orm", false),
      };
    }
    cached = { fabric: bake(false), rubber: bake(true), refs: 0 };
    avatarSurfaceCache.set(T, cached);
  }
  cached.refs++;
  return {
    fabric: cached.fabric,
    rubber: cached.rubber,
    dispose: function () {
      if (--cached.refs !== 0) return;
      avatarSurfaceCache.delete(T);
      for (var maps of [cached.fabric, cached.rubber]) {
        maps.map.dispose();
        maps.normalMap.dispose();
        maps.orm.dispose();
      }
    },
  };
}
// —— §9.0 对齐骨架度量（站立）——
var HIP_Y = 0.86; // 髋枢轴离地（站立；0.40 大腿 + 0.34 小腿 + 0.12 靴 = 0.86）
var TORSO_LOCAL_Y = 0.08; // 躯干枢轴在骨盆系内偏移（世界 0.94；背心中心 1.15）
var THIGH_LEN = 0.4;
var SHIN_LEN = 0.34;
var BOOT_LEN = 0.12;
var LEG_X = 0.1; // 腿间距（§9.0 腿圆柱 x=±0.10）
var SH_X = 0.22; // 肩枢轴（§9.0 臂圆柱 x=±0.27 由肩甲+垂臂覆盖上段）
var SH_Y = 0.44; // 肩枢轴 torso 局部高（世界 ~1.38）
var SH_Z = 0.02;
var UPPER_LEN = 0.3; // 上臂（肩→肘）
var FOREARM_LEN = 0.26; // 小臂 Mesh 长（肘→腕视觉段；腕锚由袖管覆盖）
var CROUCH_DROP = 0.13; // 蹲伏髋沉降（§9.0 hips 0.86→0.74）
var CROUCH_BOW = 0.18; // Natural chest bend; head height is solved against the hitbox.
var DEATH_DUR = 0.45; // 倒伏时长（s），完成后定格
var RECOIL_DUR = 0.16; // 后坐肩缩时长（s），fireT 与之对齐
var LAND_DUR = 0.2; // 着地下沉回弹时长（s）
var LAND_VY_HIT = -3.2; // 触发着地缓冲的垂直速度阈值（m/s）
var RED_FLASH_HEX = 0xff2020; // 受击红闪（与 P0 化身一致）
var GUN_X = -0.02; // 枪枢轴在右小臂系内（=握把位；v1 逐字保留，挂点不动）
var GUN_Y = -0.29;
var GUN_Z = -0.01;

// —— 持枪位形常数（_scratch/scan_arms.mjs 数值定标 v3：右臂 FK 驱动枪，
//    目标=抵肩持枪（握把 z≈-0.23）+ 高位持枪线 ~1.38 / ADS ~1.45）——
var CARRY_HUNCH = 0.14; // Relaxed human carry; sprint retains its separate forward lean.
var CARRY_R_SHOULDER = -0.08; // Slightly lowered carry; keep the optic below the cheek.
var CARRY_R_ELBOW = 2.57; // 右肘深折（小臂折上端枪 → 枪抵肩）
var CARRY_R_SIDE = -0.15; // 右臂内扣（枪身向中线收）
var ADS_R_SHOULDER = 1.27; // ADS 右臂（贴腮：肩抬肘折，枪线 ~1.45）
var ADS_R_ELBOW = 2.73;
var ADS_R_SIDE = -0.19;

// —— Vv 手套 graft 参数（weapon.js 视图模型 1:1 换算到枪枢轴系）——
// 右手：手局部 (0.006,-0.031,-0.085)（掌心抓握点）落在枪局部 grip [0,-0.1,0.073]
// 左手：手局部 (0,-0.015,-0.055) 落在枪局部 [-0.015,-0.062,-0.236]（护木抓握）
// 袖管方向 = idle 位形下 腕→肘（定标值），长度按腕-肘距 -0.05 重叠
var HAND_GRIP_LOCAL = [0.006, -0.031, -0.085];
var HAND_GUARD_GRASP = [-0.015, -0.062, -0.236];
var HAND_GUARD_LOCAL = [0, -0.015, -0.055];
var SLEEVE_R_DIR = [0.9541, -0.0425, 0.2966];
var SLEEVE_R_LEN = 0.2;
var SLEEVE_L_DIR = [-0.13, 0.6875, 0.7144];
var SLEEVE_L_LEN = 0.2;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutCubic(u) {
  return 1 - Math.pow(1 - u, 3);
}

// ————————————————————————————————————————————
// Vv 手套模块级缓存（全体化身共享；引用计数归零才释放——照 worldGunCache 模式）
// ————————————————————————————————————————————
var worldHandCache = null;

function buildWorldHands() {
  if (!worldHandCache) {
    var fabricR = null;
    var fabricL = null;
    try {
      // 手局部系方向换算（weapon.js y() 同式：世界方向 → hand-local 四元数逆变换）
      var vTmp = new Vector3();
      function y(M, w, flip) {
        vTmp
          .set(w[0], w[1], w[2])
          .normalize()
          .applyQuaternion(M.clone().invert());
        if (flip) vTmp.x *= -1;
        return [vTmp.x, vTmp.y, vTmp.z];
      }
      // 右手（握把）：index 指扣扳机位形（视图模型 indexPoses 两档取中）
      var qR = new Quaternion()
        .setFromEuler(new Euler(-0.24, 0, 0))
        .multiply(new Quaternion().setFromEuler(new Euler(0, 0, -Math.PI / 2)));
      var qL = new Quaternion()
        .setFromEuler(new Euler(0, 0, Math.PI / 2))
        .multiply(new Quaternion().setFromEuler(new Euler(0.06, 0, 0)));
      fabricR = Vv({
        mirror: false,
        fingers: [
          [0.42, 1.05, 0.5, 0],
          [0.62, 1.72, 0.8, 0],
          [0.68, 1.7, 0.8, -0.03],
          [0.74, 1.66, 0.8, -0.09],
        ],
        thumb: [
          y(qR, [-0.85, 0.05, -0.5]),
          y(qR, [-0.6, -0.05, -0.8]),
          y(qR, [-0.05, -0.2, -0.97]),
        ],
        forearm: SLEEVE_R_DIR,
        sleeve: SLEEVE_R_LEN,
      });
      fabricL = Vv({
        mirror: true,
        fingers: [
          [1.27, 1.42, 0.75, 0.02],
          [1.3, 1.45, 0.75, 0],
          [1.3, 1.45, 0.75, -0.02],
          [1.33, 1.45, 0.75, -0.05],
        ],
        thumb: [
          y(qL, [0, 0.25, -0.97], true),
          y(qL, [0.05, 0.1, -0.99], true),
          y(qL, [0, 0, -1], true),
        ],
        forearm: SLEEVE_L_DIR,
        sleeve: SLEEVE_L_LEN,
      });
    } catch (e) {
      fabricR = null;
      fabricL = null;
    }
    if (!fabricR || !fabricL) return null;
    worldHandCache = {
      fabricR: fabricR.fabric, // Vv 返回 {fabric, rubber, index, knuckle}，取合并布面几何
      fabricL: fabricL.fabric,
      refs: 0,
    };
  }
  var cache = worldHandCache;
  cache.refs++;
  return {
    fabricR: cache.fabricR,
    fabricL: cache.fabricL,
    dispose: function () {
      cache.refs--;
      if (cache.refs > 0 || worldHandCache !== cache) return;
      worldHandCache = null;
      try {
        cache.fabricR.dispose();
      } catch {}
      try {
        cache.fabricL.dispose();
      } catch {}
    },
  };
}

export function createAvatar(THREE, mats, opts) {
  if (!THREE || !THREE.Group || !THREE.MeshStandardMaterial) return null;
  // 兼容 (THREE, opts) 两参形态：mats 袋缺席（无 fatigues 键）时第二参即 opts
  if (mats && !opts && !mats.fatigues) {
    opts = mats;
    mats = null;
  }
  opts = opts || {};
  var castShadow = opts.castShadow !== false;
  var colorHex = typeof opts.color === "number" ? opts.color : 0x2ee6d6;

  var disposed = false;
  var geos = []; // 本化身自建几何体（dispose 统一释放）
  var ownedMats = []; // 本化身自建材质（共享 mats 袋归调用方管理，绝不在此释放）

  function own(m) {
    ownedMats.push(m);
    return m;
  }

  // ———————————— 几何助手（原语+形变；照 props 道具做法，本文件自包含）————
  var _v3a = new THREE.Vector3();
  var _v3b = new THREE.Vector3();
  var _qa = new THREE.Quaternion();
  var _UP = new THREE.Vector3(0, 1, 0);

  // Actual bevels: four octagonal rings, rather than moving a box's eight
  // corners inward. Small equipment catches a narrow, continuous edge light.
  function chamferBox(w, h, d, r) {
    if (!r) return box(w, h, d);
    r = Math.min(r, w * 0.22, h * 0.22, d * 0.22);
    var vertices = [],
      indices = [];
    var levels = [-h / 2, -h / 2 + r, h / 2 - r, h / 2];
    for (var k = 0; k < 4; k++) {
      var inset = k === 0 || k === 3 ? r * 0.55 : 0;
      var x = w / 2 - inset,
        z = d / 2 - inset,
        c = r * 0.65;
      var outline = [
        [-x + c, z],
        [x - c, z],
        [x, z - c],
        [x, -z + c],
        [x - c, -z],
        [-x + c, -z],
        [-x, -z + c],
        [-x, z - c],
      ];
      for (var j = 0; j < 8; j++)
        vertices.push(outline[j][0], levels[k], outline[j][1]);
    }
    for (var k = 0; k < 3; k++)
      for (var j = 0; j < 8; j++) {
        var a = k * 8 + j,
          b = k * 8 + ((j + 1) % 8);
        indices.push(a, b, a + 8, b, b + 8, a + 8);
      }
    for (var j = 1; j < 7; j++) {
      indices.push(0, j + 1, j, 24, 24 + j, 24 + j + 1);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    geos.push(g);
    return g;
  }

  // Tailored cross sections: [height, half width, half depth, depth offset].
  // Elliptical sections describe anatomy under fabric. A few millimetres of
  // deterministic gathering gives cloth weight without an armour/exosuit look.
  function cloth(rings, segments, folds, square) {
    segments = segments || 14;
    var p = [],
      uv = [],
      colors = [],
      ix = [];
    for (var k = 0; k < rings.length; k++) {
      var r = rings[k];
      for (var j = 0; j < segments; j++) {
        var a = (j / segments) * TAU,
          sn = Math.sin(a),
          cs = Math.cos(a);
        var power = square || 1;
        var gather =
          (folds || 0) *
          Math.sin((Math.PI * k) / (rings.length - 1)) *
          (Math.sin(a * 5 + k * 1.9) * 0.6 + Math.sin(a * 3 - k * 1.2) * 0.4);
        p.push(
          Math.sign(sn) * Math.pow(Math.abs(sn), power) * (r[1] + gather),
          r[0],
          Math.sign(cs) * Math.pow(Math.abs(cs), power) * (r[2] + gather) +
            (r[3] || 0),
        );
        uv.push(j / segments, k / (rings.length - 1));
        // Like the Vv sleeve: colour belongs to the actual fabric relief,
        // with restrained dark gathering and lighter raised fold shoulders.
        var foldShade = folds ? gather / folds : 0;
        var shade = 0.94 + foldShade * 0.12;
        colors.push(shade, shade, shade);
        if (k < rings.length - 1) {
          var a0 = k * segments + j,
            b0 = k * segments + ((j + 1) % segments);
          ix.push(a0, b0, a0 + segments, b0, b0 + segments, a0 + segments);
        }
      }
    }
    for (var k = 0; k < 2; k++) {
      var ring = k ? rings.length - 1 : 0,
        offset = ring * segments,
        c = p.length / 3;
      p.push(0, rings[ring][0], rings[ring][3] || 0);
      uv.push(0.5, k);
      colors.push(0.8, 0.8, 0.8);
      for (var j = 0; j < segments; j++) {
        var a = offset + j,
          b = offset + ((j + 1) % segments);
        if (k) ix.push(c, a, b);
        else ix.push(c, b, a);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(ix);
    g.computeVertexNormals();
    geos.push(g);
    return g;
  }

  function ellipsoid(parent, mat, x, y, z, sx, sy, sz, ws, hs) {
    var mesh = part(parent, ball(1, ws || 12, hs || 8), mat, x, y, z);
    mesh.scale.set(sx, sy, sz);
    return mesh;
  }

  // Dark substrate under a recognisable slot colour. Vertex colour keeps the
  // original setColor(hex) contract; only helmet and carrier use this material.
  function slotSurface(g, brightness) {
    var p = g.attributes.position,
      colors = [];
    for (var i = 0; i < p.count; i++) {
      var grain = 0.96 + 0.04 * Math.sin(i * 2.399);
      colors.push(brightness * grain, brightness * grain, brightness * grain);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }

  function seam(parent, points, mat, radius) {
    for (var i = 1; i < points.length; i++) {
      var a = points[i - 1],
        b = points[i];
      part(
        parent,
        tube(a[0], a[1], a[2], b[0], b[1], b[2], radius || 0.0015, null, 4),
        mat,
      );
    }
  }

  function webbing(parent, x, y, z, w, rows) {
    for (var row = 0; row < rows; row++) {
      part(parent, box(w, 0.009, 0.003), matStrap, x, y - row * 0.025, z);
      for (var col = -1; col <= 1; col++)
        part(
          parent,
          box(0.002, 0.009, 0.004),
          matThread,
          x + col * w * 0.3,
          y - row * 0.025,
          z - 0.002,
        );
    }
  }

  function box(w, h, d) {
    var g = new THREE.BoxGeometry(w, h, d);
    geos.push(g);
    return g;
  }

  function cyl(r, h, seg) {
    var g = new THREE.CylinderGeometry(r, r, h, seg || 8);
    geos.push(g);
    return g;
  }

  // 两点间圆管（锥度可选； straps/线缆/鞋带/天线）
  function tube(ax, ay, az, bx, by, bz, r1, r2, seg) {
    var len = Math.sqrt(
      (bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az),
    );
    if (!(len > 1e-5)) len = 1e-5;
    var g = new THREE.CylinderGeometry(r1, r2 == null ? r1 : r2, len, seg || 6);
    _v3a.set(bx - ax, by - ay, bz - az).normalize();
    _qa.setFromUnitVectors(_UP, _v3a);
    g.applyQuaternion(_qa);
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    geos.push(g);
    return g;
  }

  // 弧形带（partial 圆柱楔体：绑带/护板/帽圈；闭合端盖防侧视穿帮）
  function arc(r, h, thetaStart, thetaLength, seg) {
    var g = new THREE.CylinderGeometry(
      r,
      r,
      h,
      seg || 10,
      1,
      false,
      thetaStart,
      thetaLength,
    );
    geos.push(g);
    return g;
  }

  function ball(r, ws, hs) {
    var g = new THREE.SphereGeometry(r, ws, hs);
    geos.push(g);
    return g;
  }

  // 头盔壳：球冠（θ 截断）
  function dome(r, ws, hs, thetaLength) {
    var g = new THREE.SphereGeometry(
      r,
      ws,
      hs,
      0,
      TAU,
      0,
      thetaLength || Math.PI * 0.62,
    );
    geos.push(g);
    return g;
  }

  function pivot(parent, x, y, z) {
    var g = new THREE.Group();
    g.position.set(x || 0, y || 0, z || 0);
    parent.add(g);
    return g;
  }

  function part(parent, g, mat, x, y, z, rx, ry, rz) {
    var m = new THREE.Mesh(g, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  // Shared mats belong to the caller. Owned fabric/rubber use the first-person
  // triplanar PBR surface patch below; only exposed metal keeps PAC-9 Bf wear.
  var matFatigue =
    (mats && mats.fatigues) ||
    own(
      new THREE.MeshStandardMaterial({
        color: 0x2a3138,
        roughness: 0.85,
        metalness: 0.22,
      }),
    );
  var matGear =
    (mats && mats.gear) ||
    own(
      new THREE.MeshStandardMaterial({
        color: 0x1a2126,
        roughness: 0.7,
        metalness: 0.35,
      }),
    );
  var matDark =
    (mats && mats.dark) ||
    own(
      new THREE.MeshStandardMaterial({
        color: 0x10151a,
        roughness: 0.55,
        metalness: 0.5,
      }),
    );
  var matAccent = own(
    new THREE.MeshStandardMaterial({
      color: colorHex,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.04,
    }),
  );
  var matStrap = own(
    new THREE.MeshStandardMaterial({
      color: 0x42483f,
      roughness: 0.92,
      metalness: 0.04,
    }),
  );
  var matBoot = own(
    new THREE.MeshStandardMaterial({
      color: 0x121419,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  var matMetal = own(
    new THREE.MeshStandardMaterial({
      color: 0x2b2f36,
      roughness: 0.45,
      metalness: 0.75,
    }),
  );
  var matLens = own(
    new THREE.MeshStandardMaterial({
      color: 0x0a0e14,
      roughness: 0.18,
      metalness: 0.55,
    }),
  );
  var matFace = own(
    new THREE.MeshStandardMaterial({
      color: 0x9b7156,
      roughness: 0.88,
      metalness: 0.05,
    }),
  );
  var matCloth = own(
    new THREE.MeshStandardMaterial({
      color: 0x526373,
      roughness: 0.98,
      metalness: 0,
      vertexColors: true,
    }),
  );
  var matReinforce = own(
    new THREE.MeshStandardMaterial({
      color: 0x303b40,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
    }),
  );
  var matThread = own(
    new THREE.MeshStandardMaterial({
      color: 0x697064,
      roughness: 0.98,
      metalness: 0,
    }),
  );
  var matSkinLight = own(
    new THREE.MeshStandardMaterial({
      color: 0xab8063,
      roughness: 0.87,
      metalness: 0,
    }),
  );
  var matSkinShadow = own(
    new THREE.MeshStandardMaterial({
      color: 0x634b3d,
      roughness: 1,
      metalness: 0,
    }),
  );
  var matEye = own(
    new THREE.MeshStandardMaterial({
      color: 0x312c25,
      roughness: 0.42,
      metalness: 0,
    }),
  );
  var matEyeWhite = own(
    new THREE.MeshStandardMaterial({
      color: 0xa8a18e,
      roughness: 0.55,
      metalness: 0,
    }),
  );
  var matGlove = own(
    new THREE.MeshStandardMaterial({
      color: 2303530, // Exactly catalog.js glove_fabric; Vv carries the panel colours.
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    }),
  );
  // Shared bag materials are never patched or disposed here.
  // 让共享的护具/聚合物材质也走港区同款雨痕、磨损和粗糙度微扰。
  // 只给每个材质挂一次，避免多个远端化身反复替换 shader 回调。
  try {
    if (!matGear.userData.avatarWearPatched) {
      Bf(matGear, 2);
      matGear.userData.avatarWearPatched = true;
    }
    if (!matDark.userData.avatarWearPatched) {
      Bf(matDark, 1);
      matDark.userData.avatarWearPatched = true;
    }
    if (!matMetal.userData.avatarWearPatched) {
      Bf(matMetal, 1);
      matMetal.userData.avatarWearPatched = true;
    }
  } catch {}
  var surfaces = acquireAvatarSurfaces(THREE);
  function fabricSurface(material, maps, scale, normalStrength, wet) {
    material.map = maps.map;
    material.normalMap = maps.normalMap;
    material.roughnessMap = material.metalnessMap = material.aoMap = maps.orm;
    material.normalScale.set(normalStrength, normalStrength);
    material.defines = {
      ...material.defines,
      SL_TINT: 1,
      SL_TRIPLANAR: "",
      SL_FX: "",
    };
    var uniforms = {
      uSlWet: Wv,
      uSlWetP: { value: new THREE.Vector4(...wet) },
      uSlMacro: { value: new THREE.Vector4(0.08, 0.04, 8, 0) },
      uSlUv: { value: new THREE.Vector3(1, 1, scale / 0.05) },
      uSlX: { value: new THREE.Vector2(1, 0) },
    };
    material.userData.sl = uniforms;
    material.onBeforeCompile = function (shader) {
      patchMaterialShader(shader, uniforms);
    };
    material.customProgramCacheKey = function () {
      return "avatar-sl2-woven-triplanar-v1";
    };
  }
  // Glove settings match weapon.js: scale=3, catalog glove_fabric tint/wetness.
  // Cloth weave is slightly coarser on the uniform and reinforced carrier.
  fabricSurface(matGlove, surfaces.fabric, 3, 1, [0.3, 0.7, 0.6, 0]);
  fabricSurface(matCloth, surfaces.fabric, 1.6, 0.7, [0.3, 0.7, 0.6, 0]);
  fabricSurface(matReinforce, surfaces.fabric, 1.2, 0.9, [0.3, 0.7, 0.6, 0]);
  fabricSurface(matStrap, surfaces.fabric, 2.8, 0.8, [0.3, 0.7, 0.6, 0]);
  fabricSurface(matAccent, surfaces.fabric, 1.2, 0.8, [0.3, 0.7, 0.6, 0]);
  fabricSurface(matBoot, surfaces.rubber, 0.8, 0.55, [0.08, 0.55, 0.6, 0.4]);
  var baseGlow = new THREE.Color(colorHex).multiplyScalar(0.035);
  var redFlash = new THREE.Color(RED_FLASH_HEX);
  var flashM = 0;
  matAccent.emissive.copy(baseGlow);

  // ———————————— 骨架拼装（前方 = -Z，与 root.rotation.y=yaw 的化身朝向一致）————
  // 层级：root(位置/yaw 由调用方写) → tilt(死亡倒伏) → pelvis(蹲伏/起伏/重心) → 腿+躯干
  var root = new THREE.Group();
  root.name = "mp_avatar";
  var tilt = pivot(root, 0, 0, 0);
  var pelvis = pivot(tilt, 0, HIP_Y, 0);

  // Human silhouette first: relaxed trouser volume, tapered calves, soft sleeve
  // caps and a small plate carrier. All original pivots and reach lengths stay.
  function buildLeg(sideX) {
    var thigh = pivot(pelvis, sideX * LEG_X, 0, 0);
    thigh.name = sideX < 0 ? "thighL" : "thighR";
    part(
      thigh,
      cloth(
        [
          [-0.4, 0.057, 0.061],
          [-0.377, 0.062, 0.067],
          [-0.35, 0.066, 0.073, -0.003],
          [-0.31, 0.065, 0.079],
          [-0.265, 0.074, 0.081, 0.005],
          [-0.22, 0.078, 0.083, 0.007],
          [-0.17, 0.082, 0.087, 0.005],
          [-0.11, 0.083, 0.088],
          [-0.05, 0.08, 0.085],
          [-0.045, 0.071, 0.068],
        ],
        16,
        0.005,
      ),
      matCloth,
    );
    // Articulated stretch panel; a fabric cargo pocket sits on the outer thigh.
    part(
      thigh,
      cloth(
        [
          [-0.38, 0.058, 0.063],
          [-0.35, 0.064, 0.07],
          [-0.325, 0.064, 0.071],
        ],
        12,
        0.001,
      ),
      matReinforce,
    );
    var cargo = pivot(thigh, sideX * 0.069, -0.205, 0.004);
    cargo.rotation.y = (sideX * Math.PI) / 2;
    part(
      cargo,
      chamferBox(0.096, 0.133, 0.023, 0.008),
      matReinforce,
      0,
      0,
      -0.006,
    );
    part(
      cargo,
      chamferBox(0.099, 0.036, 0.027, 0.006),
      matCloth,
      0,
      0.053,
      -0.012,
      0.13,
    );
    seam(
      cargo,
      [
        [-0.042, 0.038, -0.021],
        [-0.042, -0.057, -0.021],
        [0.042, -0.057, -0.021],
        [0.042, 0.038, -0.021],
      ],
      matThread,
      0.001,
    );
    part(cargo, box(0.012, 0.026, 0.004), matStrap, 0.025, 0.037, -0.028);
    part(cargo, box(0.025, 0.007, 0.003), matDark, -0.02, 0.051, -0.029);
    seam(
      thigh,
      [
        [sideX * 0.065, -0.055, -0.052],
        [sideX * 0.069, -0.12, -0.055],
        [sideX * 0.062, -0.29, -0.053],
        [sideX * 0.049, -0.366, -0.048],
      ],
      matThread,
      0.0012,
    );
    // Small diagonal cloth creases, not raised armour panels.
    seam(
      thigh,
      [
        [-0.045, -0.305, -0.06],
        [0, -0.315, -0.077],
        [0.043, -0.325, -0.059],
      ],
      matReinforce,
      0.0023,
    );
    var shin = pivot(thigh, 0, -THIGH_LEN, 0);
    shin.name = sideX < 0 ? "shinL" : "shinR";
    part(
      shin,
      cloth(
        [
          [-0.345, 0.044, 0.043, 0.005],
          [-0.315, 0.049, 0.049, 0.006],
          [-0.285, 0.052, 0.054, 0.009],
          [-0.245, 0.054, 0.06, 0.01],
          [-0.2, 0.058, 0.067, 0.011],
          [-0.15, 0.062, 0.071, 0.012],
          [-0.1, 0.061, 0.067, 0.008],
          [-0.055, 0.056, 0.059],
          [-0.015, 0.058, 0.061],
          [0.027, 0.055, 0.055],
        ],
        14,
        0.0045,
      ),
      matCloth,
    );
    // Integrated fabric knee pad with a compact rubber insert and seam piping.
    ellipsoid(shin, matReinforce, 0, -0.006, -0.048, 0.058, 0.07, 0.023, 12, 8);
    var knee = part(
      shin,
      chamferBox(0.077, 0.085, 0.019, 0.007),
      matGear,
      0,
      -0.002,
      -0.073,
    );
    knee.rotation.x = 0.08;
    for (var i = -1; i <= 1; i++)
      part(shin, box(0.048, 0.003, 0.003), matMetal, 0, i * 0.016, -0.084);
    seam(
      shin,
      [
        [-0.043, -0.06, -0.048],
        [-0.052, -0.02, -0.058],
        [-0.043, 0.048, -0.049],
        [0.043, 0.048, -0.049],
        [0.052, -0.02, -0.058],
        [0.043, -0.06, -0.048],
      ],
      matThread,
      0.0012,
    );
    seam(
      shin,
      [
        [sideX * 0.041, -0.1, -0.046],
        [sideX * 0.04, -0.23, -0.035],
        [sideX * 0.034, -0.3, -0.028],
      ],
      matThread,
      0.0011,
    );
    for (var i = 0; i < 2; i++)
      seam(
        shin,
        [
          [-0.033, -0.275 - i * 0.027, -0.038],
          [0, -0.266 - i * 0.027, -0.048],
          [0.034, -0.278 - i * 0.027, -0.034],
        ],
        matReinforce,
        0.0023,
      );
    var ankle = pivot(shin, 0, -SHIN_LEN, 0);
    buildBoot(ankle);
    return { thigh: thigh, shin: shin, ankle: ankle };
  }

  function buildBoot(ankle) {
    // Shaped leather uppers, a rounded toe box and a genuinely flat outsole.
    part(
      ankle,
      chamferBox(0.116, 0.024, 0.238, 0.009),
      matBoot,
      0,
      -0.108,
      -0.037,
    );
    part(
      ankle,
      chamferBox(0.108, 0.055, 0.195, 0.012),
      matGear,
      0,
      -0.071,
      -0.048,
    );
    ellipsoid(ankle, matBoot, 0, -0.064, -0.113, 0.054, 0.041, 0.073, 12, 7);
    part(
      ankle,
      cloth(
        [
          [-0.075, 0.052, 0.06, 0.005],
          [-0.04, 0.051, 0.054, 0.007],
          [0, 0.048, 0.048, 0.009],
          [0.04, 0.047, 0.046, 0.009],
          [0.062, 0.043, 0.042, 0.008],
        ],
        12,
        0.001,
      ),
      matGear,
    );
    part(ankle, arc(0.048, 0.022, 0, TAU, 12), matBoot, 0, 0.042, 0.008);
    part(
      ankle,
      chamferBox(0.061, 0.095, 0.014, 0.004),
      matReinforce,
      0,
      -0.002,
      -0.041,
      0.38,
    );
    for (var i = 0; i < 4; i++) {
      var y = 0.025 - i * 0.019,
        z = -0.052 - i * 0.009;
      part(
        ankle,
        tube(-0.025, y, z, 0.025, y - 0.013, z - 0.006, 0.0022, null, 4),
        matStrap,
      );
      part(
        ankle,
        tube(0.025, y, z, -0.025, y - 0.013, z - 0.006, 0.0022, null, 4),
        matStrap,
      );
      for (var side = -1; side <= 1; side += 2)
        part(
          ankle,
          box(0.008, 0.006, 0.005),
          matMetal,
          side * 0.027,
          y,
          z + 0.001,
        );
    }
    part(ankle, box(0.022, 0.045, 0.006), matStrap, 0, 0.038, 0.049, -0.12);
    seam(
      ankle,
      [
        [-0.045, -0.066, -0.095],
        [-0.03, -0.07, -0.163],
        [0.03, -0.07, -0.163],
        [0.045, -0.066, -0.095],
      ],
      matThread,
      0.0013,
    );
    for (var i = 0; i < 5; i++)
      for (var side = -1; side <= 1; side += 2)
        part(
          ankle,
          box(0.027, 0.009, 0.02),
          matBoot,
          side * 0.041,
          -0.116,
          -0.132 + i * 0.044,
        );
  }
  var legL = buildLeg(-1),
    legR = buildLeg(1);

  var torso = pivot(pelvis, 0, TORSO_LOCAL_Y, 0);
  // Keep the first torso mesh as the hips alignment landmark used by the tests.
  var hips = part(
    torso,
    cloth(
      [
        [-0.158, 0.105, 0.086],
        [-0.13, 0.141, 0.102],
        [-0.08, 0.151, 0.104],
        [-0.02, 0.145, 0.095],
      ],
      16,
      0.002,
      0.86,
    ),
    matCloth,
  );
  hips.name = "hips";
  var shirt = part(
    torso,
    cloth(
      [
        [-0.045, 0.137, 0.093],
        [0.02, 0.141, 0.097],
        [0.085, 0.148, 0.104],
        [0.17, 0.161, 0.111],
        [0.25, 0.173, 0.115],
        [0.32, 0.181, 0.108],
        [0.37, 0.184, 0.097],
        [0.414, 0.159, 0.083],
        [0.466, 0.096, 0.065, 0.018],
        [0.512, 0.057, 0.052, 0.025],
      ],
      18,
      0.0035,
      0.9,
    ),
    matCloth,
  );
  shirt.name = "shirt";
  var shirtRest = shirt.geometry.attributes.position.array.slice();
  var lastShirtCrouch = -1;
  // A soft waist belt follows the oval pelvis, with a flat front buckle.
  part(
    torso,
    cloth(
      [
        [-0.038, 0.149, 0.104],
        [0.007, 0.15, 0.104],
      ],
      16,
      0,
      0.8,
    ),
    matStrap,
  );
  part(
    torso,
    chamferBox(0.047, 0.031, 0.014, 0.003),
    matMetal,
    0,
    -0.014,
    -0.109,
  );
  part(torso, box(0.023, 0.015, 0.004), matDark, 0, -0.014, -0.118);
  for (var side = -1; side <= 1; side += 2) {
    part(
      torso,
      box(0.013, 0.052, 0.009),
      matReinforce,
      side * 0.086,
      -0.013,
      -0.091,
      0,
      side * 0.23,
    );
    part(
      torso,
      chamferBox(0.055, 0.087, 0.038, 0.007),
      matStrap,
      side * 0.12,
      -0.018,
      -0.101,
      0,
      -side * 0.4,
    );
    part(
      torso,
      box(0.025, 0.011, 0.004),
      matDark,
      side * 0.125,
      0.012,
      -0.126,
      0,
      -side * 0.4,
    );
  }
  // Tapered plate carrier: shoulder straps and separate front/back plates,
  // rather than a fluorescent cuboid wrapped around the entire rib cage.
  var vest = part(
    torso,
    slotSurface(
      cloth(
        [
          [0.055, 0.144, 0.106],
          [0.07, 0.16, 0.12],
          [0.12, 0.172, 0.124],
          [0.22, 0.177, 0.127],
          [0.3, 0.164, 0.12],
          [0.365, 0.116, 0.103],
        ],
        16,
        0,
        0.66,
      ),
      0.22,
    ),
    matAccent,
    0,
    0,
    0.002,
  );
  vest.name = "vest";
  // Bounding centre is 0.21 as before (torso hitbox alignment).
  for (var side = -1; side <= 1; side += 2) {
    part(
      torso,
      chamferBox(0.046, 0.112, 0.023, 0.006),
      matStrap,
      side * 0.101,
      0.387,
      -0.069,
      -0.35,
      0,
      side * 0.12,
    );
    part(
      torso,
      chamferBox(0.037, 0.027, 0.029, 0.003),
      matDark,
      side * 0.102,
      0.357,
      -0.091,
    );
    part(
      torso,
      box(0.022, 0.012, 0.004),
      matMetal,
      side * 0.102,
      0.357,
      -0.108,
    );
    part(
      torso,
      chamferBox(0.046, 0.098, 0.025, 0.006),
      matStrap,
      side * 0.102,
      0.387,
      0.067,
      0.42,
      0,
      -side * 0.08,
    );
    for (var row = 0; row < 3; row++)
      part(
        torso,
        chamferBox(0.014, 0.012, 0.124, 0.003),
        matStrap,
        side * 0.172,
        0.115 + row * 0.035,
        0.002,
      );
  }
  part(
    torso,
    chamferBox(0.176, 0.108, 0.014, 0.009),
    matReinforce,
    0,
    0.293,
    -0.119,
  );
  webbing(torso, 0, 0.327, -0.132, 0.137, 2);
  // Unit tape, an inset blank patch and pen retainers, all real small geometry.
  part(
    torso,
    chamferBox(0.067, 0.025, 0.004, 0.002),
    matDark,
    0.033,
    0.284,
    -0.131,
  );
  for (var i = 0; i < 3; i++)
    part(
      torso,
      box(0.004, 0.012, 0.001),
      matThread,
      0.017 + i * 0.012,
      0.284,
      -0.134,
    );
  for (var i = 0; i < 2; i++)
    part(
      torso,
      cyl(0.003, 0.039, 5),
      matMetal,
      -0.058 + i * 0.012,
      0.28,
      -0.136,
    );
  // Three curved magazine pouches with gussets, retention tabs and sewn edges.
  for (var col = -1; col <= 1; col++) {
    var x = col * 0.087,
      z = -0.13 + Math.abs(col) * 0.009;
    var pouch = pivot(torso, x, 0.14, z);
    pouch.rotation.y = -col * 0.1;
    part(pouch, chamferBox(0.077, 0.125, 0.037, 0.007), matStrap);
    part(
      pouch,
      chamferBox(0.079, 0.03, 0.04, 0.005),
      matReinforce,
      0,
      0.049,
      -0.003,
    );
    part(pouch, box(0.012, 0.057, 0.005), matDark, 0, 0.015, -0.023);
    part(
      pouch,
      chamferBox(0.019, 0.014, 0.008, 0.002),
      matMetal,
      0,
      0.033,
      -0.027,
    );
    seam(
      pouch,
      [
        [-0.03, 0.044, -0.021],
        [-0.03, -0.052, -0.021],
        [0.03, -0.052, -0.021],
        [0.03, 0.044, -0.021],
      ],
      matThread,
      0.0012,
    );
    part(pouch, box(0.056, 0.006, 0.002), matReinforce, 0, -0.031, -0.021);
  }
  // Compact hydration panel, not a hard robot power pack.
  part(
    torso,
    chamferBox(0.228, 0.247, 0.056, 0.012),
    matReinforce,
    0,
    0.213,
    0.13,
  );
  part(
    torso,
    chamferBox(0.185, 0.142, 0.026, 0.009),
    matStrap,
    0,
    0.177,
    0.166,
  );
  webbing(torso, 0, 0.284, 0.16, 0.17, 2);
  seam(
    torso,
    [
      [-0.088, 0.278, 0.163],
      [-0.101, 0.252, 0.164],
      [-0.101, 0.113, 0.164],
      [0.101, 0.113, 0.164],
      [0.101, 0.252, 0.164],
      [0.088, 0.278, 0.163],
    ],
    matThread,
    0.0015,
  );
  for (var side = -1; side <= 1; side += 2) {
    part(torso, box(0.014, 0.127, 0.006), matDark, side * 0.072, 0.175, 0.183);
    part(
      torso,
      chamferBox(0.023, 0.025, 0.012, 0.002),
      matMetal,
      side * 0.072,
      0.17,
      0.188,
    );
  }
  seam(
    torso,
    [
      [-0.039, 0.35, 0.119],
      [-0.035, 0.377, 0.123],
      [0.035, 0.377, 0.123],
      [0.039, 0.35, 0.119],
    ],
    matStrap,
    0.006,
  );
  // Radio at the flank, with restrained antenna and routed shoulder cable.
  part(
    torso,
    chamferBox(0.043, 0.089, 0.035, 0.005),
    matDark,
    0.137,
    0.264,
    0.097,
  );
  for (var i = 0; i < 3; i++)
    part(
      torso,
      box(0.026, 0.003, 0.003),
      matMetal,
      0.137,
      0.279 - i * 0.009,
      0.116,
    );
  part(
    torso,
    tube(0.139, 0.309, 0.1, 0.15, 0.458, 0.125, 0.0024, 0.0015, 5),
    matDark,
  );
  seam(
    torso,
    [
      [0.14, 0.29, 0.09],
      [0.133, 0.363, 0.069],
      [0.108, 0.401, 0.035],
      [0.093, 0.398, -0.045],
      [0.091, 0.31, -0.12],
    ],
    matDark,
    0.0035,
  );
  part(
    torso,
    chamferBox(0.025, 0.036, 0.015, 0.003),
    matDark,
    0.092,
    0.315,
    -0.124,
  );
  // Collar and shoulder seams join continuously to the neck and soft sleeve.
  var collar = pivot(torso, 0, 0.497, 0.025);
  part(collar, arc(0.058, 0.049, 0, TAU, 14), matReinforce);
  part(collar, box(0.009, 0.057, 0.006), matDark, 0, -0.022, -0.062);
  for (var side = -1; side <= 1; side += 2)
    seam(
      torso,
      [
        [side * 0.071, 0.421, -0.033],
        [side * 0.134, 0.405, -0.055],
        [side * 0.186, 0.375, -0.031],
      ],
      matThread,
      0.0015,
    );

  var forearmR = null,
    forearmL = null;
  function buildArm(sideX) {
    var shoulder = pivot(torso, sideX * SH_X, SH_Y, SH_Z);
    shoulder.name = sideX < 0 ? "shoulderL" : "shoulderR";
    part(
      shoulder,
      cloth(
        [
          [-0.3, 0.044, 0.047],
          [-0.276, 0.05, 0.052],
          [-0.244, 0.052, 0.056],
          [-0.212, 0.058, 0.061],
          [-0.174, 0.061, 0.063],
          [-0.125, 0.065, 0.068],
          [-0.075, 0.07, 0.073],
          [-0.025, 0.074, 0.075],
          [0.022, 0.066, 0.066],
          [0.054, 0.041, 0.044],
        ],
        14,
        0.0035,
      ),
      matCloth,
    );
    // Flat fabric sleeve pocket and a small blank hook-and-loop patch.
    var pocket = pivot(shoulder, sideX * 0.06, -0.119, 0);
    pocket.rotation.z = (sideX * Math.PI) / 2;
    part(pocket, chamferBox(0.073, 0.012, 0.08, 0.003), matReinforce);
    part(
      pocket,
      chamferBox(0.048, 0.004, 0.041, 0.001),
      matStrap,
      0,
      0.009,
      -0.009,
    );
    part(pocket, box(0.052, 0.003, 0.003), matThread, 0, 0.011, 0.025);
    seam(
      shoulder,
      [
        [sideX * 0.042, 0.035, -0.038],
        [sideX * 0.065, -0.024, -0.042],
        [sideX * 0.048, -0.174, -0.039],
      ],
      matThread,
      0.0012,
    );
    var elbow = pivot(shoulder, 0, -UPPER_LEN, 0);
    elbow.name = sideX < 0 ? "elbowL" : "elbowR";
    ellipsoid(elbow, matReinforce, 0, -0.001, 0.013, 0.049, 0.048, 0.05, 10, 6);
    var forearm = new THREE.Group();
    elbow.add(forearm);
    part(
      forearm,
      cloth(
        [
          [-0.27, 0.035, 0.035],
          [-0.247, 0.039, 0.038],
          [-0.219, 0.04, 0.041],
          [-0.184, 0.044, 0.046],
          [-0.145, 0.049, 0.052],
          [-0.101, 0.053, 0.055],
          [-0.062, 0.052, 0.055],
          [-0.027, 0.047, 0.049],
          [0.012, 0.044, 0.046],
        ],
        14,
        0.003,
      ),
      matCloth,
      0.002,
      0,
      0.002,
    );
    part(
      forearm,
      arc(0.038, 0.031, 0, TAU, 12),
      matReinforce,
      0.002,
      -0.246,
      0.002,
    );
    part(
      forearm,
      chamferBox(0.03, 0.015, 0.009, 0.002),
      matStrap,
      0.003,
      -0.241,
      -0.037,
    );
    seam(
      forearm,
      [
        [sideX * 0.03, -0.047, -0.038],
        [sideX * 0.035, -0.13, -0.037],
        [sideX * 0.026, -0.214, -0.029],
      ],
      matThread,
      0.0012,
    );
    if (sideX > 0) forearmR = forearm;
    else forearmL = forearm;
    return { shoulder: shoulder, elbow: elbow, forearm: forearm };
  }
  var armL = buildArm(-1),
    armR = buildArm(1);

  // —— 步枪：PAC-9 世界枪（weapon.js buildGunWorldModel，只搬枪不搬手——
  //    手由 rig.js Vv graft）。枪局部 grip 点对位到枪枢轴原点=右手掌抓握点 →
  //    握把入手、机匣在上、枪口朝 -Z；GUN_OFF/枪口公式与 v1 逐字一致。
  //    weapon 模块缺席/构建异常时兜底回简化盒体枪杆，化身绝不因换枪塌掉。
  var gun = pivot(armR.elbow, GUN_X, GUN_Y, GUN_Z);
  gun.name = "gunR";
  var worldGun = null;
  try {
    worldGun = buildGunWorldModel({ castShadow: castShadow });
  } catch (e) {
    worldGun = null;
  }
  if (worldGun && worldGun.root) {
    var gripP = worldGun.grip; // [x, y, z] 握把在枪局部系的位置
    worldGun.root.position.set(-gripP[0], -gripP[1], -gripP[2]);
    gun.add(worldGun.root);
  } else {
    part(gun, box(0.05, 0.1, 0.34), matDark, 0, 0.01, -0.1); // 机匣
    part(gun, box(0.035, 0.05, 0.26), matDark, 0, 0.045, -0.36); // 枪管
    part(gun, box(0.045, 0.13, 0.06), matDark, 0, -0.08, -0.06); // 弹匣
    part(gun, box(0.045, 0.1, 0.14), matGear, 0, -0.005, 0.12); // 枪托
    part(gun, box(0.04, 0.045, 0.1), matDark, 0, 0.075, -0.28); // 瞄具导轨座
  }

  // —— Vv 手套 graft（§9.2：视图模型双手 1:1 移植到握把/护木挂点）——
  //    手组挂枪枢轴系：右手掌抓握点=握把（枪枢轴原点），左手抓握点=护木
  //    （weapon.js 视图模型关键帧 G 的抓握位 1:1）。Vv 不可用时兜底简化盒手套。
  var worldHands = null;
  var handLGroup = null;
  var graftOK = false;
  try {
    worldHands = buildWorldHands(castShadow);
  } catch (e) {
    worldHands = null;
  }
  if (worldHands && worldGun) {
    try {
      var qR = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(-0.24, 0, 0))
        .multiply(
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, 0, -Math.PI / 2),
          ),
        );
      var qL = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
        .multiply(
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, 0, 0)),
        );
      // 右手组：手局部 HAND_GRIP_LOCAL 落在枪枢轴原点
      var handRGroup = new THREE.Group();
      handRGroup.quaternion.copy(qR);
      handRGroup.position
        .set(HAND_GRIP_LOCAL[0], HAND_GRIP_LOCAL[1], HAND_GRIP_LOCAL[2])
        .applyQuaternion(qR)
        .negate();
      var meshR = new THREE.Mesh(worldHands.fabricR, matGlove);
      meshR.castShadow = castShadow;
      meshR.receiveShadow = true;
      handRGroup.add(meshR);
      gun.add(handRGroup);
      // 左手组：手局部 HAND_GUARD_LOCAL 落在枪局部 HAND_GUARD_GRASP
      handLGroup = new THREE.Group();
      handLGroup.quaternion.copy(qL);
      handLGroup.position
        .set(
          HAND_GUARD_GRASP[0] - gripP[0],
          HAND_GUARD_GRASP[1] - gripP[1],
          HAND_GUARD_GRASP[2] - gripP[2],
        )
        .sub(
          new THREE.Vector3(
            HAND_GUARD_LOCAL[0],
            HAND_GUARD_LOCAL[1],
            HAND_GUARD_LOCAL[2],
          ).applyQuaternion(qL),
        );
      var meshL = new THREE.Mesh(worldHands.fabricL, matGlove);
      meshL.castShadow = castShadow;
      meshL.receiveShadow = true;
      handLGroup.add(meshL);
      gun.add(handLGroup);
      graftOK = true;
    } catch (e) {
      graftOK = false;
    }
  }
  if (!graftOK) {
    // 兜底：简化盒手套（挂同款腕锚位形，IK/瞄准逻辑不受影响）
    part(gun, box(0.05, 0.085, 0.1), matGear, 0.031, 0.026, 0.081);
    part(gun, box(0.05, 0.085, 0.1), matGear, -0.027, 0.038, -0.253);
    if (worldHands) {
      try {
        worldHands.dispose();
      } catch {}
      worldHands = null;
    }
  }
  // 腕锚（枪枢轴系常量；IK/瞄准目标点）
  var WRIST_R = [0.031, 0.026, 0.081];
  var WRIST_L = [-0.0267, 0.038, -0.2532];
  var handLBindPosition = handLGroup ? handLGroup.position.clone() : null;
  var handLBindQuaternion = handLGroup ? handLGroup.quaternion.clone() : null;

  // A human head, exposed face and fitted high-cut helmet. No full-face steel
  // visor: cheekbones, nose, ears, lips and the jaw carry the facial silhouette.
  var neckGeometry = new THREE.CylinderGeometry(0.043, 0.052, 1, 12);
  geos.push(neckGeometry);
  var neck = part(torso, neckGeometry, matFace, 0, 0.49, 0.012);
  neck.name = "neck";
  var headPivot = pivot(torso, 0, 0.567, 0.015);
  var faceGeometry = cloth(
    [
      [0.009, 0.032, 0.045, -0.02],
      [0.02, 0.05, 0.058, -0.014],
      [0.038, 0.065, 0.069, -0.007],
      [0.063, 0.078, 0.079, -0.002],
      [0.088, 0.09, 0.088, 0.004],
      [0.115, 0.096, 0.094, 0.006],
      [0.14, 0.096, 0.096, 0.008],
      [0.165, 0.094, 0.095, 0.009],
      [0.19, 0.083, 0.083, 0.009],
      [0.21, 0.063, 0.064, 0.009],
      [0.221, 0.035, 0.04, 0.008],
    ],
    28,
    0,
  );
  var facePositions = faceGeometry.attributes.position,
    faceColors = [];
  for (var i = 0; i < facePositions.count; i++) {
    var y = facePositions.getY(i),
      z = facePositions.getZ(i),
      x = facePositions.getX(i);
    // Continuous cheekbones and a little jaw stubble, without separate balls
    // sitting on the face. Geometry remains centred on the head hit sphere.
    var cheek = Math.exp(
      -Math.pow((Math.abs(x) - 0.054) / 0.026, 2) -
        Math.pow((y - 0.095) / 0.026, 2),
    );
    if (z < 0) facePositions.setZ(i, z - cheek * 0.004);
    var beard = clamp01((0.083 - y) / 0.055) * clamp01(-z / 0.04) * 0.2;
    faceColors.push(1 - beard, 1 - beard * 0.9, 1 - beard * 0.8);
  }
  faceGeometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(faceColors, 3),
  );
  faceGeometry.computeVertexNormals();
  var matHead = own(matFace.clone());
  matHead.vertexColors = true;
  var head = part(headPivot, faceGeometry, matHead);
  head.name = "head";
  // Subtle cheek and muzzle volumes avoid a featureless egg or a box jaw.
  for (var side = -1; side <= 1; side += 2) {
    ellipsoid(
      headPivot,
      matSkinShadow,
      side * 0.035,
      0.134,
      -0.082,
      0.02,
      0.006,
      0.003,
      10,
      5,
    );
    ellipsoid(
      headPivot,
      matEyeWhite,
      side * 0.035,
      0.133,
      -0.085,
      0.013,
      0.003,
      0.002,
      10,
      5,
    );
    ellipsoid(
      headPivot,
      matEye,
      side * 0.035,
      0.133,
      -0.087,
      0.0035,
      0.003,
      0.0015,
      8,
      5,
    );
    seam(
      headPivot,
      [
        [side * 0.018, 0.137, -0.086],
        [side * 0.034, 0.14, -0.086],
        [side * 0.052, 0.137, -0.078],
      ],
      matFace,
      0.0014,
    );
    part(
      headPivot,
      tube(
        side * 0.018,
        0.146,
        -0.087,
        side * 0.055,
        0.147,
        -0.075,
        0.0023,
        null,
        5,
      ),
      matSkinShadow,
    );
    ellipsoid(
      headPivot,
      matFace,
      side * 0.094,
      0.105,
      0.002,
      0.015,
      0.028,
      0.018,
      10,
      7,
    );
    ellipsoid(
      headPivot,
      matSkinShadow,
      side * 0.104,
      0.106,
      -0.003,
      0.004,
      0.015,
      0.009,
      8,
      5,
    );
  }
  part(
    headPivot,
    cloth(
      [
        [0.081, 0.013, 0.008, -0.086],
        [0.09, 0.016, 0.013, -0.098],
        [0.103, 0.011, 0.012, -0.096],
        [0.124, 0.009, 0.008, -0.086],
        [0.145, 0.007, 0.005, -0.08],
      ],
      12,
      0,
    ),
    matFace,
  );
  seam(
    headPivot,
    [
      [-0.021, 0.061, -0.08],
      [-0.008, 0.059, -0.083],
      [0, 0.06, -0.084],
      [0.008, 0.059, -0.083],
      [0.021, 0.061, -0.08],
    ],
    matSkinShadow,
    0.0009,
  );
  seam(
    headPivot,
    [
      [-0.012, 0.055, -0.081],
      [0, 0.054, -0.083],
      [0.012, 0.055, -0.081],
    ],
    matSkinLight,
    0.0011,
  );
  // Helmet crown is cut above the ears. It follows the skull instead of a
  // vertical cylindrical brim that reads like a robot head.
  var helmetGeometry = dome(0.119, 24, 12, Math.PI * 0.56);
  var hp = helmetGeometry.attributes.position;
  for (var i = 0; i < hp.count; i++) {
    var x = hp.getX(i),
      y = hp.getY(i),
      z = hp.getZ(i);
    // Lift the lower side edge for the headset; keep the brow and rear coverage.
    var sideLift =
      Math.pow(Math.min(1, Math.abs(x) / 0.11), 4) *
      0.017 *
      Math.max(0, 1 - y / 0.06);
    var frontLift =
      Math.max(0, -z / 0.119) * 0.037 * Math.max(0, 1 - y / 0.065);
    hp.setXYZ(i, x, y + sideLift + frontLift, z);
  }
  helmetGeometry.computeVertexNormals();
  var helmet = part(
    headPivot,
    slotSurface(helmetGeometry, 0.24),
    matAccent,
    0,
    0.139,
    0.007,
  );
  helmet.scale.set(1.015, 0.94, 1.065);
  helmet.name = "helmet";
  // A narrow rubber brow lip, centre shroud and two sewn cover panels.
  part(
    headPivot,
    chamferBox(0.136, 0.013, 0.026, 0.004),
    matGear,
    0,
    0.166,
    -0.094,
    -0.18,
  );
  part(
    headPivot,
    chamferBox(0.028, 0.039, 0.012, 0.003),
    matDark,
    0,
    0.193,
    -0.109,
    -0.3,
  );
  part(
    headPivot,
    chamferBox(0.014, 0.018, 0.008, 0.002),
    matMetal,
    0,
    0.193,
    -0.118,
    -0.3,
  );
  for (var side = -1; side <= 1; side += 2) {
    seam(
      headPivot,
      [
        [side * 0.043, 0.17, -0.101],
        [side * 0.052, 0.228, -0.063],
        [side * 0.047, 0.249, 0.005],
        [side * 0.041, 0.225, 0.081],
      ],
      matStrap,
      0.0017,
    );
    // Small rail and fabric velcro panel, not a full mechanical side assembly.
    part(
      headPivot,
      chamferBox(0.012, 0.02, 0.074, 0.003),
      matGear,
      side * 0.112,
      0.159,
      0.02,
      0,
      0,
      side * 0.13,
    );
    for (var j = 0; j < 3; j++)
      part(
        headPivot,
        box(0.004, 0.009, 0.007),
        matMetal,
        side * 0.12,
        0.158,
        -0.004 + j * 0.019,
      );
    ellipsoid(
      headPivot,
      matGear,
      side * 0.107,
      0.092,
      0.018,
      0.022,
      0.041,
      0.033,
      12,
      8,
    );
    ellipsoid(
      headPivot,
      matReinforce,
      side * 0.125,
      0.093,
      0.018,
      0.009,
      0.031,
      0.024,
      10,
      7,
    );
    seam(
      headPivot,
      [
        [side * 0.1, 0.158, 0.017],
        [side * 0.119, 0.126, 0.024],
        [side * 0.118, 0.108, 0.027],
      ],
      matDark,
      0.004,
    );
    // Flat webbing chin straps, following the cheeks instead of crossing midair.
    part(
      headPivot,
      tube(
        side * 0.087,
        0.134,
        0.015,
        side * 0.077,
        0.06,
        -0.005,
        0.004,
        null,
        4,
      ),
      matStrap,
    );
    part(
      headPivot,
      tube(
        side * 0.077,
        0.06,
        -0.005,
        side * 0.038,
        0.019,
        -0.044,
        0.004,
        null,
        4,
      ),
      matStrap,
    );
  }
  part(
    headPivot,
    chamferBox(0.021, 0.012, 0.009, 0.002),
    matDark,
    0.047,
    0.026,
    -0.039,
  );
  // Raised goggles sit close against the helmet, leaving both eyes and face
  // visible. Two separate, curved lenses replace the old floating black slab.
  for (var side = -1; side <= 1; side += 2) {
    var goggles = pivot(headPivot, side * 0.041, 0.215, -0.089);
    goggles.rotation.set(-0.38, side * 0.14, side * 0.04);
    part(goggles, chamferBox(0.073, 0.041, 0.021, 0.006), matBoot);
    part(
      goggles,
      chamferBox(0.059, 0.027, 0.007, 0.004),
      matLens,
      0,
      0,
      -0.013,
    );
    part(goggles, box(0.041, 0.002, 0.002), matMetal, 0, 0.011, -0.018);
  }
  part(
    headPivot,
    tube(-0.009, 0.216, -0.1, 0.009, 0.216, -0.1, 0.004, null, 5),
    matDark,
  );
  seam(
    headPivot,
    [
      [-0.12, 0.195, 0.005],
      [-0.083, 0.195, 0.091],
      [0, 0.195, 0.119],
      [0.083, 0.195, 0.091],
      [0.12, 0.195, 0.005],
    ],
    matStrap,
    0.006,
  );
  // Headset boom terminates beside the mouth rather than hiding it.
  seam(
    headPivot,
    [
      [-0.124, 0.093, 0.005],
      [-0.116, 0.06, -0.052],
      [-0.058, 0.056, -0.093],
    ],
    matDark,
    0.0027,
  );
  ellipsoid(
    headPivot,
    matBoot,
    -0.053,
    0.056,
    -0.094,
    0.013,
    0.007,
    0.008,
    8,
    5,
  );

  // Batch the sewn details within each rigid joint. Extra seam geometry should
  // cost triangles, not hundreds of extra draw calls per remote player. Named
  // hitbox landmarks and the moving neck remain separate. Never touch PAC-9/Vv.
  function batchDetails(node) {
    if (node === gun) return;
    var children = node.children.slice(),
      batches = new Map();
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.isGroup) batchDetails(child);
      if (!child.isMesh || child.name || Array.isArray(child.material))
        continue;
      var list = batches.get(child.material);
      if (!list) {
        list = [];
        batches.set(child.material, list);
      }
      list.push(child);
    }
    batches.forEach(function (meshes, material) {
      if (meshes.length < 2) return;
      var positions = [],
        normals = [],
        uvs = [],
        indices = [],
        colors = [],
        offset = 0;
      var normalMatrix = new THREE.Matrix3(),
        v = new THREE.Vector3();
      for (var j = 0; j < meshes.length; j++) {
        var mesh = meshes[j],
          g = mesh.geometry,
          p = g.attributes.position,
          n = g.attributes.normal;
        mesh.updateMatrix();
        normalMatrix.getNormalMatrix(mesh.matrix);
        for (var k = 0; k < p.count; k++) {
          v.fromBufferAttribute(p, k).applyMatrix4(mesh.matrix);
          positions.push(v.x, v.y, v.z);
          v.fromBufferAttribute(n, k).applyMatrix3(normalMatrix).normalize();
          normals.push(v.x, v.y, v.z);
          var uv = g.attributes.uv,
            col = g.attributes.color;
          uvs.push(uv ? uv.getX(k) : 0, uv ? uv.getY(k) : 0);
          colors.push(
            col ? col.getX(k) : 1,
            col ? col.getY(k) : 1,
            col ? col.getZ(k) : 1,
          );
        }
        if (g.index)
          for (var k = 0; k < g.index.count; k++)
            indices.push(offset + g.index.getX(k));
        else for (var k = 0; k < p.count; k++) indices.push(offset + k);
        offset += p.count;
        node.remove(mesh);
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      merged.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(normals, 3),
      );
      merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      if (material.vertexColors)
        merged.setAttribute(
          "color",
          new THREE.Float32BufferAttribute(colors, 3),
        );
      merged.setIndex(indices);
      geos.push(merged);
      var detail = part(node, merged, material);
      detail.name = "sewn-details";
      // Every primitive in a batch is unique to this avatar; retire it now.
      var retired = new Set(
        meshes.map(function (mesh) {
          return mesh.geometry;
        }),
      );
      retired.forEach(function (g) {
        g.dispose();
      });
      geos = geos.filter(function (g) {
        return !retired.has(g);
      });
    });
  }
  batchDetails(root);

  // ———————————— 程序化姿态（持久状态全部经 dt 推进，帧率无关）————
  var t = 0; // 动画钟（呼吸等绝对相位）
  var phase = 0; // 步态相位
  var speed = 0;
  var moveAmt = 0;
  var crouchAmt = 0;
  var sprintAmt = 0;
  var adsAmt = 0;
  var prevVy = 0;
  var landT = -1; // >=0 表示着地缓冲进行中
  var deathT = -1; // >=0 表示倒伏计时进行中

  // IK/瞄准 scratch（闭包一次性分配）
  var _ikD = new THREE.Vector3();
  var _ikN = new THREE.Vector3();
  var _ikTmp = new THREE.Vector3();
  var _ikUp = new THREE.Vector3();
  var _ikFore = new THREE.Vector3();
  var _ikElbow = new THREE.Vector3();
  var _ikAnchor = new THREE.Vector3();
  var _ikElbowR = new THREE.Vector3();
  var _DOWN = new THREE.Vector3(0, -1, 0);
  var _qShR = new THREE.Quaternion();
  var _qChR = new THREE.Quaternion();
  var _qGun = new THREE.Quaternion();
  var _qUpL = new THREE.Quaternion();
  var _qTmp2 = new THREE.Quaternion();
  var _eul = new THREE.Euler();
  var _XAXIS = new THREE.Vector3(1, 0, 0);

  function applyEmissive() {
    matAccent.emissive.copy(baseGlow);
    if (flashM > 0) matAccent.emissive.lerp(redFlash, clamp01(flashM) * 0.9);
  }

  function applyPose(state, dt) {
    if (disposed) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1; // 卡顿帧夹取，防相位跳变
    t += dt;
    var s = state || {};
    var alive = s.alive !== false;

    // —— 死亡：后倒+微侧倒 0.45s easeOut 定格；四肢松弛散开 ——
    if (!alive) {
      if (deathT < 0) {
        deathT = 0;
        // The support hand leaves the rifle with its arm. Preserve the actual
        // Vv hand and shader; only its attachment changes for the death pose.
        if (graftOK && handLGroup) {
          root.updateMatrixWorld(true);
          forearmL.attach(handLGroup);
          handLGroup.position.set(0, -FOREARM_LEN, 0);
          handLGroup.scale.set(1, 1, 1);
        }
      }
      deathT += dt;
      var du = easeOutCubic(Math.min(deathT / DEATH_DUR, 1));
      tilt.rotation.x = du * 1.5; // 后倒 ~86°
      tilt.rotation.z = du * 0.38; // 带一点侧倒
      tilt.position.y = du * 0.07; // 身体厚度垫高，防半埋地
      armL.shoulder.rotation.set(0.1 * du, 0, -0.9 * du);
      armR.shoulder.rotation.set(0.15 * du, 0, 0.9 * du);
      armL.elbow.rotation.x = 0.3 * du;
      armR.elbow.rotation.x = 0.25 * du;
      forearmL.quaternion.setFromAxisAngle(_XAXIS, 0.25 * du);
      forearmR.quaternion.setFromAxisAngle(_XAXIS, 0.2 * du);
      forearmL.scale.y = 1;
      forearmR.scale.y = 1;
      legL.thigh.rotation.x = 0.08 * du;
      legL.shin.rotation.x = -0.15 * du;
      legL.ankle.rotation.x = 0.1 * du;
      legR.thigh.rotation.x = 0.2 * du;
      legR.shin.rotation.x = -0.55 * du;
      legR.ankle.rotation.x = 0.35 * du;
      gun.rotation.x = -0.5 * du;
      _ikFore
        .set(WRIST_R[0], WRIST_R[1], WRIST_R[2])
        .applyEuler(gun.rotation)
        .add(gun.position);
      var deathReach = _ikFore.length();
      forearmR.quaternion.setFromUnitVectors(_DOWN, _ikFore.normalize());
      forearmR.scale.y = deathReach / FOREARM_LEN;
      headPivot.rotation.x = 0.15 * du;
      applyEmissive();
      return;
    }
    // 复活自愈：清倒伏残留
    if (deathT >= 0) {
      deathT = -1;
      tilt.rotation.set(0, 0, 0);
      tilt.position.y = 0;
      if (graftOK && handLGroup) {
        gun.add(handLGroup);
        handLGroup.position.copy(handLBindPosition);
        handLGroup.quaternion.copy(handLBindQuaternion);
        handLGroup.scale.set(1, 1, 1);
      }
    }

    // —— 平滑量（指数趋近，帧率无关）——
    var kFast = 1 - Math.exp(-10 * dt);
    var kMid = 1 - Math.exp(-8 * dt);
    var spd = Math.max(0, Math.min(+s.speed || 0, 8));
    speed += (spd - speed) * kMid;
    var moving = speed > 0.35;
    moveAmt += ((moving ? 1 : 0) - moveAmt) * kMid;
    crouchAmt += ((s.crouch ? 1 : 0) - crouchAmt) * kFast;
    sprintAmt += ((s.sprint ? 1 : 0) - sprintAmt) * kMid;
    adsAmt += ((s.ads ? 1 : 0) - adsAmt) * kFast;
    var pitch = +s.pitch || 0;

    // —— 着地：垂直速度骤停检测 → 下沉回弹（正弦半波）——
    var vy = +s.vy || 0;
    if (prevVy < LAND_VY_HIT && vy > -0.8) landT = 0;
    prevVy = vy;
    if (landT >= 0) {
      landT += dt;
      if (landT > LAND_DUR) landT = -1;
    }
    var sink =
      landT >= 0 ? Math.sin(Math.PI * (1 - landT / LAND_DUR)) * 0.1 : 0;

    // —— 步态：步频/摆幅随速度（正弦腿摆，周期 2 步）——
    phase += dt * (0.35 + speed * 0.24) * TAU;
    var amp = moveAmt * Math.min(0.16 + speed * 0.075, 0.62);
    var swing = Math.sin(phase) * amp;
    var bob =
      (0.5 - 0.5 * Math.cos(phase * 2)) * (0.02 + speed * 0.006) * moveAmt;

    // —— 后坐（fireT 由调用方喂剩余秒数，线性衰减=踢出去就全量）+ 换弹进度 ——
    var fireT = typeof s.fireT === "number" ? Math.max(0, s.fireT) : 0;
    var kick = clamp01(fireT / RECOIL_DUR);
    var reload = typeof s.reload === "number" ? s.reload : -1;
    var reloadDip = reload >= 0 && reload <= 1 ? Math.sin(Math.PI * reload) : 0;

    // —— 骨盆：蹲伏降高 + 步态起伏 + 着地下沉 + 侧向重心微移 ——
    pelvis.position.y = HIP_Y - crouchAmt * CROUCH_DROP - bob - sink * 0.9;
    pelvis.rotation.z = Math.sin(phase) * 0.035 * moveAmt;

    // —— 腿：正弦腿摆 + 摆动相屈膝 + 蹲姿屈腿（0.80/1.03 定标：脚贴地）+
    //    踝反旋保脚掌贴地 + 蹬地趾离地 + 着地缓冲 ——
    var kneeAmp = amp * 1.35;
    var crouchThigh = crouchAmt * 0.76;
    var crouchKnee = crouchAmt * 0.95;
    var kneeSwL = Math.max(0, Math.cos(phase)) * kneeAmp;
    var kneeSwR = Math.max(0, -Math.cos(phase)) * kneeAmp;
    var thighL = 0.04 + swing + crouchThigh + sink * 0.5;
    var thighR = 0.04 - swing + crouchThigh + sink * 0.5;
    var shinL = -0.08 - kneeSwL - crouchKnee - sink * 1.5;
    var shinR = -0.08 - kneeSwR - crouchKnee - sink * 1.5;
    legL.thigh.rotation.x = thighL;
    legL.shin.rotation.x = shinL;
    legL.ankle.rotation.x =
      -(thighL + shinL) * 0.72 +
      Math.max(0, -swing) * 1.1 * moveAmt * (1 - crouchAmt);
    legR.thigh.rotation.x = thighR;
    legR.shin.rotation.x = shinR;
    legR.ankle.rotation.x =
      -(thighR + shinR) * 0.72 +
      Math.max(0, swing) * 1.1 * moveAmt * (1 - crouchAmt);

    // —— 躯干：持枪前倾（送肩够护木腕锚，冲刺衰减）+ 速度前倾 + 冲刺 8°(0.14rad)
    //    + 蹲伏弓身 + 呼吸起伏 + 后坐肩缩 ——
    var hunch = CARRY_HUNCH * (1 - 0.75 * sprintAmt) + crouchAmt * CROUCH_BOW;
    var lean =
      moveAmt * Math.min(0.04 + speed * 0.011, 0.12) +
      sprintAmt * 0.14 +
      crouchAmt * 0.05 +
      adsAmt * 0.03 +
      sink * 0.45;
    var br = Math.sin(t * 1.8) * (1 - moveAmt) * (1 - adsAmt); // idle 呼吸
    torso.rotation.x = -(lean + hunch) + kick * 0.05;
    torso.position.y = TORSO_LOCAL_Y + br * 0.008 - kick * 0.012;
    // Lean around the chest rather than translating the whole hit silhouette
    // in front of the server's vertical body cylinder. The hips stay upright.
    var torsoCos = Math.cos(torso.rotation.x);
    var torsoSin = Math.sin(torso.rotation.x);
    torso.position.y += 0.21 * (1 - torsoCos) - crouchAmt * 0.02;
    torso.position.z = -torsoSin * 0.21;
    hips.rotation.x = -torso.rotation.x;
    hips.position.set(
      0,
      torsoCos * (0.089 - torso.position.y) - torsoSin * torso.position.z,
      -torsoSin * (0.089 - torso.position.y) - torsoCos * torso.position.z,
    );

    // —— 右臂：FK 常数（idle carry ↔ ADS 贴腮；冲刺垂枪）+ 走路随枪小摆 + 后坐 ——
    var carryR = CARRY_R_SHOULDER - sprintAmt * 0.2;
    var elbowCarryR = CARRY_R_ELBOW - sprintAmt * 0.45;
    var sideR = lerp(CARRY_R_SIDE, ADS_R_SIDE, adsAmt) - 0.08 * sprintAmt;
    var pumpR = swing * 0.5 * (1 - adsAmt) * (0.3 + sprintAmt * 0.9);
    var shoulderRx =
      lerp(carryR, ADS_R_SHOULDER, adsAmt) + pumpR + br * 0.03 + kick * 0.06;
    var elbowRx = lerp(elbowCarryR, ADS_R_ELBOW, adsAmt) + kick * 0.1;
    armR.shoulder.rotation.set(shoulderRx, 0, sideR);
    armR.elbow.rotation.x = elbowRx;

    // —— 枪：抵偿旋转/ADS 上抬/冲刺低位持枪/换弹下压/后坐上挑 ——
    var armChain = torso.rotation.x + shoulderRx + elbowRx;
    var gunRx =
      pitch - armChain - sprintAmt * 0.42 - reloadDip * 0.55 + kick * 0.22;
    gun.rotation.x = gunRx;
    gun.position.set(
      GUN_X,
      GUN_Y + adsAmt * 0.1 + kick * 0.008,
      GUN_Z + kick * 0.05,
    );

    // —— 右小臂 Mesh 朝右腕锚全向瞄准（腕锚=枪局部 WRIST_R 随枪 rx 旋转到肘系；
    //    含小幅 x 侧偏）+ 轴向弹性伸缩（pitch 摆动下腕锚距 0.21..0.35 波动，
    //    袖管+伸缩吸收）——
    var ay = WRIST_R[1],
      az = WRIST_R[2];
    var cg = Math.cos(gunRx),
      sg = Math.sin(gunRx);
    var anchorY = gun.position.y + ay * cg - az * sg;
    var anchorZ = gun.position.z + ay * sg + az * cg;
    var anchorX = gun.position.x + WRIST_R[0]; // Rx 不改 x 分量
    var anchorLen =
      Math.sqrt(anchorX * anchorX + anchorY * anchorY + anchorZ * anchorZ) ||
      1e-6;
    _ikFore.set(anchorX, anchorY, anchorZ).multiplyScalar(1 / anchorLen);
    forearmR.quaternion.setFromUnitVectors(_DOWN, _ikFore);
    forearmR.scale.y = Math.max(0.8, Math.min(1.4, anchorLen / FOREARM_LEN));

    // —— 左臂：2 骨 IK 对位 Vv 左腕锚（§9.2 臂链目标=手的腕部）——
    //    锚位=肩R→肘R→枪→手L 腕（躯干系解析链），极向量=下方偏内（肘垂）。
    _qShR.setFromEuler(_eul.set(shoulderRx, 0, sideR));
    _qChR.copy(_qShR).multiply(_qTmp2.setFromAxisAngle(_XAXIS, elbowRx));
    _qGun.setFromAxisAngle(_XAXIS, gunRx);
    _ikElbowR
      .set(0, -UPPER_LEN, 0)
      .applyQuaternion(_qShR)
      .add(_ikTmp.set(SH_X, SH_Y, SH_Z)); // 右肘（躯干系）
    _ikAnchor
      .set(WRIST_L[0], WRIST_L[1], WRIST_L[2])
      .applyQuaternion(_qGun)
      .add(gun.position)
      .applyQuaternion(_qChR)
      .add(_ikElbowR); // 左腕锚（躯干系）
    _ikD.copy(_ikAnchor).sub(_ikTmp.set(-SH_X, SH_Y, SH_Z)); // D = 锚 - 左肩
    var dLen = _ikD.length();
    if (dLen > 0.04) {
      _ikD.multiplyScalar(1 / dLen);
      // 极向量：躯干系下方偏内偏前（左肘自然垂）
      _ikTmp.set(0.14, -1, 0.22).cross(_ikD); // D̂ × pole
      if (_ikTmp.lengthSq() < 1e-6) _ikTmp.set(0, 0, 1);
      _ikN.copy(_ikTmp).cross(_ikD).normalize(); // pole ⊥ D
      var reach = Math.min(dLen, UPPER_LEN + FOREARM_LEN - 0.004);
      var aProj =
        (UPPER_LEN * UPPER_LEN - FOREARM_LEN * FOREARM_LEN + reach * reach) /
        (2 * reach);
      var hLen = Math.sqrt(Math.max(0, UPPER_LEN * UPPER_LEN - aProj * aProj));
      _ikElbow
        .set(-SH_X, SH_Y, SH_Z)
        .addScaledVector(_ikD, aProj)
        .addScaledVector(_ikN, hLen); // 左肘（躯干系）
      // 上臂方向 → (SL, ZL)（Euler XYZ 分解：upperDir = Rx(SL)·Rz(ZL)·(0,-1,0)）
      _ikUp
        .copy(_ikElbow)
        .sub(_ikTmp.set(-SH_X, SH_Y, SH_Z))
        .normalize();
      var sl = Math.atan2(-_ikUp.z, -_ikUp.y);
      var zl = Math.asin(Math.max(-0.999, Math.min(0.999, _ikUp.x)));
      _qUpL.setFromEuler(_eul.set(sl, 0, zl));
      // 肘内角 → EL（前臂方向在 上臂系 的 x 旋转量）
      _ikFore.copy(_ikAnchor).sub(_ikElbow).normalize();
      _ikFore.applyQuaternion(_qTmp2.copy(_qUpL).invert());
      var el = Math.atan2(-_ikFore.z, -_ikFore.y);
      armL.shoulder.rotation.set(sl, 0, zl);
      armL.elbow.rotation.x = el;
      // 左小臂 Mesh 同样全向瞄准+伸缩：IK 肘位精确，但 Euler(SL,ZL,EL) 对前臂
      // 方向的可表示性有残差（横越持枪的 x 侧偏最大），端点对齐由 Mesh 瞄准吸收
      _qUpL.multiply(_qTmp2.setFromAxisAngle(_XAXIS, el)); // = qChainL
      _ikFore.copy(_ikAnchor).sub(_ikElbow).applyQuaternion(_qUpL.invert());
      var fLen = _ikFore.length() || 1e-6;
      forearmL.quaternion.setFromUnitVectors(
        _DOWN,
        _ikFore.multiplyScalar(1 / fLen),
      );
      forearmL.scale.y = Math.max(0.85, Math.min(1.35, fLen / FOREARM_LEN));
    }
    // 换弹视觉：左肩随枪下压的残差微沉（IK 已跟随枪俯仰，此处补一点肩沉观感）
    if (reloadDip > 0) armL.shoulder.rotation.x -= reloadDip * 0.12;

    // —— 头：俯仰跟随（0.55 比例）+ 抵消持枪前倾/蹲伏弓身保持平视 ——
    headPivot.rotation.x = pitch * 0.55 + hunch * 0.9;

    // Let the fabric neck opening shorten with a crouch; a rigid tall collar
    // would intersect the jaw when the head follows the lower hit sphere.
    collar.position.y = 0.497 - crouchAmt * 0.08;
    if (Math.abs(crouchAmt - lastShirtCrouch) > 0.0001) {
      var shirtPositions = shirt.geometry.attributes.position;
      for (var i = 0; i < shirtPositions.count; i++) {
        var restY = shirtRest[i * 3 + 1];
        shirtPositions.setY(
          i,
          restY - crouchAmt * 0.08 * clamp01((restY - 0.32) / 0.192),
        );
      }
      shirtPositions.needsUpdate = true;
      shirt.geometry.computeVertexNormals();
      shirt.geometry.computeBoundingSphere();
      shirt.geometry.computeBoundingBox();
      lastShirtCrouch = crouchAmt;
    }

    // Aiming/crouch must not move the visible head outside its analytic hitbox.
    // Preserve the original head pitch, but solve its centre in pelvis space.
    var headCos = Math.cos(headPivot.rotation.x);
    var headSin = Math.sin(headPivot.rotation.x);
    var headY = 0.76 - crouchAmt * 0.11 - torso.position.y;
    headPivot.position.set(
      0,
      torsoCos * headY -
        torsoSin * torso.position.z -
        headCos * 0.115 +
        headSin * 0.008,
      -torsoSin * headY -
        torsoCos * torso.position.z -
        headSin * 0.115 -
        headCos * 0.008,
    );
    // Continuous skin neck from the fabric collar into the jaw, including ADS
    // and the deeper crouch bend; no floating head or exposed joint socket.
    _v3a
      .set(0, 0.035, 0.004)
      .applyEuler(headPivot.rotation)
      .add(headPivot.position);
    _v3b.set(0, 0.489 - crouchAmt * 0.08, 0.025);
    neck.position.copy(_v3a).add(_v3b).multiplyScalar(0.5);
    _v3a.sub(_v3b);
    neck.scale.y = _v3a.length();
    neck.quaternion.setFromUnitVectors(_UP, _v3a.normalize());

    applyEmissive();
  }

  function setColor(hex) {
    if (disposed || typeof hex !== "number") return;
    try {
      matAccent.color.setHex(hex);
      baseGlow.setHex(hex).multiplyScalar(0.035);
      applyEmissive();
    } catch {}
  }

  function setHitFlash(m) {
    flashM = typeof m === "number" ? clamp01(m) : 0;
    if (!disposed) applyEmissive(); // 即时生效（不等到下一帧 applyPose）
  }

  function setVisible(b) {
    root.visible = !!b;
  }

  // 枪口世界位（供 remote-players 枪口闪/tracer 对位真枪节点；矩阵取上一帧
  // 渲染态，一帧灯光闪足够）。兜底枪/未挂枪时返回 null。
  function muzzleWorld(out) {
    if (disposed || !worldGun || !out) return null;
    try {
      var p = gun.localToWorld(
        out.set(
          worldGun.muzzle[0] - worldGun.grip[0],
          worldGun.muzzle[1] - worldGun.grip[1],
          worldGun.muzzle[2] - worldGun.grip[2],
        ),
      );
      return p;
    } catch (e) {
      return null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    var i;
    surfaces.dispose();
    if (worldGun) {
      try {
        worldGun.dispose(); // 引用计数；末位化身才真正释放共享枪资源
      } catch {}
      worldGun = null;
    }
    if (worldHands) {
      try {
        worldHands.dispose(); // 引用计数；末位化身才真正释放共享手套几何
      } catch {}
      worldHands = null;
    }
    for (i = 0; i < geos.length; i++) {
      try {
        geos[i].dispose();
      } catch {}
    }
    for (i = 0; i < ownedMats.length; i++) {
      try {
        ownedMats[i].dispose();
      } catch {}
    }
    geos.length = 0;
    ownedMats.length = 0;
    try {
      root.clear();
    } catch {}
  }

  // Establish a complete bind pose even when the first network sample is dead.
  applyPose({}, 1 / 60);

  return {
    root: root,
    applyPose: applyPose,
    setVisible: setVisible,
    setColor: setColor,
    setHitFlash: setHitFlash,
    muzzleWorld: muzzleWorld,
    dispose: dispose,
  };
}
