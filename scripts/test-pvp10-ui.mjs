#!/usr/bin/env node
// scripts/test-pvp10-ui.mjs — §10 UI 车道自测（menus.js / hud.js，无浏览器）
// 覆盖：建房弹层「私密/公开」切换与 createRoom 载荷、加入弹层快速加入门与
// mode 偏好、lobby 蓝红两队分组（缺 team 降级单列）、roundend 团队结算
// （blueKills/redKills/winner 直读 + board 求和兜底 + 旧 FFA 房降级）、
// HUD 团队比分条（黑板/兜底/己方描边）、Tab 板两栏、击杀流敌我配色、
// 重生保护倒计时与开火消失、备弹 ∞（pvp 门 + Infinity 防截断）。
// 手法：极简 DOM 桩（标签/class/attr/后代选择器 + HTML 子集解析），真实 import
// src/ui/menus.js 与 src/ui/hud.js 跑逻辑——不改产品代码一行。

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
  // "tag.cls.cls#id[attr]|[attr=v]"（引号可有可无）
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
        // 右到左校验祖先链（后代组合器）
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
const winListeners = new Map();
globalThis.document = {
  getElementById: (id) => (id === "ui" ? UI : null),
  createElement: (t) => new El(t),
  addEventListener: () => {},
  body: new El("body"),
  activeElement: null,
  fullscreenElement: null,
};
globalThis.addEventListener = (t, fn) => {
  const l = winListeners.get(t) || [];
  l.push(fn);
  winListeners.set(t, l);
};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
function winDispatch(t, ev) {
  (winListeners.get(t) || []).slice().forEach((fn) => fn(ev));
}

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
  const hostPayload = [];
  const base = {
    stub: false,
    mode: "lobby-client",
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
    client: { onHostPayload(f) { hostPayload.push(f); return () => {}; }, send: () => true },
    host: { onClientPayload(f) { return () => {}; }, broadcast: () => true },
    _handlers: handlers,
    _hostPayload: hostPayload,
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

// ================= 场景 1：menus 标记接线 + 建房可见性 =================
{
  const ui = freshUI();
  const created = [];
  const net = makeNet({
    roomMode: () => "pvp",
    createRoom(name, opts) {
      created.push({ name, opts });
      return Promise.resolve({ code: "WXYZ" });
    },
    players: () => [
      { id: "h0", name: "房主", you: false },
    ],
  });
  const menus = createMenus(makeContext(net), {});
  const root = UI.children[UI.children.length - 1];

  // 弹层新标记齐备（HTML 接线自检——JS 引用的 data-f 钩子必须存在）
  for (const f of [
    "quick-ok", "lobby-teams", "lobby-blue", "lobby-red", "lobby-blue-n",
    "lobby-red-n", "roundend-team", "roundend-blue", "roundend-red", "roundend-banner",
  ])
    ok(root.querySelector(`[data-f="${f}"]`) != null, `标记存在 data-f=${f}`);
  ok(root.querySelectorAll(".m-vis-seg [data-vis]").length === 2, "建房弹层私密/公开双钮");
  ok(root.querySelector('.m-join [data-act="quick-join"]') != null, "加入弹层快速加入按钮");
  ok(root.querySelector(".m-join .m-quick") != null, "快速加入主按钮样式类");

  // 打开建房弹层 → 默认私密按下
  click(root, byAct(root, "host"));
  const hostDlg = root.querySelector(".m-host");
  ok(hostDlg.hidden === false, "建房弹层打开");
  const visPriv = root.querySelector('[data-vis="private"]');
  const visPub = root.querySelector('[data-vis="public"]');
  ok(visPriv.getAttribute("aria-pressed") === "true", "可见性默认私密");
  ok(visPub.getAttribute("aria-pressed") === "false", "公开默认未选");

  // 切公开 + 对抗 → 互斥翻转
  click(root, visPub);
  ok(visPub.getAttribute("aria-pressed") === "true", "切公开后按下");
  ok(visPriv.getAttribute("aria-pressed") === "false", "切公开后私密弹起（互斥）");
  const modePvp = root.querySelector('.m-mode-seg [data-mode="pvp"]');
  click(root, modePvp);
  ok(modePvp.getAttribute("aria-pressed") === "true", "对抗模式选中");

  // 确认建房 → createRoom 载荷带 {mode, visibility}（§10.1）
  click(root, byAct(root, "host-confirm"));
  ok(created.length === 1, "createRoom 恰好调用一次");
  ok(created[0].opts && created[0].opts.mode === "pvp", "createRoom mode=pvp");
  ok(created[0].opts && created[0].opts.visibility === "public", "createRoom visibility=public");
  ok(hostDlg.hidden === true, "确认后弹层关闭");
}

// ================= 场景 2：快速加入（门 / mode 偏好 / 回显复位） =================
{
  const ui = freshUI();
  // 旧 net：无 quickJoin 面 → 降级报错不炸
  const menusOld = createMenus(makeContext(makeNet({ roomMode: () => "coop" })), {});
  const rootOld = UI.children[UI.children.length - 1];
  const toastEl = rootOld.querySelector(".m-toast");
  click(rootOld, byAct(rootOld, "join"));
  click(rootOld, byAct(rootOld, "quick-join"));
  ok(/不支持快速加入/.test(toastEl.textContent), "旧 net 快速加入降级提示");
  ok(/err/.test(toastEl.className), "降级提示为错误样式");

  // 新 net：未选过模式 → quickJoin(undefined)；选过对抗 → quickJoin("pvp")
  const calls = [];
  const net = makeNet({
    roomMode: () => "pvp",
    quickJoin(mode) {
      calls.push(mode);
      return Promise.resolve({ code: "PUB1" });
    },
    players: () => [{ id: "me1", name: "我", you: true }],
  });
  const ctx = makeContext(net);
  const menus = createMenus(ctx, {});
  const root = UI.children[UI.children.length - 1];
  const quick = byAct(root, "quick-join");
  click(root, byAct(root, "join"));
  click(root, quick);
  ok(calls.length === 1 && calls[0] === undefined, "未选模式时 quickJoin 不带 mode");
  ok(quick.disabled === true && /匹配中/.test(quick.textContent), "匹配中按钮冻结");

  // roomState 回显 → 已接入（弹层自动关闭路径的按钮复位）
  net._emit("roomState", { players: net.players(), code: "PUB1", phase: "lobby", mode: "pvp" });
  ok(/已接入/.test(quick.textContent), "roomState 后按钮显示已接入");

  // error 通路复位
  const calls2 = [];
  const net2 = makeNet({
    roomMode: () => "pvp",
    quickJoin(mode) {
      calls2.push(mode);
      return Promise.reject(new Error("服务器忙"));
    },
  });
  const root2ctx = makeContext(net2);
  const menus2 = createMenus(root2ctx, {});
  const root2 = UI.children[UI.children.length - 1];
  const quick2 = byAct(root2, "quick-join");
  click(root2, byAct(root2, "join"));
  click(root2, quick2);
  net2._emit("error", { code: "ROOM_OP_FAILED", msg: "服务器忙" });
  ok(quick2.disabled === false && /快速加入/.test(quick2.textContent), "error 后按钮复位");

  // 模式偏好：建房弹层里选过对抗 → quickJoin("pvp")
  const calls3 = [];
  const net3 = makeNet({
    roomMode: () => "pvp",
    quickJoin(mode) {
      calls3.push(mode);
      return new Promise(() => {});
    },
  });
  const menus3 = createMenus(makeContext(net3), {});
  const root3 = UI.children[UI.children.length - 1];
  click(root3, byAct(root3, "host"));
  click(root3, root3.querySelector('.m-mode-seg [data-mode="pvp"]'));
  click(root3, byAct(root3, "host-cancel"));
  click(root3, byAct(root3, "join"));
  click(root3, byAct(root3, "quick-join"));
  ok(calls3.length === 1 && calls3[0] === "pvp", "选过对抗后 quickJoin 带 mode=pvp");
}

// ================= 场景 3：lobby 蓝红两队分组 + 缺数降级 =================
{
  const ui = freshUI();
  const net = makeNet({
    roomMode: () => "pvp",
    selfId: () => "me1",
    players: () => [
      { id: "h0", name: "蓝队长", you: false, team: 0 },
      { id: "me1", name: "我", you: true, team: 0 },
      { id: "r1", name: "红队长", you: false, team: 1 },
      { id: "r2", name: "红二", you: false, team: 1 },
    ],
  });
  const menus = createMenus(makeContext(net), {});
  const root = UI.children[UI.children.length - 1];
  menus.show("lobby");
  const teams = root.querySelector('[data-f="lobby-teams"]');
  const roster = root.querySelector('[data-f="lobby-roster"]');
  const blue = root.querySelector('[data-f="lobby-blue"]');
  const red = root.querySelector('[data-f="lobby-red"]');
  ok(teams.hidden === false, "pvp+team → 队伍分组显示");
  ok(roster.hidden === true, "单列名单退位");
  ok(blue.children.length === 2, "蓝队 2 人");
  ok(red.children.length === 2, "红队 2 人");
  ok(root.querySelector('[data-f="lobby-blue-n"]').textContent === "2", "蓝队计数=2");
  ok(root.querySelector('[data-f="lobby-red-n"]').textContent === "2", "红队计数=2");
  ok(blue.children.every((li) => li.querySelector(".dot") != null), "位色点照旧");
  const meRow = blue.children.find((li) => /（?你）?/.test(li.textContent) && /我/.test(li.textContent));
  ok(meRow != null && meRow.querySelector(".tag.you") != null, "本机行带「你」标签");

  // 缺 team 字段（旧服务器）→ 回退单列
  const netOld = makeNet({
    roomMode: () => "pvp",
    selfId: () => "me1",
    players: () => [
      { id: "h0", name: "甲", you: false },
      { id: "me1", name: "我", you: true },
    ],
  });
  const menusOld = createMenus(makeContext(netOld), {});
  const rootOld = UI.children[UI.children.length - 1];
  menusOld.show("lobby");
  ok(rootOld.querySelector('[data-f="lobby-teams"]').hidden === true, "缺 team → 分组隐藏");
  ok(
    rootOld.querySelector('[data-f="lobby-roster"]').hidden === false &&
      rootOld.querySelector('[data-f="lobby-roster"]').children.length === 2,
    "缺 team → 单列 2 行",
  );
}

// ================= 场景 4：roundend 团队结算 =================
{
  const ui = freshUI();
  const net = makeNet({ roomMode: () => "pvp", selfId: () => "me1", players: () => [] });
  const menus = createMenus(makeContext(net), {});
  const root = UI.children[UI.children.length - 1];

  // 直读 winner / blueKills / redKills（§10.1）
  menus.setRoundEnd({
    board: [
      { id: "r1", name: "红神", kills: 12, deaths: 3, team: 1 },
      { id: "me1", name: "我", kills: 9, deaths: 5, team: 0 },
    ],
    blueKills: 21,
    redKills: 13,
    winner: "blue",
    timeUp: false,
  });
  menus.show("roundend");
  ok(root.querySelector('[data-f="roundend-team"]').hidden === false, "团队结算块显示");
  ok(root.querySelector('[data-f="roundend-blue"]').textContent === "21", "大比分蓝=21");
  ok(root.querySelector('[data-f="roundend-red"]').textContent === "13", "大比分红=13");
  const ban = root.querySelector('[data-f="roundend-banner"]');
  ok(ban.hidden === false && ban.textContent === "蓝队获胜", "横幅=蓝队获胜");
  ok(/blue/.test(ban.className), "横幅染蓝队色");
  ok(root.querySelectorAll(".m-rank-row").length === 2, "个人排名照旧");

  // 数值缺 → board team 求和兜底 + 比分推胜者
  menus.setRoundEnd({
    board: [
      { id: "b1", name: "蓝一", kills: 9, deaths: 1, team: 0 },
      { id: "r1", name: "红一", kills: 4, deaths: 8, team: 1 },
    ],
    timeUp: true,
  });
  ok(root.querySelector('[data-f="roundend-blue"]').textContent === "9", "兜底蓝=9");
  ok(root.querySelector('[data-f="roundend-red"]').textContent === "4", "兜底红=4");
  ok(root.querySelector('[data-f="roundend-banner"]').textContent === "蓝队获胜", "兜底推胜者");
  ok(/战斗结束/.test(root.querySelector('[data-f="roundend-sub"]').textContent), "击杀达标文案");

  // 平局 + 旧 FFA 房降级
  menus.setRoundEnd({
    board: [
      { id: "b1", name: "蓝一", kills: 5, team: 0 },
      { id: "r1", name: "红一", kills: 5, team: 1 },
    ],
  });
  ok(root.querySelector('[data-f="roundend-banner"]').textContent === "平局", "平局横幅");
  // pvp.js setRoundEnd 形：团队字段嵌套在 data.team（T2 车道实形）
  menus.setRoundEnd({
    board: [{ id: "r1", name: "红神", kills: 9, deaths: 2, team: 1 }],
    timeUp: true,
    team: { blueKills: 8, redKills: 20, winner: "red" },
  });
  ok(root.querySelector('[data-f="roundend-blue"]').textContent === "8", "嵌套形蓝=8");
  ok(root.querySelector('[data-f="roundend-red"]').textContent === "20", "嵌套形红=20");
  ok(root.querySelector('[data-f="roundend-banner"]').textContent === "红队获胜", "嵌套形横幅=红队获胜");
  ok(/red/.test(root.querySelector('[data-f="roundend-banner"]').className), "横幅染红队色");
  menus.setRoundEnd({ board: [{ id: "x", name: "独狼", kills: 7 }], timeUp: false });
  ok(root.querySelector('[data-f="roundend-team"]').hidden === true, "旧 FFA 房不显团队块");
  ok(/20 杀/.test(root.querySelector('[data-f="roundend-sub"]').textContent), "旧房文案按 20 杀口径");
}

// ================= 场景 5：HUD（团队比分 / Tab 两栏 / 保护 / ∞ / 击杀流） =================
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
  ctx.pvpBoard = [
    { id: "me1", name: "我", kills: 1, deaths: 0, team: 0 },
    { id: "a2", name: "蓝友", kills: 2, deaths: 1, team: 0 },
    { id: "r1", name: "红敌", kills: 5, deaths: 1, team: 1 },
  ];
  ctx.pvpTeams = { blue: 3, red: 5 };
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
  ctx.weapon = { magSize: 30, ammo: 30, reserve: 120, name: "PAC-9", state: "" };
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

  // 团队比分条：蓝 3 — 5 红，己方（蓝）描边
  const tscore = root.querySelector(".h-mp-tscore");
  ok(tscore.hidden === false, "团队比分条显示");
  ok(tscore.querySelector(".tb i").textContent === "3", "蓝队分=3");
  ok(tscore.querySelector(".tr i").textContent === "5", "红队分=5");
  ok(/mine-blue/.test(tscore.className), "己方蓝队高亮描边");
  const soloOf = () =>
    root.querySelectorAll(".h-mp-score").filter((e) => !/tscore/.test(e.className))[0];
  ok(soloOf().hidden === true, "个人小条退位");

  // 黑板缺数 → board 求和兜底；再去掉 team → 个人小条回显（旧房兼容）
  ctx.pvpTeams = null;
  hud.update(0.016);
  ok(tscore.querySelector(".tb i").textContent === "3", "黑板缺→board 求和仍 3:5");
  delete ctx.pvpBoard[0].team;
  delete ctx.pvpBoard[1].team;
  delete ctx.pvpBoard[2].team;
  hud.update(0.016);
  ok(tscore.hidden === true, "无队伍数据→团队条隐藏");
  const solo = soloOf();
  ok(solo.hidden === false && /1 杀/.test(solo.textContent), "无队伍数据→回退个人杀数显示");

  // Tab 板两栏
  ctx.pvpBoard = [
    { id: "me1", name: "我", kills: 1, deaths: 0, team: 0 },
    { id: "a2", name: "蓝友", kills: 2, deaths: 1, team: 0 },
    { id: "r1", name: "红敌", kills: 5, deaths: 1, team: 1 },
  ];
  hud.update(0.016);
  winDispatch("keydown", { code: "Tab", defaultPrevented: false, preventDefault() {} });
  hud.update(0.016);
  const rows = root.querySelector(".h-mp-board-rows");
  ok(root.querySelector(".h-mp-board").hidden === false, "Tab 板显示");
  ok(rows.classList.contains("teams"), "Tab 板两栏模式");
  const cols = rows.children;
  ok(cols.length === 2 && /blue/.test(cols[0].className) && /red/.test(cols[1].className), "蓝红两栏");
  ok(cols[0].querySelectorAll(".h-mp-brow").length === 2, "蓝栏 2 行");
  ok(cols[1].querySelectorAll(".h-mp-brow").length === 1, "红栏 1 行");
  winDispatch("keyup", { code: "Tab" });

  // 击杀流敌我配色：被红敌击杀=红名行；队友杀敌=青色行；自己杀敌=橙
  ctx.events.emit("pvp:killed", { by: "r1", victim: "me1" });
  const feed = root.querySelector(".h-feed");
  const diedLine = feed.children[feed.children.length - 1];
  ok(/pvp died/.test(diedLine.className), "被敌击杀行 died 标记");
  ctx.time.real += 5;
  ctx.events.emit("pvp:killed", { by: "a2", victim: "r1" });
  const allyLine = feed.children[feed.children.length - 1];
  ok(/pvp ally/.test(allyLine.className), "队友击杀行 ally 标记");
  ctx.time.real += 5;
  ctx.events.emit("pvp:killed", { by: "me1", victim: "r1" });
  const meLine = feed.children[feed.children.length - 1];
  ok(/pvp me/.test(meLine.className) && !/ally/.test(meLine.className), "自己击杀行 me 标记");

  // 重生保护：黑板未到期显示 X.Xs；开火即消失
  ctx.pvpProt = { deadline: performance.now() + 2300 };
  hud.update(0.016);
  const prot = root.querySelector(".h-mp-prot");
  ok(prot.hidden === false, "重生保护显示");
  ok(/^\d+\.\ds$/.test(prot.querySelector("span").textContent), "保护倒计时 X.Xs 格式");
  ctx.events.emit("weapon:fire", {});
  hud.update(0.016);
  ok(prot.hidden === true, "开火后保护消失（CF 语义）");
  ctx.pvpProt = null;

  // 备弹 ∞：pvp 门；Infinity 防位运算截断；弹尽提示不误报
  hud.update(0.016);
  const ammoR = root.querySelector(".h-ammo-r");
  ok(ammoR.textContent === "∞", "pvp 房备弹显示 ∞");
  ctx.weapon = { magSize: 30, ammo: 0, reserve: Infinity, name: "PAC-9", state: "" };
  ctx.net_roomModePvpOff = true;
  hud.update(0.016);
  ok(ammoR.textContent === "∞", "reserve=Infinity 不被截断显示 ∞");
  ok(/换弹/.test(root.querySelector(".h-cue").textContent) && !/弹尽/.test(root.querySelector(".h-cue").textContent), "空弹匣+无限备弹→换弹提示");

  // coop 门回归：非 pvp 房一切 pvp 元素隐藏、备弹恢复数字
  net.roomMode = () => "coop";
  hud.update(0.016);
  ok(root.querySelector(".h-mp-tscore").hidden === true, "coop 团队条隐藏");
  ok(root.querySelector(".h-mp-prot").hidden === true, "coop 保护提示隐藏");
  ctx.weapon = { magSize: 30, ammo: 30, reserve: 120, name: "PAC-9", state: "" };
  hud.update(0.016);
  ok(ammoR.textContent === "120", "coop 备弹恢复数字（零回归）");
}

console.log(`[pvp10-ui] ${passed.length} 项断言全绿`);
process.exit(0);
