import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3,
  defineModuleExports,
} from "../vendor/three-r180.js";
import { createRandom } from "../core/random.js";
import { mergeGeometries } from "../core/geometry.js";
import { createDroneModel, createWalkerModel } from "./models.js";
import { WALKER_TUNING, createWalker } from "./walker.js";
import { DRONE_TUNING, createDrone } from "./drone.js";

var enemiesShowcaseModule = {};

defineModuleExports(enemiesShowcaseModule, {
  TUNE: () => ENEMY_TUNING,
  create: () => createEnemies,
  showcase: () => showcaseEnemies,
});

var ENEMY_TUNING = {
  gull: WALKER_TUNING,
  hound: DRONE_TUNING,
  sightRange: 45,
  sightCone: 200,
  loseSight: 4,
  searchTime: 8,
  hearRadius: 45,
  maxTokens: 2,
  maxTokensCrowd: 3,
  tokenGap: 1.25,
  exposureUp: 0.1,
  exposureDown: 0.45,
  poolGulls: 10,
  poolHounds: 8,
  maxWrecks: 5,
  maxBolts: 32,
};

var BC = Math.cos(((ENEMY_TUNING.sightCone / 2) * Math.PI) / 180);

var oM = new Vector3();

var pz = new Vector3();

var Qv = new Vector3();

var rM = new Quaternion();

var aM = new Matrix4();

var lM = new Vector3(1, 1, 1);

var OC = new Vector3(0, 0, 1);

var mz = new Vector3(0, -1, 0);

var cM = new Vector3();

var uM = new Vector3();

// 远端目标缺 vel 时的共享零向量（只读代理，walker 预瞄用）
var ZV = new Vector3();

async function createEnemies(context) {
  let e = createRandom(+((context.params && context.params.eseed) || 9001)),
    t = [],
    n = [],
    s = new Group();
  ((s.name = "enemies"), context.scene.add(s));
  let o = context.mats.emissive(16777215, 1),
    r = o && o.isMeshBasicMaterial ? o.clone() : new MeshBasicMaterial();
  (r.color.setRGB(1, 1, 1), (r.vertexColors = !0), (r.needsUpdate = !0));
  let a = context.mats.emissive(16752704, 6),
    l =
      a && a.isMeshBasicMaterial
        ? a
        : new MeshBasicMaterial({
            color: 16752704,
          }),
    c = o && o.toneMapped !== void 0 ? o.toneMapped : !0,
    u = {
      shell: context.mats.get("armor_white", {
        triplanar: !0,
        vertexColors: !0,
      }),
      metal: context.mats.get("gunmetal", {
        triplanar: !0,
        vertexColors: !0,
      }),
      glow: r,
      lensBase: l,
      disc: new MeshBasicMaterial({
        color: 789775,
        transparent: !0,
        opacity: 0.42,
        depthWrite: !1,
        side: DoubleSide,
        toneMapped: c,
      }),
      cone: new ShaderMaterial({
        uniforms: {
          uColor: {
            value: new Color(1, 0.9, 0.74),
          },
          uGain: {
            value: 0.085,
          },
        },
        vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          #include <beginnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
          vN = normalMatrix * objectNormal; vV = -mv.xyz; vT = 1.0 - uv.y;
          gl_Position = projectionMatrix * mv;
        }`,
        fragmentShader: `
        uniform vec3 uColor; uniform float uGain;
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = abs(dot(normalize(vN), normalize(vV)));
          f = f * f * (3.0 - 2.0 * f);
          float t = clamp(vT, 0.0, 1.0);
          float k = pow(1.0 - t, 1.7) * (0.35 + 0.65 * smoothstep(0.0, 0.06, t));
          gl_FragColor = vec4(uColor * (uGain * f * k), 1.0);
        }`,
        transparent: !0,
        blending: AdditiveBlending,
        depthWrite: !1,
        side: DoubleSide,
        fog: !1,
      }),
    },
    h = {
      G: context,
      rng: e,
      list: t,
      t: 0,
      playerSpeed: 0,
      tokens: 0,
      tokenT: -9,
      lastType: "",
      wantT: {
        gull: -9,
        hound: -9,
      },
      // ——— 多人 host/puppet 缝合状态（MP-CONTRACT §3 enemies 行 / BLUEPRINT R3）———
      targets: [],
      _wraps: new Map(),
      _localWrap: null,
      mergeSimple: (T) => mergeGeometries(T, !1),
      requestToken(T) {
        if (T.hasToken) return !0;
        let D = 0;
        for (let Q of t) Q.alive && D++;
        let C = D > 5 ? ENEMY_TUNING.maxTokensCrowd : ENEMY_TUNING.maxTokens,
          G = h.t - h.tokenT,
          j = T.type === "gull" ? "hound" : "gull",
          N =
            h.lastType === T.type &&
            h.t - h.wantT[j] < 0.5 &&
            G < ENEMY_TUNING.tokenGap * 2.2;
        return h.tokens >= C || G < ENEMY_TUNING.tokenGap || N
          ? ((h.wantT[T.type] = h.t), !1)
          : (h.tokens++,
            (h.tokenT = h.t),
            (h.lastType = T.type),
            (T.hasToken = !0),
            !0);
      },
      releaseToken(T) {
        T.hasToken &&
          ((T.hasToken = !1), (h.tokens = Math.max(0, h.tokens - 1)));
      },
      // ——— 联机状态与门（离线一律走原路径，单机零回归）———
      netMode() {
        let n = context.net;
        return !n || n.stub ? "offline" : n.mode || "offline";
      },
      // 房主权威模拟句柄：runtime 装配名未定（契约 §2.3 未指定 context 属性名），
      // 依次探测常见挂载点；认 onEnemyFire+onExplode 双签名防误认。
      sim() {
        if (h.netMode() !== "host") return null;
        let c = context,
          s =
            c.sim ||
            c.hostSim ||
            c.netSim ||
            (c.net && (c.net.sim || c.net.hostSim)) ||
            null;
        return s &&
          typeof s.onEnemyFire == "function" &&
          typeof s.onExplode == "function"
          ? s
          : null;
      },
      netPlayers() {
        let r = context.netPlayers || context.remotePlayers || null;
        return r && typeof r.list == "function" ? r : null;
      },
      // 本地玩家目标壳：getter 全部直读 context.player（位姿存活判定保持实时）
      localTarget() {
        let p = context.player;
        if (!p) return null;
        if (!h._localWrap || h._localWrap.src !== p)
          h._localWrap = {
            id: "local",
            isLocal: !0,
            src: p,
            get pos() {
              return this.src.pos;
            },
            get eye() {
              return this.src.eye || null;
            },
            get vel() {
              return this.src.vel || ZV;
            },
            get alive() {
              return this.src.alive !== !1 && !this.src.aboard;
            },
            damage(dmg, from) {
              // host 端本地玩家受击也走 sim 权威（cb.hitPlayer 全员可见）
              let sim = h.sim(),
                id =
                  context.net && context.net.selfId
                    ? context.net.selfId()
                    : null;
              if (sim && id != null) {
                try {
                  sim.onPlayerDamage(id, dmg, "melee");
                } catch {}
                return;
              }
              this.src.damage && this.src.damage(dmg, from);
            },
          };
        return h._localWrap;
      },
      // 远端玩家目标壳：pos 直读化身 live 向量；eye 每帧随 pos 刷新（config.js
      // PLAYER_DIMENSIONS：立姿 1.68 / 蹲姿 1.05）；受击走 sim.onPlayerDamage
      wrapRemote(r) {
        let w = h._wraps.get(r.id);
        if (!w) {
          w = {
            id: r.id,
            isLocal: !1,
            src: r,
            eye: new Vector3(),
            get pos() {
              return this.src.pos;
            },
            get vel() {
              return this.src.vel || ZV;
            },
            get alive() {
              return this.src.alive !== !1 && !this.src.aboard;
            },
            damage(dmg) {
              let sim = h.sim();
              if (sim && sim.onPlayerDamage) {
                try {
                  sim.onPlayerDamage(this.id, dmg, "melee");
                } catch {}
              }
            },
          };
          h._wraps.set(r.id, w);
        } else w.src = r;
        w.eye.set(r.pos.x, r.pos.y + (r.crouch ? 1.05 : 1.68), r.pos.z);
        return w;
      },
      // 每帧刷新目标表（仅 host；离线/客户端保持空表 → 各处回退 context.player）
      refreshTargets() {
        if (h.netMode() !== "host") {
          h.targets.length && (h.targets.length = 0);
          return;
        }
        h.targets.length = 0;
        let seen = new Set(),
          L = h.localTarget();
        L && h.targets.push(L);
        let np = h.netPlayers(),
          arr = null;
        if (np)
          try {
            arr = np.list();
          } catch {
            arr = null;
          }
        if (Array.isArray(arr))
          for (let k = 0; k < arr.length; k++) {
            let r = arr[k];
            if (!r || !r.pos || r.you || r.id == null) continue;
            seen.add(r.id);
            h.targets.push(h.wrapRemote(r));
          }
        for (let id of Array.from(h._wraps.keys()))
          seen.has(id) || h._wraps.delete(id);
      },
      // 感知目标解析（walker/drone 每帧取 b/D 用）：表空 → 裸 context.player
      // （离线与原版逐字节同路径）；表非空 → 按 T.tgt.id 取当前帧活引用，
      // 指定目标掉线/登船时退最近活体。
      target(T) {
        let list = h.targets;
        if (list.length) {
          if (T && T.tgt)
            for (let k = 0; k < list.length; k++)
              if (list[k].id === T.tgt.id) return list[k];
          let best = null,
            bd = 1 / 0;
          for (let k = 0; k < list.length; k++) {
            let G = list[k];
            if (!G || G.alive === !1) continue;
            let F = T ? G.pos.distanceToSquared(T.pos) : 0;
            F < bd && ((bd = F), (best = G));
          }
          return best || list[0];
        }
        return context.player;
      },
      // 联机客户端伤害门：敌人血量权威在房主（cb.hitEnemy 只表现），
      // 唯一放行 puppet.killLocal 的致死补刀（1e6 ≥ hp 恒真）
      gateDamage(en, amount) {
        if (h.netMode() !== "client") return !1;
        return !(typeof amount == "number" && amount >= en.hp);
      },
      // 敌射击统一入口（walker.js:570 / drone.js:763 源事件改走这里）：
      // host → sim.onEnemyFire 对全体玩家圆柱判定；否则原弹丸路径
      enemyFire(origin, dir, self) {
        let sim = h.sim();
        if (sim) {
          try {
            sim.onEnemyFire(origin, dir);
          } catch {}
          return;
        }
        h.fireBolt(origin, dir, self);
      },
      enemyShot(origin, dir, opts) {
        let sim = h.sim();
        if (sim) {
          try {
            return sim.onEnemyFire(origin, dir);
          } catch {
            return !1;
          }
        }
        let c = context.combat;
        return c && c.enemyShot ? c.enemyShot(origin, dir, opts || {}) : !1;
      },
      // gull 自爆（walker.js g() 末尾）：puppet/客户端纯视觉不结算；host 交
      // sim.onExplode 全员权威 AoE；离线走 combat.explode 原路径。
      // puppetMode 也算：断线回 offline 后木偶端依旧不得本地结算。
      explodeGate(pos, radius, dmg) {
        let mode = h.netMode();
        if (mode === "client" || U.puppetMode) return;
        let sim = mode === "host" ? h.sim() : null;
        if (sim) {
          try {
            sim.onExplode(pos, radius, dmg, "enemy");
          } catch {}
          return;
        }
        let c = context.combat;
        c && c.explode && c.explode(pos, radius, dmg, "enemy");
      },
      think(T, D, C) {
        if (T.passive) {
          T.los = !1;
          return;
        }
        let list = h.targets;
        if (!list.length && !context.player) {
          T.los = !1;
          return;
        }
        if (((T.senseT -= D), T.senseT <= 0)) {
          T.senseT = 0.11 + e() * 0.08;
          let src = list.length ? list : [h.localTarget()],
            best = null,
            bd = 1 / 0,
            near = null,
            nd = 1 / 0;
          for (let k = 0; k < src.length; k++) {
            let G = src[k];
            if (!G || G.alive === !1) continue;
            let N = G.eye || G.pos,
              Q = N.x - T.sensor.x,
              K = N.y - T.sensor.y,
              ie = N.z - T.sensor.z,
              F = Math.hypot(Q, K, ie);
            if (F < nd) ((nd = F), (near = G));
            if (F >= ENEMY_TUNING.sightRange || F >= bd) continue;
            let X = Math.hypot(Q, ie) || 1e-4,
              ne = (Q * T.fwd.x + ie * T.fwd.z) / X;
            (T.mode === "engage" || ne > BC || F < 3.5) &&
              context.physics.lineOfSight(T.sensor, N) &&
              ((bd = F), (best = G));
          }
          // R3 多目标：取最近可见者；无可见者盯最近活体（原目标倒下自动换靶）
          T.tgt = best || near || T.tgt || src[0];
          T.los = !!best;
        }
        let G = T.tgt || h.localTarget();
        if (!G) {
          T.los = !1;
          return;
        }
        (T.los
          ? ((T.seeT += D),
            (T.noSeeT = 0),
            T.lastKnown.copy(G.pos),
            (T.exposure = Math.min(
              1,
              T.exposure + D * ENEMY_TUNING.exposureUp,
            )))
          : ((T.noSeeT += D),
            (T.seeT = Math.max(0, T.seeT - D * 0.6)),
            (T.exposure = Math.max(
              0,
              T.exposure - D * ENEMY_TUNING.exposureDown,
            ))),
          T.mode === "engage"
            ? (T.noSeeT > ENEMY_TUNING.loseSight || G.alive === !1) &&
              ((T.mode = "search"),
              (T.modeT = ENEMY_TUNING.searchTime + e() * 3),
              h.releaseToken(T))
            : T.los && T.seeT > (T.mode === "patrol" ? C : C * 0.45)
              ? ((T.mode = "engage"),
                (T.noSeeT = 0),
                context.events.emit("enemy:alert", {
                  enemy: T,
                }),
                h.rally(T.pos, 18, G.pos, T))
              : T.mode !== "patrol" &&
                ((T.modeT -= D),
                T.modeT <= 0 &&
                  ((T.mode = "patrol"),
                  (T.home.x = T.pos.x),
                  (T.home.z = T.pos.z))));
      },
      rally(T, D, C, G) {
        for (let j of t)
          j === G ||
            !j.alive ||
            j.passive ||
            j.mode === "engage" ||
            j.pos.distanceToSquared(T) > D * D ||
            (j.lastKnown.copy(C),
            (j.mode = "investigate"),
            (j.modeT = 9 + e() * 4));
      },
      provoke(T) {
        let D = h.target(T) || context.player;
        !D ||
          T.passive ||
          !T.alive ||
          (T.mode !== "engage" &&
            (T.lastKnown.copy(D.pos),
            (T.mode = "investigate"),
            (T.modeT = 10),
            (T.seeT = 1),
            (T.senseT = 0)),
          h.rally(T.pos, 20, D.pos, T));
      },
      fireBolt(T, D, C) {
        let G = null;
        for (let j = 0; j < g.length; j++)
          if (!g[j].on) {
            G = g[j];
            break;
          }
        G &&
          ((G.on = !0),
          (G.life = 1.3),
          G.pos.copy(T),
          G.dir.copy(D),
          G.from.copy(T),
          (G.len = 0));
      },
      addWreck(T) {
        for (n.push(T); n.length > ENEMY_TUNING.maxWrecks;) {
          let D = n.shift();
          D.active && (D.sink = 0.001);
        }
      },
      retire(T) {
        T._deactivate();
        let D = t.indexOf(T);
        (D >= 0 && t.splice(D, 1),
          (D = n.indexOf(T)),
          D >= 0 && n.splice(D, 1));
        // R4：池腾位/坠毁/沉底的统一退场广播——host 侧 sim 据此发 ee.retire，
        // 清 nidMap 防池复用后幽灵木偶；_netId 随对象携带（spawn 时挂）。
        context.events.emit("enemy:retire", {
          enemy: T,
        });
      },
    },
    f = createDroneModel(),
    p = createWalkerModel(),
    d = [],
    v = [];
  for (let T = 0; T < ENEMY_TUNING.poolGulls; T++) {
    let D = createWalker(h, f, u, T);
    (d.push(D), s.add(D.rig.group));
  }
  for (let T = 0; T < ENEMY_TUNING.poolHounds; T++) {
    let D = createDrone(h, p, u, T);
    (v.push(D), s.add(D.rig.group));
  }
  let g = [];
  for (let T = 0; T < ENEMY_TUNING.maxBolts; T++)
    g.push({
      on: !1,
      life: 0,
      len: 0,
      pos: new Vector3(),
      dir: new Vector3(),
      from: new Vector3(),
    });
  let x = new CylinderGeometry(0.016, 0.03, 1, 6, 1);
  (x.rotateX(Math.PI / 2), x.translate(0, 0, -0.5));
  let y = context.mats.emissive(16738858, 14),
    b =
      y && y.isMeshBasicMaterial
        ? y
        : new MeshBasicMaterial({
            color: new Color(16738858).multiplyScalar(14),
          }),
    m = new InstancedMesh(x, b, ENEMY_TUNING.maxBolts);
  ((m.frustumCulled = !1),
    (m.castShadow = !1),
    (m.receiveShadow = !1),
    (m.count = 0),
    m.instanceMatrix.setUsage(DynamicDrawUsage),
    s.add(m));
  let A = {
    point: new Vector3(),
    normal: new Vector3(),
    dist: 0,
    surface: "concrete",
    enemy: null,
    part: null,
    dir: new Vector3(),
    from: "enemy",
  };
  function _(T) {
    let D = context.player,
      C = 0;
    for (let G = 0; G < g.length; G++) {
      let j = g[G];
      if (!j.on) continue;
      let N = ENEMY_TUNING.gull.boltSpeed * T;
      j.life -= T;
      let Q = context.physics.raycast(j.pos, j.dir, N),
        K = Q ? Q.dist : N,
        ie = !1;
      if (
        (D &&
          D.alive !== !1 &&
          (oM.copy(j.pos).addScaledVector(j.dir, K),
          cM.set(D.pos.x, D.pos.y + 0.35, D.pos.z),
          uM.set(D.pos.x, D.pos.y + (D.crouching ? 1 : 1.5), D.pos.z),
          HC(j.pos, oM, cM, uM) < 0.36 * 0.36 && (ie = !0)),
        ie)
      ) {
        (D.damage(ENEMY_TUNING.gull.boltDamage, j.from), (j.on = !1));
        continue;
      }
      if (Q) {
        (A.point.copy(Q.point),
          A.normal.copy(Q.normal),
          (A.dist = Q.dist),
          (A.surface = Q.surface),
          A.dir.copy(j.dir),
          context.events.emit("impact", A),
          (j.on = !1));
        continue;
      }
      if (j.life <= 0) {
        j.on = !1;
        continue;
      }
      (j.pos.addScaledVector(j.dir, N),
        (j.len = Math.min(1.5, j.len + N)),
        rM.setFromUnitVectors(OC, j.dir),
        lM.set(1, 1, Math.max(0.2, j.len)),
        aM.compose(j.pos, rM, lM),
        m.setMatrixAt(C++, aM));
    }
    (C || m.count) && ((m.count = C), (m.instanceMatrix.needsUpdate = !0));
  }
  let M = null,
    E = !1,
    w = 0,
    S = new Vector3(),
    z = 0;
  function H(T) {
    if (!E) {
      E = !0;
      try {
        M =
          context.render &&
          context.render.lightPool &&
          context.render.lightPool.acquire
            ? context.render.lightPool.acquire()
            : null;
      } catch {
        M = null;
      }
      M &&
        M.light &&
        (M.light.color.setRGB(1, 0.9, 0.75), (M.light.distance = 9));
    }
    if (!M || !M.light) return;
    let D = null,
      C = 3600,
      G = context.camera ? context.camera.position : null;
    for (let N of t) {
      if (N.type !== "gull" || !N.alive) continue;
      let Q = G ? N.pos.distanceToSquared(G) : 0;
      Q < C && ((C = Q), (D = N));
    }
    let j = 0;
    if (D) {
      if (((w -= T), w <= 0)) {
        w = 0.1;
        let N = D.yaw + D.gy,
          Q = Math.cos(D.gp);
        Qv.set(Math.sin(N) * Q, -Math.sin(D.gp), Math.cos(N) * Q).normalize();
        let K = context.physics.raycast(D.sensor, Qv, 14);
        (S.copy(D.sensor).addScaledVector(Qv, (K ? K.dist : 8) - 0.6),
          (z = K ? 1 : 0.3));
      }
      ((j = 26 * z), M.light.position.lerp(S, 1 - Math.exp(-12 * T)));
    }
    M.light.intensity += (j - M.light.intensity) * (1 - Math.exp(-8 * T));
  }
  let O = 1,
    q = 0,
    U = {
      list: t,
      TUNE: ENEMY_TUNING,
      // puppet 提线模式（puppet 模块置 true）：update 只跑姿态渲染半段
      puppetMode: !1,
      spawn(T, D, C = {}) {
        let G = T === "gull" ? d : T === "hound" ? v : null;
        if (!G) return null;
        let j = null;
        for (let N of G)
          if (!N.active) {
            j = N;
            break;
          }
        if (!j && T === "hound" && n.length) {
          let N = n[0];
          (h.retire(N), (j = N));
        }
        return j
          ? ((j.id = O++),
            (j._netId = j.id),
            t.push(j),
            j._activate(D, C),
            context.events.emit("enemy:spawn", {
              enemy: j,
            }),
            j)
          : null;
      },
      raycast(T, D, C = 300) {
        let G = null;
        for (let j = 0; j < t.length; j++) {
          let N = t[j];
          if (!N.alive) continue;
          let Q = N.pos.x - T.x,
            K = N.pos.y + (N.type === "hound" ? 0.6 : 0) - T.y,
            ie = N.pos.z - T.z,
            F = Q * D.x + K * D.y + ie * D.z;
          F < -1.5 ||
            F > C + 1.5 ||
            Q * Q + K * K + ie * ie - F * F > 1.7 ||
            (G ||
              (G = {
                dist: 1 / 0,
                point: new Vector3(),
                normal: new Vector3(),
                enemy: null,
                part: "body",
              }),
            N._raycast(T, D, C, G));
        }
        return G && G.enemy ? G : null;
      },
      aliveCount() {
        let T = 0;
        for (let D of t) D.alive && T++;
        return T;
      },
      clear() {
        for (let T of d) T.active && T._deactivate();
        for (let T of v) T.active && T._deactivate();
        ((t.length = 0), (n.length = 0), (h.tokens = 0));
        for (let T of g) T.on = !1;
        ((m.count = 0), M && M.light && (M.light.intensity = 0));
      },
      alert(T, D = 40) {
        for (let C of t)
          !C.alive ||
            C.passive ||
            C.mode === "engage" ||
            C.pos.distanceToSquared(T) > D * D ||
            (C.lastKnown.copy(T),
            (C.lastKnown.y = Math.max(0, T.y - 1.6)),
            C.mode === "patrol" &&
              context.events.emit("enemy:alert", {
                enemy: C,
                noise: !0,
              }),
            (C.mode = "investigate"),
            (C.modeT = 9 + e() * 4));
      },
      update(T) {
        if (T <= 0) return;
        (T > 0.05 && (T = 0.05), (h.t += T), (q -= T));
        if (U.puppetMode) {
          // puppet 分支（契约 §3 / 蓝图 ④ enemies.js:522 缝合点）：快照已直写
          // 位姿——跳过 think/导航/弹丸推进/伤害，只跑姿态与渲染半段
          //（walker.js xp / drone.js Sp；死亡动画照常本地自跑）。探照灯 H()
          // 纯装饰照常；弹丸 InstancedMesh 残留计数清零。
          for (let D = t.length - 1; D >= 0; D--) {
            let C = t[D];
            C._pose ? C._pose(T) : C._update(T);
          }
          m.count && (m.count = 0);
          H(T);
          return;
        }
        let D = context.player;
        if (D) {
          let C = D.vel ? Math.hypot(D.vel.x, D.vel.z) : D.speed || 0;
          h.playerSpeed += (C - h.playerSpeed) * (1 - Math.exp(-6 * T));
        }
        h.refreshTargets();
        for (let C = t.length - 1; C >= 0; C--) t[C]._update(T);
        (_(T), H(T));
      },
      debug: {
        ctx: h,
        gulls: d,
        hounds: v,
        wrecks: n,
        bolts: g,
        mats: u,
        tris: {
          gull: f.tris + f.extra.tris,
          hound: p.tris,
        },
      },
    };
  return (
    context.events.on("weapon:fire", (T) => {
      if (q > 0) return;
      q = 0.3;
      // 联机客户端：枪声警觉由房主统一裁定（本端开火已由 net 事件桥上报），本地不扩散
      if (h.netMode() === "client") return;
      let D =
        (T && (T.origin || T.muzzle)) || (context.player && context.player.pos);
      D && U.alert(D, ENEMY_TUNING.hearRadius);
    }),
    context.events.on("explosion", (T) => {
      if (h.netMode() === "client") return;
      T && T.pos && U.alert(T.pos, 30);
    }),
    context.events.on("game:state", (T) => {
      if (!T || T.state !== "title") return;
      // clear host 化：房主侧经 sim.onClear 广播 ee.clear 并清 nidMap（内部会回调
      // U.clear，幂等）；离线/客户端走本地清场
      let sim = h.sim();
      sim && sim.onClear ? sim.onClear() : U.clear();
    }),
    U
  );
}

var o0 = new Vector3();

var r0 = new Vector3();

var a0 = new Vector3();

function HC(i, e, t, n) {
  (o0.copy(e).sub(i), r0.copy(n).sub(t), a0.copy(i).sub(t));
  let s = o0.dot(o0),
    o = r0.dot(r0),
    r = r0.dot(a0),
    a,
    l;
  if (s <= 1e-9 && o <= 1e-9) return a0.dot(a0);
  if (s <= 1e-9) ((a = 0), (l = Math.min(1, Math.max(0, r / o))));
  else {
    let f = o0.dot(a0);
    if (o <= 1e-9) ((l = 0), (a = Math.min(1, Math.max(0, -f / s))));
    else {
      let p = o0.dot(r0),
        d = s * o - p * p;
      ((a = d > 1e-9 ? Math.min(1, Math.max(0, (p * r - f * o) / d)) : 0),
        (l = (p * a + r) / o),
        l < 0
          ? ((l = 0), (a = Math.min(1, Math.max(0, -f / s))))
          : l > 1 && ((l = 1), (a = Math.min(1, Math.max(0, (p - f) / s)))));
    }
  }
  let c = a0.x + o0.x * a - r0.x * l,
    u = a0.y + o0.y * a - r0.y * l,
    h = a0.z + o0.z * a - r0.z * l;
  return c * c + u * u + h * h;
}

async function showcaseEnemies(context) {
  let e = await createEnemies(context);
  context.enemies = e;
  let t = (l, c, u) => new Vector3(l, c, u),
    n = context.params.eshow || "both",
    s = [3, 1.45, 3.9],
    o = [0.5, 0.95, 0],
    r = 2.6;
  if (n === "gull")
    (e.spawn("gull", t(0, 1.6, 0), {
      passive: !0,
      hover: 1.6,
      patrolRadius: 0.02,
      yaw: 0.7,
    }),
      (s = [1.25, 1.95, 1.45]),
      (o = [0, 1.52, 0]),
      (r = 1.2));
  else if (n === "hound")
    (e.spawn("hound", t(0, 0, 0), {
      passive: !0,
      yaw: 0.9,
      patrolLine: [t(1.6, 0, 1.3), t(-1.6, 0, -1.3)],
    }),
      (s = [2.1, 1, 2.3]),
      (o = [0.5, 0.62, 0.4]),
      (r = 1.25));
  else if (n === "fight")
    (e.spawn("hound", t(-7, 0, -9), {
      state: "alert",
    }),
      e.spawn("hound", t(8, 0, -7), {
        state: "alert",
      }),
      e.spawn("hound", t(0, 0, -14), {
        state: "alert",
      }),
      e.spawn("gull", t(-5, 6, -13), {
        state: "alert",
      }),
      e.spawn("gull", t(9, 6, -11), {
        state: "alert",
      }),
      (s = [5, 2.6, 10]),
      (o = [0, 2.2, -5]),
      (r = 7));
  else if (n === "dead") {
    let l = e.spawn("hound", t(0, 0, 0), {
        passive: !0,
        yaw: 0.8,
      }),
      c = e.spawn("gull", t(-1.6, 3.4, -0.5), {
        passive: !0,
        hover: 3.4,
        patrolRadius: 0.02,
      });
    e.spawn("hound", t(2.2, 0, -1.6), {
      passive: !0,
      yaw: -0.6,
      patrolLine: [t(2.2, 0, -1.6), t(3.4, 0, -3)],
    });
    for (let u = 0; u < 30; u++) e.update(1 / 60);
    l.damage(999, l.pos, t(0.6, 0, -0.8), "body");
    for (let u = 0; u < 110; u++) e.update(1 / 60);
    (c.damage(999, c.pos, t(0, 0, 1), "body"),
      (s = [2.6, 1.3, 3.2]),
      (o = [0, 0.5, 0]),
      (r = 0.42));
  } else
    (e.spawn("gull", t(-0.9, 2.2, -0.2), {
      passive: !0,
      hover: 2.2,
      patrolRadius: 0.25,
      yaw: 0.5,
    }),
      e.spawn("hound", t(0.2, 0, 0.6), {
        passive: !0,
        yaw: 1.2,
        patrolLine: [t(2.6, 0, 1.2), t(-1.8, 0, 0.2)],
      }));
  context.params.epre != null && (r = +context.params.epre);
  for (let l = 0, c = Math.round(r * 60); l < c; l++) e.update(1 / 60);
  let a = !!context.params.efreeze;
  return {
    cam: s,
    target: o,
    update(l) {
      a || e.update(l);
    },
  };
}

export { createEnemies, enemiesShowcaseModule, showcaseEnemies, ENEMY_TUNING };
