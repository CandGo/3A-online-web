#!/usr/bin/env node
// scripts/test-ui-s11s12.mjs — §11+§12 UI 车道自测（menus.js / hud.js，无浏览器）
// 覆盖：§11 罗盘威胁标（敌我过滤/自己静默/队伍未知静默/距离米数/1.8s 线性渐隐/
// 续射刷新/过期摘除/黑板 pvpLastFire 兜底）、受击方向扇形（方位角计算/多方向叠加
// 上限 3/1.2s 衰减/合作房门）；§12 自动发现（扫描入口参数/扫描中态/结果列表渲染/
// 模式徽章/人数/房主名/私密灰态/点公开房直连 joinRoom/零结果提示/网段推断失败
// 手输路径/关弹层作废在途扫描）。
// 手法：极简 DOM 桩（与 test-pvp10-ui.mjs 同款），真实 import src/ui/menus.js 与
// src/ui/hud.js 跑逻辑——不改产品代码一行。

import { createMenus } from "../src/ui/menus.js";
import { createHUD } from "../src/ui/hud.js";

// ---------------- 极简 DOM 桩 ----------------
const VOID = new Set(["input", "br", "hr", "img", "source", "meta", "link"]);

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this._cls = new Set();
    this.style = {};
    this.hidden = false;
    this._text = "";
    this.value = "";
    this.disabled = false;
    this.parentNode = null;
    this._listeners = {};
  }
  get className() {
    return [...this._cls].join(" ");
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    const el = this;
    return {
      add: (...c) => c.forEach((x) => el._cls.add(x)),
      remove: (...c) => c.forEach((x) => el._cls.delete(x)),
      toggle(c, f) {
        if (f === undefined) f = !el._cls.has(c);
        f ? el._cls.add(c) : el._cls.delete(c);
        return f;
      },
      contains: (c) => el._cls.has(c),
    };
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children.length = 0;
    this._text = v == null ? "" : String(v);
  }
  set innerHTML(v) {
    this.children.length = 0;
    this._text = "";
    const r = parseHTML(String(v));
    this._text = r._text;
    r.children.forEach((c) => this.appendChild(c));
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "class") this.className = String(v);
    if (k === "hidden") this.hidden = true;
    if (k.startsWith("data-")) {
      const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[dk] = String(v);
    }
  }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k === "hidden") this.hidden = false;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  appendChild(n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  append(...ns) {
    ns.forEach((n) => this.appendChild(n));
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  addEventListener(t, fn) {
    (this._listeners[t] || (this._listeners[t] = [])).push(fn);
  }
  dispatch(t, ev) {
    (this._listeners[t] || []).slice().forEach((fn) => fn(ev || {}));
  }
  focus() {}
  blur() {}
  contains(n) {
    for (let c of this.children) if (c === n || c.contains(n)) return true;
    return false;
  }
  closest(sel) {
    let el = this;
    while (el) {
      if (matchSimple(el, sel.split(/\s+/).pop())) return el;
      el = el.parentNode;
    }
    return null;
  }
  querySelector(sel) {
    return queryAll(this, sel)[0] || null;
  }
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
  }
  get offsetParent() {
    return this.hidden ? null : { tag: "stub" };
  }
  get clientWidth() {
    return undefined;
  }
}

function unescapeText(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function parseHTML(html) {
  const root = new El("div");
  const stack = [root];
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m, last = 0;
  while ((m = tagRe.exec(html))) {
    const chunk = html.slice(last, m.index);
    if (chunk.trim()) stack[stack.length - 1]._text += unescapeText(chunk);
    last = tagRe.lastIndex;
    const [full, name, attrs = "", selfClose] = m;
    if (full.startsWith("</")) {
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i].tagName === name.toUpperCase()) {
          stack.length = i;
          break;
        }
      continue;
    }
    const el = new El(name);
    const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrs))) {
      const val = am[2] ?? am[3] ?? am[4] ?? "";
      el.setAttribute(am[1], val);
    }
    stack[stack.length - 1].appendChild(el);
    if (!(selfClose || VOID.has(name.toLowerCase()))) stack.push(el);
  }
  const tail = html.slice(last);
  if (tail.trim()) stack[stack.length - 1]._text += unescapeText(tail);
  return root;
}

function matchSimple(el, sel) {
  const toks = sel.match(/[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || [];
  for (let t of toks) {
    if (t[0] === ".") {
      if (!el._cls.has(t.slice(1))) return false;
    } else if (t[0] === "#") {
      if (el.attrs.id !== t.slice(1)) return false;
    } else if (t[0] === "[") {
      const am = /^\[([\w-]+)(?:\*?=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(t);
      if (!am) return false;
      const want = am[2] ?? am[3] ?? am[4];
      if (am[1] === "hidden" ? el.hidden !== true : !(am[1] in el.attrs)) return false;
      if (want !== undefined && el.attrs[am[1]] !== want) return false;
    } else {
      if (el.tagName !== t.toUpperCase()) return false;
    }
  }
  return toks.length > 0;
}
function queryAll(root, sel) {
  const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  const walk = (el, sels) => {
    for (const c of el.children) {
      if (matchSimple(c, sels[sels.length - 1])) {
        let ok = true, node = c.parentNode, si = sels.length - 2;
        while (si >= 0 && node) {
          if (matchSimple(node, sels[si])) si--;
          node = node.parentNode;
        }
        ok = si < 0;
        if (ok) out.push(c);
      }
      walk(c, sels);
    }
  };
  for (const p of parts) {
    const sels = p.split(/\s+/).filter(Boolean);
    walk(root, sels);
  }
  return out;
}

// ---------------- 全局环境 ----------------
const UI = new El("div");
UI.setAttribute("id", "ui");
globalThis.document = {
  getElementById: (id) => (id === "ui" ? UI : null),
  createElement: (t) => new El(t),
  addEventListener: () => {},
  body: new El("body"),
  activeElement: null,
  fullscreenElement: null,
};
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

function makeEvents() {
  const m = new Map();
  return {
    on(t, f) {
      const l = m.get(t) || [];
      l.push(f);
      m.set(t, l);
      return () => {};
    },
    emit(t, ev) {
      (m.get(t) || []).slice().forEach((f) => f(ev));
    },
  };
}
function makeNet(over = {}) {
  const handlers = new Map();
  const base = {
    stub: false,
    mode: "offline",
    roomMode: () => "coop",
    selfId: () => "me1",
    isHost: () => false,
    roomCode: () => "ABCD",
    players: () => [],
    latency: () => 12,
    on(t, f) {
      const l = handlers.get(t) || [];
      l.push(f);
      handlers.set(t, l);
      return () => {};
    },
    off() {},
    client: { onHostPayload() { return () => {}; }, send: () => true },
    host: { onClientPayload() { return () => {}; }, broadcast: () => true },
    _handlers: handlers,
    _emit(t, ev) {
      (handlers.get(t) || []).slice().forEach((f) => f(ev));
    },
  };
  return Object.assign(base, over);
}
function makeContext(net) {
  return {
    events: makeEvents(),
    net,
    input: { touch: false },
    params: {},
    audio: null,
    player: null,
    render: null,
    quality: null,
    remotePlayers: null,
    time: { real: 100, frame: 3, t: 100 },
    game: { menus: { panelOpen: false }, run: { board: [] } },
  };
}
function freshUI() {
  UI.children.length = 0;
  UI._text = "";
  return UI;
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 10));

const passed = [];
function ok(cond, label) {
  if (!cond) throw new Error("断言失败: " + label);
  passed.push(label);
}

function click(menusRoot, el) {
  menusRoot.dispatch("click", { target: el });
}
function byAct(root, act) {
  return root.querySelectorAll(`[data-act="${act}"]`)[0] || null;
}

async function main() {
  // ================= 场景 1：§12 自动发现——扫描入口 / 结果列表 / 灰态 / 直连 =================
  {
    freshUI();
    const scanCalls = [];
    const joined = [];
    const pub = {
      ip: "192.168.1.10",
      info: {
        code: "WXYZ",
        mode: "pvp",
        visibility: "public",
        phase: "lobby",
        players: 2,
        host: "房主甲",
        names: ["房主甲", "乙"],
      },
    };
    const priv = {
      ip: "192.168.1.11",
      info: { visible: false, mode: "coop", phase: "lobby", n: 3 },
    };
    const net = makeNet({
      joinRoom(code, name) {
        joined.push(["net", code, name]);
        return new Promise(() => {});
      },
      getLocalSubnet() {
        return Promise.resolve("192.168.1");
      },
      scanLan(opts) {
        scanCalls.push({
          port: opts && opts.port,
          timeoutMs: opts && opts.timeoutMs,
          subnet: opts && opts.subnet,
          onFound: !!(opts && opts.onFound),
        });
        return new Promise((resolve) => {
          setTimeout(() => {
            opts.onFound && opts.onFound(pub); // 渐进通道先到一枚（{ip,info} 形）
            resolve([pub, priv]); // 权威列表（重叠项应去重）
          }, 0);
        });
      },
    });
    createMenus(makeContext(net), {
      join(code) {
        joined.push(["flow", code]);
      },
    });
    const root = UI.children[UI.children.length - 1];

    // 弹层接线自检：§12 全部 data-f 钩子必须存在
    for (const f of ["lan-ok", "lan-box", "lan-list", "lan-stat", "lan-empty", "lan-subnet", "lan-subnet-input"])
      ok(root.querySelector(`[data-f="${f}"]`) != null, `标记存在 data-f=${f}`);
    const row = root.querySelector(".m-quick-row");
    ok(row != null, "快速加入/自动发现双钮行存在");
    ok(
      row.querySelector('[data-act="quick-join"]') != null &&
        row.querySelector('[data-act="lan-scan"]') != null,
      "自动发现按钮在快速加入旁",
    );

    click(root, byAct(root, "join"));
    const lanOk = root.querySelector('[data-f="lan-ok"]');
    click(root, byAct(root, "lan-scan"));
    ok(lanOk.disabled === true && /扫描中/.test(lanOk.textContent), "扫描中按钮冻结");
    const lanBox = root.querySelector('[data-f="lan-box"]');
    ok(lanBox.hidden === false, "扫描框展开");

    await settle();
    ok(
      scanCalls.length === 1 &&
        scanCalls[0].port === 8787 &&
        scanCalls[0].timeoutMs === 450 &&
        scanCalls[0].onFound === true &&
        scanCalls[0].subnet === "192.168.1",
      "scanLan({port:8787,timeoutMs:450,subnet}) 入参契约",
    );
    const list = root.querySelector('[data-f="lan-list"]');
    ok(list.children.length === 2, "结果列表 2 行（渐进+权威去重）");
    const r0 = list.children[0],
      r1 = list.children[1];
    ok(r0.disabled === false && r0.dataset.code === "WXYZ", "公开房可点带房间码");
    ok(/对抗模式/.test(r0.textContent) && /2\/4/.test(r0.textContent) && /房主甲/.test(r0.textContent) && /192\.168\.1\.10/.test(r0.textContent), "公开行：模式徽章/人数/房主名/IP");
    ok(/合作模式/.test(r1.textContent) && /3\/4/.test(r1.textContent), "私例行：合作徽章+人数");
    ok(r1.disabled === true && /dim/.test(r1.className) && /私密/.test(r1.textContent), "私密房灰态不可点");

    // 点公开房直连（flow join 通道 → net.joinRoom）
    click(root, r0);
    ok(joined.length === 1 && joined[0][0] === "flow" && joined[0][1] === "WXYZ", "点选直连 joinRoom(WXYZ)");
    ok(/接入中/.test(root.querySelector('[data-f="join-ok"]').textContent), "直连后按钮接入中");

    // 关弹层复位（含扫描态）
    click(root, byAct(root, "join-cancel"));
    ok(lanBox.hidden === true && list.children.length === 0, "关弹层清空扫描列表");
  }

  // ================= 场景 2：§12 零结果 / 网段失败手输 / 关弹层作废在途扫描 =================
  {
    freshUI();
    const scanCalls = [];
    let resolveScan = null;
    const net = makeNet({
      joinRoom() {
        return new Promise(() => {});
      },
      getLocalSubnet() {
        return Promise.resolve("192.168.1");
      },
      scanLan(opts) {
        scanCalls.push({ subnet: opts && opts.subnet });
        if (scanCalls.length === 1)
          return new Promise((r) => {
            resolveScan = r;
          });
        return Promise.resolve([]);
      },
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    const lanBox = root.querySelector('[data-f="lan-box"]');
    const list = root.querySelector('[data-f="lan-list"]');

    // 在途扫描被关弹层作废：迟到的结果不渲染
    click(root, byAct(root, "join"));
    click(root, byAct(root, "lan-scan"));
    await settle(0); // 让 scanLan 真正起跑（加载是微任务）后再关弹层
    click(root, byAct(root, "join-cancel"));
    resolveScan && resolveScan([{ ip: "10.0.0.2", info: { code: "ZZZZ", mode: "coop", visibility: "public", phase: "lobby", players: 1, host: "独狼" } }]);
    await settle();
    click(root, byAct(root, "join"));
    ok(lanBox.hidden === true && list.children.length === 0, "关弹层后迟到扫描结果作废");

    // 网段推断失败（getLocalSubnet → null）→ 手输框弹出（不发无的之矢）
    const net2 = makeNet({
      joinRoom() {
        return new Promise(() => {});
      },
      getLocalSubnet() {
        return Promise.resolve(null);
      },
      scanLan(opts) {
        scanCalls.push({ subnet: opts && opts.subnet });
        return Promise.resolve([]);
      },
    });
    freshUI();
    createMenus(makeContext(net2), {});
    const root2 = UI.children[UI.children.length - 1];
    click(root2, byAct(root2, "join"));
    click(root2, byAct(root2, "lan-scan"));
    await settle();
    const sub2 = root2.querySelector('[data-f="lan-subnet"]');
    ok(sub2.hidden === false, "网段推断失败弹手输框");
    ok(/网段/.test(root2.querySelector('[data-f="lan-stat"]').textContent), "状态栏提示网段失败");

    // 手输过滤 + 重扫带网段（scanLan opts.subnet）
    const subInput2 = root2.querySelector('[data-f="lan-subnet-input"]');
    subInput2.value = "abc192.168.1xyz";
    subInput2.dispatch("input", {});
    ok(subInput2.value === "192.168.1", "网段输入过滤只留数字与点");
    click(root2, byAct(root2, "lan-rescan"));
    await settle(0); // scanLan 经微任务起跑后再验参
    const manual = scanCalls.filter((c) => c.subnet === "192.168.1");
    ok(manual.length >= 1, "手输重扫带 subnet=192.168.1");
    await settle();

    // 零结果 → 提示文案
    const net0 = makeNet({
      joinRoom() {
        return new Promise(() => {});
      },
      getLocalSubnet() {
        return Promise.resolve("192.168.1");
      },
      scanLan() {
        return Promise.resolve([]);
      },
    });
    freshUI();
    createMenus(makeContext(net0), {});
    const root0 = UI.children[UI.children.length - 1];
    click(root0, byAct(root0, "join"));
    click(root0, byAct(root0, "lan-scan"));
    await settle();
    const empty0 = root0.querySelector('[data-f="lan-empty"]');
    ok(empty0.hidden === false && /未发现房间/.test(empty0.textContent) && /服务器/.test(empty0.textContent), "零结果提示检查服务器");
  }

  // ================= 场景 3：§11 HUD 威胁标（敌我过滤/渐隐/续射/黑板兜底） =================
  {
    freshUI();
    const net = makeNet({
      mode: "client",
      roomMode: () => "pvp",
      selfId: () => "me1",
      players: () => [
        { id: "me1", name: "我", you: true, team: 0 },
        { id: "a2", name: "蓝友", team: 0 },
        { id: "r1", name: "红敌", team: 1 },
      ],
    });
    const ctx = makeContext(net);
    ctx.player = {
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      ads: 0,
      alive: true,
      health: 100,
      maxHealth: 100,
      sprinting: false,
    };
    ctx.weapon = { magSize: 30, ammo: 30, reserve: Infinity, name: "PAC-9", state: "" };
    ctx.camera = {
      fov: 70,
      updateMatrixWorld() {},
      matrixWorld: {},
      matrixWorldInverse: { copy() { return this; } },
    };
    const hud = createHUD(ctx);
    const root = UI.querySelector(".hud");
    hud.show(true);
    hud.update(0.016);
    const threats = () => root.querySelectorAll(".h-cm.threat");

    // 敌队开火 → 罗盘威胁标（距离米数）
    ctx.events.emit("pvp:enemyFire", { id: "r1", pos: [30, 0, 40] });
    hud.update(0.016);
    ok(threats().length === 1, "敌队开火上罗盘威胁标");
    ok(/50m/.test(threats()[0].textContent) && /敌火/.test(threats()[0].textContent), "威胁标带距离 50m 与敌火标");
    ok(threats()[0].parentNode === root.querySelector(".h-cmarks"), "威胁标落在罗盘刻度区");

    // 友军/自己/队伍未知 一律静默
    ctx.events.emit("pvp:enemyFire", { id: "a2", pos: [10, 0, 0] });
    ctx.events.emit("pvp:enemyFire", { id: "me1", pos: [10, 0, 0] });
    ctx.events.emit("pvp:enemyFire", { id: "ghost", pos: [10, 0, 0] });
    hud.update(0.016);
    ok(threats().length === 1, "友军/自己/未知队伍开火不标（friendly 静默）");

    // 1.8s 线性渐隐：0.9s → 半透明
    const el = threats()[0];
    hud.update(0.9);
    ok(el.style.opacity === "0.5", "1.8s 线性渐隐：0.9s → opacity 0.5");

    // 续射刷新：生命回满
    ctx.events.emit("pvp:enemyFire", { id: "r1", pos: [30, 0, 40] });
    hud.update(0.016);
    ok(el.style.opacity === "1", "同位置续射刷新生命回满");

    // 过期摘除
    hud.update(1.85);
    ok(threats().length === 0, "1.8s 生命到期摘除");

    // 黑板兜底通道：pvpLastFire{id,pos}（pos 为 [x,y,z]）
    ctx.pvpLastFire = { id: "r1", pos: [3, 0, 4], at: 1 };
    hud.update(0.016);
    ok(threats().length === 1 && /5m/.test(threats()[0].textContent), "黑板 pvpLastFire 兜底（[x,y,z] 距离 5m）");

    // 合作房门：离开 pvp 威胁标清空、后续开火不再上标
    net.roomMode = () => "coop";
    hud.update(0.016);
    ok(threats().length === 0, "合作房威胁标清空（pvp 门）");
    ctx.events.emit("pvp:enemyFire", { id: "r1", pos: [30, 0, 40] });
    hud.update(0.016);
    ok(threats().length === 0, "合作房开火不标（零回归）");
  }

  // ================= 场景 4：§11 受击扇形（方位角/叠加上限/衰减/门） =================
  {
    freshUI();
    const net = makeNet({
      mode: "client",
      roomMode: () => "pvp",
      selfId: () => "me1",
      players: () => [
        { id: "me1", name: "我", you: true, team: 0 },
        { id: "r1", name: "红敌", team: 1 },
      ],
    });
    const ctx = makeContext(net);
    ctx.player = {
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      ads: 0,
      alive: true,
      health: 100,
      maxHealth: 100,
      sprinting: false,
    };
    ctx.weapon = { magSize: 30, ammo: 30, reserve: Infinity, name: "PAC-9", state: "" };
    ctx.camera = {
      fov: 70,
      updateMatrixWorld() {},
      matrixWorld: {},
      matrixWorldInverse: { copy() { return this; } },
    };
    const hud = createHUD(ctx);
    const root = UI.querySelector(".hud");
    hud.show(true);
    hud.update(0.016);
    const sects = () => root.querySelectorAll(".h-phurt-s");
    const live = () => sects().filter((s) => s.style.opacity !== "0" && s.style.opacity !== "");

    // 东侧（+x）来弹 → 扇形指向右舷 90°
    ctx.pvpLastHitFrom = { pos: [10, 0, 0], at: 1 };
    hud.update(0.016);
    ok(live().length === 1, "受击扇形 1 枚点亮");
    ok(/rotate\(90deg\)/.test(live()[0].style.transform), "+x 来弹 → 方位 90°（右舷）");

    // 正前（-z）来弹 → 0°（视口系 0°=正前）
    hud.update(1.25); // 清场（1.2s 衰减）
    ok(live().length === 0, "1.2s 衰减全灭");
    ctx.pvpLastHitFrom = { pos: [0, 0, -10], at: 2 };
    hud.update(0.016);
    ok(live().length === 1 && /rotate\(0deg\)/.test(live()[0].style.transform), "-z 来弹 → 方位 0°（正前）");

    // 多方向叠加：4 个不同方向最多同显 3 枚（替换剩命最少槽）
    hud.update(1.25);
    for (const p of [[10, 0, 0], [-10, 0, 0], [0, 0, 10], [0, 0, -10]]) {
      ctx.pvpLastHitFrom = { pos: p, at: 3 };
      hud.update(0.016);
    }
    ok(live().length === 3, "4 方位受击最多同显 3 枚扇形");

    // 同向续击刷新（±22.5° 合槽）
    ctx.pvpLastHitFrom = { pos: [9, 0, 1], at: 4 };
    hud.update(0.016);
    ok(live().length === 3, "同向续击合槽不新增");

    // 合作房门：来弹不再点亮扇形
    hud.update(1.25);
    net.roomMode = () => "coop";
    ctx.pvpLastHitFrom = { pos: [10, 0, 0], at: 5 };
    hud.update(0.016);
    ok(live().length === 0, "合作房来弹不显扇形（pvp 门）");
  }

  console.log(`[ui-s11s12] ${passed.length} 项断言全绿`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String((err && err.stack) || err));
    console.error(`[ui-s11s12] 已通过 ${passed.length} 项后在上述断言失败`);
    process.exit(1);
  });
