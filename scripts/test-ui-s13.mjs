#!/usr/bin/env node
// scripts/test-ui-s13.mjs — §13 零服务器批次 UI 车道自测（menus.js，无浏览器）
// 覆盖：建房弹层第三钮「零服务器建房」（render + 点击签名：createRoom(name,
// {mode, visibility:'private', transport:'p2p'})，合作/对抗两态）、加入弹层
// 「零服务器」开关盒（公共匹配 → quickJoin(mode,{transport:'p2p'})；4 位码输入
// 过滤/按键门限/Enter 加入 → joinRoom(code,name,{transport:'p2p'})；Esc 关弹层）、
// 接入成功关盒时序（roomState 事件驱动「已接入」+ 750ms 自动关）、失败复位、
// 大厅公共房标签（roomLabel 替代房码 + 零服务器提示文案）、公共房复制分享指引、
// 私人房照旧复制房码、p2p 合成 roomState（players[].team/mode/visibility）与
// 既有 lobby 分组消费端兼容（蓝红两栏渲染）。
// 手法：极简 DOM 桩（与 test-ui-s11s12.mjs 同款），真实 import src/ui/menus.js
// 跑逻辑——不改产品代码一行。

import { createMenus } from "../src/ui/menus.js";

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

function stubClipboard() {
  let copied = null;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    get: () => ({
      clipboard: {
        writeText(t) {
          copied = t;
          return Promise.resolve();
        },
      },
    }),
  });
  return () => copied;
}

async function main() {
  // ============ 场景 1：建房弹层第三钮「零服务器建房」 ============
  {
    freshUI();
    const calls = [];
    const net = makeNet({
      mode: "lobby-host",
      isHost: () => true,
      createRoom(name, opts) {
        calls.push(["createRoom", name, opts]);
        return Promise.resolve({ code: "QW3R", seed: 7 });
      },
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];

    // 接线自检：§13 建房弹层钩子齐备
    for (const f of ["host-p2p"])
      ok(root.querySelector(`[data-f="${f}"]`) != null, `标记存在 data-f=${f}`);
    ok(
      root.querySelector('[data-act="host-p2p"]') != null,
      "建房弹层渲染「零服务器建房」第三钮",
    );

    // 默认（合作）点击 → createRoom(name, {mode:'coop', visibility:'private', transport:'p2p'})
    click(root, byAct(root, "host-p2p"));
    await settle();
    ok(calls.length === 1, "点击即触发一次 createRoom");
    ok(
      calls[0][0] === "createRoom" &&
        calls[0][2] &&
        calls[0][2].mode === "coop" &&
        calls[0][2].visibility === "private" &&
        calls[0][2].transport === "p2p",
      "零服务器建房签名：mode=coop · visibility=private · transport=p2p",
    );

    // 切对抗后再点 → mode:'pvp'
    click(root, root.querySelector('.m-mode-seg [data-mode="pvp"]'));
    click(root, byAct(root, "host-p2p"));
    await settle();
    ok(
      calls.length === 2 && calls[1][2].mode === "pvp",
      "选对抗后零服务器建房 mode=pvp",
    );
  }

  // ============ 场景 2：加入弹层零服务器盒——公共匹配 + 码加入 ============
  {
    freshUI();
    const quick = [],
      joins = [];
    const net = makeNet({
      mode: "lobby-client", // 接入成功态（roomState 关盒时序的判据）
      quickJoin(mode, opts) {
        quick.push([mode, opts]);
        return new Promise(() => {}); // 挂起：态置位与复位分场景验证
      },
      joinRoom(code, name, opts) {
        joins.push([code, name, opts]);
        return new Promise(() => {});
      },
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    const joinBtn = byAct(root, "join");
    click(root, joinBtn);
    await settle();
    const joinEl = root.querySelector(".m-join");
    ok(joinEl && joinEl.hidden === false, "加入弹层开启");

    for (const f of ["p2p-toggle", "p2p-box", "p2p-stat", "p2p-public-ok", "p2p-code", "p2p-join-ok"])
      ok(root.querySelector(`[data-f="${f}"]`) != null, `标记存在 data-f=${f}`);

    const box = root.querySelector('[data-f="p2p-box"]');
    ok(box && box.hidden === true, "零服务器盒初始隐藏");
    click(root, byAct(root, "p2p-join"));
    await settle();
    ok(box.hidden === false, "点「零服务器」开盒");

    // 公共匹配点击 → quickJoin(undefined, {transport:'p2p'})（未主动选过模式 → 无偏好）
    const pubOk = root.querySelector('[data-f="p2p-public-ok"]');
    click(root, byAct(root, "p2p-public"));
    await settle();
    ok(
      quick.length === 1 &&
        quick[0][0] === undefined &&
        quick[0][1] &&
        quick[0][1].transport === "p2p",
      "公共匹配 → quickJoin(mode?, {transport:'p2p'})",
    );
    ok(
      pubOk.disabled === true && /探测/.test(pubOk.textContent),
      "公共匹配按钮进入「探测分片中…」态",
    );

    // 码输入：非法字符过滤 + 4 位门
    const codeInput = root.querySelector('[data-f="p2p-code"]');
    const joinOkBtn = root.querySelector('[data-f="p2p-join-ok"]');
    codeInput.value = "a7!x";
    codeInput.dispatch("input", { target: codeInput });
    ok(codeInput.value === "A7X", "码输入过滤（大写+去非法）");
    ok(joinOkBtn.disabled === true, "3 位不加门：加入钮保持禁用");
    codeInput.value = "A7X2";
    codeInput.dispatch("input", { target: codeInput });
    ok(joinOkBtn.disabled === false, "4 位启用加入钮");
    // Enter 直接加入
    codeInput.dispatch("keydown", {
      target: codeInput,
      code: "Enter",
      preventDefault() {},
      stopPropagation() {},
    });
    await settle();
    ok(
      joins.length === 1 &&
        joins[0][0] === "A7X2" &&
        joins[0][2] &&
        joins[0][2].transport === "p2p",
      "Enter → joinRoom(code, name, {transport:'p2p'})",
    );
    ok(/接入中/.test(joinOkBtn.textContent), "码加入按钮进入「接入中…」态");

    // roomState（lobby）到达 → 「已接入」+ 750ms 后自动关弹层（与 ws 加入同款时序）
    net._emit("roomState", {});
    await settle();
    ok(/已接入/.test(joinOkBtn.textContent), "接入成功：按钮转「已接入」");
    ok(/已接入/.test(pubOk.textContent), "公共匹配钮同拍「已接入」");
    await settle(900);
    ok(joinEl.hidden === true, "750ms 后自动关加入弹层");
    ok(box.hidden === true, "关弹层同时收起零服务器盒");
  }

  // ============ 场景 3：失败复位 + Esc 关盒 ============
  {
    freshUI();
    let rejectQuick = null,
      rejectJoin = null;
    const net = makeNet({
      quickJoin() {
        return new Promise((_, rj) => (rejectQuick = rj));
      },
      joinRoom() {
        return new Promise((_, rj) => (rejectJoin = rj));
      },
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    click(root, byAct(root, "join"));
    await settle();
    click(root, byAct(root, "p2p-join"));
    await settle();
    const pubOk = root.querySelector('[data-f="p2p-public-ok"]');

    click(root, byAct(root, "p2p-public"));
    await settle();
    rejectQuick(Object.assign(new Error("零服务器链路建立超时"), { code: "TIMEOUT" }));
    await settle();
    ok(
      pubOk.disabled === false && /公共匹配/.test(pubOk.textContent),
      "公共匹配失败复位按钮",
    );

    const codeInput = root.querySelector('[data-f="p2p-code"]');
    const joinOkBtn = root.querySelector('[data-f="p2p-join-ok"]');
    codeInput.value = "ZZ9Z";
    codeInput.dispatch("input", { target: codeInput });
    click(root, byAct(root, "p2p-join-confirm"));
    await settle();
    rejectJoin(Object.assign(new Error("零服务器链路中断"), { code: "DISCONNECT" }));
    await settle();
    ok(
      joinOkBtn.disabled === false && joinOkBtn.textContent === "加入",
      "码加入失败复位按钮",
    );

    // Esc 在码输入框内 → 关闭整个加入弹层
    const joinEl = root.querySelector(".m-join");
    codeInput.dispatch("keydown", {
      target: codeInput,
      code: "Escape",
      preventDefault() {},
      stopPropagation() {},
    });
    await settle();
    ok(joinEl.hidden === true, "Esc 关闭加入弹层（p2p 码输入同款）");
  }

  // ============ 场景 4：大厅公共房标签 + 零服务器提示 + 分享指引 ============
  {
    freshUI();
    const getCopied = stubClipboard();
    const net = makeNet({
      mode: "lobby-host",
      isHost: () => true,
      roomMode: () => "coop",
      roomCode: () => null, // 公共房无房码
      roomLabel: () => "公共房 · 分片 3",
      transportKind: () => "p2p",
      p2pStrategy: () => "nostr",
      players: () => [
        { id: "me1", name: "房主我", you: true, ready: true, team: 0 },
        { id: "p2", name: "队友乙", you: false, ready: true, team: 0 },
      ],
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    net._emit("roomState", {});
    await settle();
    const codeEl = root.querySelector('[data-f="lobby-code"]');
    ok(
      codeEl && /分片 3/.test(codeEl.textContent),
      "公共房 lobby 码位显示「公共房 · 分片 3」",
    );
    const hint = root.querySelector('[data-f="lobby-hint"]');
    ok(hint && /零服务器/.test(hint.textContent), "lobby 提示含零服务器口径");
    // 复制 → 「同文件+公共匹配」指引（§13.2）
    click(root, byAct(root, "copy-code"));
    await settle();
    let copied = getCopied();
    ok(
      copied && /同一份游戏文件/.test(copied) && /公共匹配/.test(copied),
      "公共房复制 = 同文件+公共匹配指引",
    );
  }

  // ============ 场景 5：私人房（p2p）照旧复制房码 ============
  {
    freshUI();
    const getCopied = stubClipboard();
    const net = makeNet({
      mode: "lobby-host",
      isHost: () => true,
      roomCode: () => "QW3R",
      roomLabel: () => null,
      transportKind: () => "p2p",
      players: () => [{ id: "me1", name: "房主我", you: true, ready: true, team: 0 }],
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    net._emit("roomState", {});
    await settle();
    click(root, byAct(root, "copy-code"));
    await settle();
    ok(getCopied() === "QW3R", "私人房（p2p）照旧复制 4 位房码");
  }

  // ============ 场景 6：p2p 合成 roomState 与既有 lobby 分组消费端兼容 ============
  {
    freshUI();
    // 完全按 trystero-transport pushRoomState 的帧形（mode/visibility/players[].team）
    const net = makeNet({
      mode: "lobby-host",
      isHost: () => true,
      roomMode: () => "pvp",
      roomCode: () => "KP4M",
      roomLabel: () => null,
      transportKind: () => "p2p",
      players: () => [
        { id: "p0001", name: "蓝一", you: false, ready: true, team: 0 },
        { id: "p0002", name: "红一", you: true, ready: true, team: 1 },
        { id: "p0003", name: "蓝二", you: false, ready: true, team: 0 },
        { id: "p0004", name: "红二", you: false, ready: true, team: 1 },
      ],
    });
    createMenus(makeContext(net), {});
    const root = UI.children[UI.children.length - 1];
    net._emit("roomState", {
      players: net.players(),
      code: "KP4M",
      phase: "lobby",
      mode: "pvp",
      visibility: "private",
    });
    await settle();
    const blue = root.querySelector('[data-f="lobby-blue"]');
    const red = root.querySelector('[data-f="lobby-red"]');
    const teams = root.querySelector('[data-f="lobby-teams"]');
    ok(teams && teams.hidden === false, "pvp 分组两栏渲染（team 字段消费）");
    ok(
      blue && blue.children.length === 2 && red && red.children.length === 2,
      "p2p 合成 roomState 的 team 奇偶 → 蓝 2 / 红 2",
    );
    ok(
      /蓝一|蓝二/.test(blue.textContent) && /红一|红二/.test(red.textContent),
      "蓝红栏呼号正确落位",
    );
  }

  console.log(`\n${passed.length} 断言全部通过（§13 UI 车道）`);
}

main().catch((e) => {
  console.error("套件崩溃:", e);
  process.exit(1);
});

