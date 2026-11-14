#!/usr/bin/env node
// scripts/test-background-tick.mjs — BACKGROUND-TICK 无头断言（联网后台保活）
// 覆盖：
//   ① step(dt,{render}) 重构后可见路径调用序与原版逐字一致（spy 序列，含
//     wetness/fx..mats/cameraOverride/bench/render.frame/endFrame 全链与
//     __frames/__ready 测试钩子、bench 收原始 dt 的原语义）
//   ② render:false 降级路径跳过纯视觉系统（wetness/fx/ground/level/backdrop/
//     mats/hud/cameraOverride/bench/render.frame/__frames），保留模拟链
//     （input/net/mpFrameTick/game/player/weapon/enemies/audio/endFrame）
//   ③ 原有门语义不变：paused 跳 player/fx 族、params.dt 覆盖、game.update
//     抛错不崩且逐系统 try/catch 保留
//   ④ bgTickMessage 双驱动防御：可见时拒、离线时拒；隐藏+联网驱动且
//     dt 用 performance 差分钳 20-100ms；step 抛错不外溢
//   ⑤ bgTickStart：离线/可见不建 Worker、隐藏+联网建一次（幂等）、创建失败
//     不重试；bgTickStop 发 stop + terminate 且幂等
//   ⑥ tick-worker.js 真源码执行：start→15ms 心跳（幂等）、stop→清除（幂等）、
//     可重启
//   ⑦ runtime.js 接线断言：Worker 走 new URL+module、visibilitychange 换向、
//     起播即后台的兜底启动
// 方法：@babel/parser 从 src/app/runtime.js 按名抽取 step/updateSystem/
//   bgTickMessage/bgTickStart/bgTickStop 的真源码，new Function 注入自由变量
//   求值——被测对象即生产代码本体，零拷贝漂移。
// 运行：node scripts/test-background-tick.mjs（退出码 0/1）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default ?? traverseModule;
const RUNTIME_PATH = fileURLToPath(
  new URL("../src/app/runtime.js", import.meta.url),
);
const WORKER_PATH = fileURLToPath(
  new URL("../src/app/tick-worker.js", import.meta.url),
);
const runtimeSrc = readFileSync(RUNTIME_PATH, "utf8").replace(/\r\n/g, "\n");
const workerSrc = readFileSync(WORKER_PATH, "utf8");

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seqEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ———— 生产源码抽取 ————
const ast = parse(runtimeSrc, { sourceType: "module" });
function extractNode(name) {
  let hit = null;
  traverse(ast, {
    VariableDeclarator(p) {
      if (hit || !p.node.init) return;
      p.node.id.type === "Identifier" &&
        p.node.id.name === name &&
        (hit = p.node.init);
    },
    FunctionDeclaration(p) {
      if (hit) return;
      p.node.id &&
        p.node.id.name === name &&
        (hit = p.node);
    },
  });
  if (!hit) throw new Error(`runtime.js 中未找到 ${name}`);
  return hit;
}
function compile(node, sandbox) {
  const text = runtimeSrc.slice(node.start, node.end);
  const keys = Object.keys(sandbox);
  return new Function(...keys, `return (${text})`)(
    ...keys.map((k) => sandbox[k]),
  );
}

// ———— mock 语境 ————
const errors = [];
const fakeConsole = {
  error: (...a) => errors.push(a.join(" ")),
  info: () => {},
  log: () => {},
};
const sharedErr = {};

function buildMockContext(order, lastDt) {
  const sys = (name) => ({
    update: (dt) => {
      order.push(name);
      lastDt[name] = dt;
    },
  });
  return {
    time: { t: 0, dt: 0, frame: 0, real: 0 },
    input: {
      ...sys("input"),
      endFrame: () => order.push("endFrame"),
    },
    net: sys("net"),
    game: {
      state: "playing",
      update: (dt) => {
        order.push("game");
        lastDt.game = dt;
        return !0;
      },
    },
    player: sys("player"),
    weapon: {
      ...sys("weapon"),
      setWetness: () => order.push("wetness"),
    },
    enemies: sys("enemies"),
    fx: sys("fx"),
    ground: sys("ground"),
    level: {
      ...sys("level"),
      interiorBoxes: [{ min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 5, z: 10 } }],
    },
    backdrop: sys("backdrop"),
    mats: sys("mats"),
    audio: sys("audio"),
    hud: sys("hud"),
    render: { frame: () => order.push("render.frame") },
    camera: {
      position: { x: 0, y: 1, z: 0, copy: () => order.push("camOverride") },
      lookAt: () => {},
    },
    bench: { frame: (x) => ((order.push("bench"), (benchRaw = x))) },
    showcaseInfo: {},
  };
}
let benchRaw = null;

let order = [],
  lastDt = {},
  mockWindow = { __frames: 0 },
  perfNow = 1234,
  cameraOverride = { pos: {}, look: {} },
  mpOrder = [];
const mockContext = buildMockContext(order, lastDt);

const updateSystemFn = compile(extractNode("updateSystem"), {
  context: mockContext,
  console: fakeConsole,
  updateSystem: { err: sharedErr }, // 体内自引用仅触 .err 门（生产为闭包自绑定）
});
updateSystemFn.err = sharedErr;

const stepFn = compile(extractNode("step"), {
  context: mockContext,
  params: {},
  showcaseName: null,
  updateSystem: updateSystemFn,
  mpFrameTick: (p) => {
    mpOrder.push(p);
    order.push("mpFrameTick");
  },
  cameraOverride,
  weaponWetness: 1,
  window: mockWindow,
  performance: { now: () => perfNow },
  console: fakeConsole,
});

// ① 可见路径调用序与原版一致（原 runtime.js :681-755 逐项转写）
const ORIG_ORDER = [
  "input", // :681
  "net", // :684
  "mpFrameTick", // :685
  "game", // :689
  "player", // :710
  "weapon", // :711
  "enemies", // :712
  "wetness", // :713-732（interiorBoxes 命中时）
  "fx", // :735
  "ground", // :736
  "level", // :737
  "backdrop", // :738
  "mats", // :739
  "audio", // :740
  "hud", // :741
  "camOverride", // :742-744（cameraOverride 非空时）
  "bench", // :745
  "render.frame", // :747
  "endFrame", // :753
];
order.length = 0;
stepFn(0.016, { render: !0, rawDt: 0.5, now: 1234 });
ok(seqEq(order, ORIG_ORDER), `① 可见路径调用序与原版一致（${order.length} 项）`);
ok(mockContext.time.dt === 0.016 && mockContext.time.t === 0.016 &&
  mockContext.time.frame === 1 && mockContext.time.real === 1.234,
  "① 时间簿记 dt/t/frame/real 与原版口径一致");
ok(benchRaw === 0.5, "① bench 收原始帧差（非钳位 dt），原语义保留");
ok(mockWindow.__frames === 1 && mockWindow.__ready === undefined,
  "① __frames 递增、未到 2 不置 __ready");
stepFn(0.016, { render: !0, rawDt: 0.016, now: 1250 });
ok(mockWindow.__frames === 2 && mockWindow.__ready === !0,
  "① 第 2 渲染帧置 __ready（测试钩子原语义）");

// ② 降级路径：跳渲染类、保模拟类
order.length = 0;
const framesBefore = mockWindow.__frames;
stepFn(0.02, { render: !1, now: 1266 });
ok(seqEq(order, [
  "input", "net", "mpFrameTick", "game", "player", "weapon", "enemies",
  "audio", "endFrame",
]), "② render:false 跳过 wetness/fx/ground/level/backdrop/mats/hud/camOverride/bench/render.frame");
ok(mockWindow.__frames === framesBefore,
  "② 降级帧不计 __frames（渲染帧语义）");
ok(mockContext.time.frame === 3 && mockContext.time.real === 1.266,
  "② 降级帧时间簿记照常推进");
ok(mpOrder.length === 3 && mpOrder[2] === 0.02,
  "② mpFrameTick（host-sim/remote-players 插值节拍）在降级帧照常消费 dt");

// ③ 原有门语义保留
order.length = 0;
mockContext.game.state = "paused";
stepFn(0.016, { render: !0, rawDt: 0.016, now: 1282 });
ok(seqEq(order, [
  "input", "net", "mpFrameTick", "game", "wetness", "audio", "hud",
  "camOverride", "bench", "render.frame", "endFrame",
]), "③ paused：player/weapon/enemies/fx 族照旧跳过，audio/hud/render/endFrame 照旧运行");
mockContext.game.state = "playing";
// params.dt 覆盖（生产在 step 内读 params 表）——重新编译注入
const stepDt = compile(extractNode("step"), {
  context: mockContext,
  params: { dt: "0.033" },
  showcaseName: null,
  updateSystem: updateSystemFn,
  mpFrameTick: () => {},
  cameraOverride: null,
  weaponWetness: 1,
  window: { __frames: 0 },
  performance: { now: () => 0 },
  console: fakeConsole,
});
order.length = 0;
stepDt(0.05, { render: !1, now: 1300 });
ok(lastDt.player === 0.033 && mockContext.time.dt === 0.033,
  "③ params.dt 覆盖原语义保留（模拟系统收覆盖值）");
mockContext.game.update = () => {
  throw new Error("boom");
};
order.length = 0;
let threw = !1;
try {
  stepFn(0.016, { render: !0, rawDt: 0.016, now: 1316 });
} catch {
  threw = !0;
}
ok(!threw && order.includes("audio") && order.includes("render.frame") &&
  order.includes("endFrame"),
  "③ game.update 抛错不崩：后续系统照跑（per-system try/catch 保留）");
mockContext.game.update = () => {
  order.push("game");
  return !0;
};
stepFn(0.016, { render: !0, rawDt: 0.016, now: 1332 });
ok(errors.length === 1, "③ game.update 错误只记一次（err 门保留）");

// ———— bgTickMessage：双驱动防御 + dt 钳位 ————
let docHidden = !1,
  netActive = !1,
  tickPerfNow = 0,
  tickCalls = [];
const bgTickState = { worker: null, last: 0, failed: !1 };
const bgTickMessage = compile(extractNode("bgTickMessage"), {
  document: { get hidden() { return docHidden; } },
  mpNetActive: () => netActive,
  performance: { now: () => tickPerfNow },
  bgTick: bgTickState,
  step: (dt, opts) => tickCalls.push({ dt, opts }),
  updateSystem: { err: sharedErr },
  console: fakeConsole,
});
docHidden = !1, netActive = !0, tickPerfNow = 5000;
bgTickMessage();
ok(tickCalls.length === 0, "④ worker tick 在可见时被拒（双驱动防御）");
docHidden = !0, netActive = !1;
bgTickMessage();
ok(tickCalls.length === 0, "④ worker tick 在离线时被拒（离线不启用）");
docHidden = !0, netActive = !0;
bgTickState.last = 1000, tickPerfNow = 1005;
bgTickMessage();
ok(tickCalls.length === 1 && tickCalls[0].dt === 0.02 &&
  tickCalls[0].opts.render === !1 && tickCalls[0].opts.now === 1005 &&
  bgTickState.last === 1005,
  "④ 隐藏+联网：以 render:false 驱动，dt 差分 5ms 下钳到 20ms");
bgTickState.last = 1000, tickPerfNow = 9000;
bgTickMessage();
ok(tickCalls[tickCalls.length - 1].dt === 0.1,
  "④ dt 差分 8000ms 上钳到 100ms");
bgTickState.last = 1000, tickPerfNow = 1010;
let swallow = !1;
const throwingStep = compile(extractNode("bgTickMessage"), {
  document: { hidden: !0 },
  mpNetActive: () => !0,
  performance: { now: () => 1010 },
  bgTick: { worker: null, last: 1000, failed: !1 },
  step: () => {
    throw new Error("step boom");
  },
  updateSystem: { err: {} },
  console: fakeConsole,
});
try {
  throwingStep();
} catch {
  swallow = !0;
}
ok(!swallow, "④ step 抛错不外溢（后台帧 try/catch 兜底）");

// ———— bgTickStart / bgTickStop ————
let createCount = 0,
  createResult = null;
function makeFakeWorker() {
  return {
    posted: [],
    terminated: !1,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      this.posted.push(m);
    },
    terminate() {
      this.terminated = !0;
    },
  };
}
const startDoc = { get hidden() { return docHidden; } };
let startPerfNow = 777;
const bgTickStart = compile(extractNode("bgTickStart"), {
  bgTick: bgTickState,
  document: startDoc,
  mpNetActive: () => netActive,
  bgCreateWorker: () => ((createCount++), createResult),
  performance: { now: () => startPerfNow },
  console: fakeConsole,
  bgTickStop: () => {},
  bgTickMessage: bgTickMessage,
});
const bgTickStop = compile(extractNode("bgTickStop"), {
  bgTick: bgTickState,
  console: fakeConsole,
});
docHidden = !0, netActive = !1;
bgTickStart();
ok(createCount === 0 && bgTickState.worker === null,
  "⑤ 离线：不创建 Worker（单机后台暂停为预期行为）");
netActive = !0, docHidden = !1;
bgTickStart();
ok(createCount === 0, "⑤ 可见：不创建 Worker（rAF 主场）");
docHidden = !0;
createResult = makeFakeWorker();
bgTickStart();
ok(createCount === 1 && bgTickState.worker === createResult &&
  createResult.posted.join() === "start" &&
  typeof createResult.onmessage === "function" &&
  bgTickState.last === startPerfNow,
  "⑤ 隐藏+联网：创建 Worker 并发 start、挂消息处理、落 performance 基准");
bgTickStart();
ok(createCount === 1 && createResult.posted.length === 1,
  "⑤ 已在跑：幂等不重复创建/重复 start");
bgTickStop();
ok(createResult.posted.join() === "start,stop" && createResult.terminated &&
  bgTickState.worker === null,
  "⑤ bgTickStop：发 stop + terminate + 置空引用");
bgTickStop();
ok(createResult.posted.length === 2, "⑤ bgTickStop 幂等（空态再停无副作用）");
const failedState = { worker: null, last: 0, failed: !1 };
let failCount = 0;
const failStart = compile(extractNode("bgTickStart"), {
  bgTick: failedState,
  document: { hidden: !0 },
  mpNetActive: () => !0,
  bgCreateWorker: () => (failCount++, null), // file:// 或 CSP 下创建失败
  performance: { now: () => 0 },
  console: fakeConsole,
  bgTickStop: () => {},
  bgTickMessage: () => {},
});
failStart();
failStart();
ok(failedState.failed === !0 && failCount === 1,
  "⑤ Worker 创建失败：标记 failed 且不再重试（静默维持现状冻结）");

// ———— tick-worker.js 真源码：start/stop 协议 ————
let intervalCreated = 0,
  intervalCleared = 0,
  workerTicks = 0;
const workerSelf = { onmessage: null };
new Function(
  "self",
  "postMessage",
  "setInterval",
  "clearInterval",
  workerSrc,
)(workerSelf,
  (m) => {
    m === "tick" && workerTicks++;
  },
  (fn, ms) => (intervalCreated++, setInterval(fn, ms)),
  (id) => (intervalCleared++, clearInterval(id)),
);
const post = (m) => workerSelf.onmessage({ data: m });
ok(intervalCreated === 0 && workerSelf.onmessage !== null,
  "⑥ worker 源码已装载：静默待命（无定时器、已挂 onmessage）");
post("start");
post("start");
ok(intervalCreated === 1, "⑥ start 建立单个 15ms 心跳（重复 start 幂等）");
await sleep(100);
const ticksAfterStart = workerTicks;
ok(ticksAfterStart >= 3, `⑥ 心跳运行（100ms 内 ${ticksAfterStart} 条 tick）`);
post("stop");
await sleep(60);
const ticksAfterStop = workerTicks;
post("stop");
await sleep(40);
ok(workerTicks === ticksAfterStop && intervalCleared === 1,
  "⑥ stop 清除心跳（重复 stop 幂等、tick 归零）");
post("start");
await sleep(50);
ok(intervalCreated === 2 && workerTicks > ticksAfterStop,
  "⑥ stop 后可重新 start（再次隐藏的场景）");

// ———— runtime.js 接线断言（抽取执行覆盖不到的 import.meta/Worker 行）———
ok(runtimeSrc.includes(
  'new Worker(new URL("./tick-worker.js", import.meta.url), {\n        type: "module",\n      })',
), "⑦ runtime 接线：Worker 走 new URL + type:module（vite 打包独立 chunk）");
ok(/document\.addEventListener\("visibilitychange", \(\) => \{\n    document\.hidden \? bgTickStart\(\) : bgTickStop\(\);\n  \}\)/
  .test(runtimeSrc), "⑦ runtime 接线：visibilitychange 换向（隐启/显停）");
ok(runtimeSrc.includes("document.hidden && bgTickStart()"),
  "⑦ runtime 接线：起播即后台的兜底启动");
ok(runtimeSrc.includes("step(Math.min(f, 0.05), { render: !0, rawDt: f, now: h })"),
  "⑦ rAF 主路恒走 render:true（可见时永远全跑）");

console.log(`PASS: test-background-tick ${passed.length} 项断言全绿`);
process.exit(0);
