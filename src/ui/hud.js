// DOM HUD, objective markers, damage feedback and radio subtitles.
import { Vector3 } from "../vendor/three-r180.js";

var tx = 4;

var nx = -90;

var WC = 450;

var GC = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

var ix = 2 * Math.PI * 19;

function createElement(i, e, t) {
  let n = document.createElement(i);
  return (e && (n.className = e), t != null && (n.innerHTML = t), n);
}

function createHUD(context) {
  let e = document.getElementById("ui"),
    t = createElement("div", "hud");
  t.setAttribute("aria-hidden", "true");
  let n = createElement("div", "h-compass"),
    s = createElement("div", "h-tape"),
    o = "";
  for (let k = nx; k <= WC; k += 5) {
    let ce = (k - nx) * tx,
      ve = ((k % 360) + 360) % 360,
      _e = ve % 45 === 0,
      Te = ve % 15 === 0;
    ((o += `<i class="${_e ? "mj" : Te ? "md" : "mn"}" style="left:${ce}px"></i>`),
      _e
        ? (o += `<b class="${ve % 90 === 0 ? "card" : "ic"}" style="left:${ce}px">${GC[ve]}</b>`)
        : ve % 15 === 0 &&
          (o += `<b class="num" style="left:${ce}px">${String(ve).padStart(3, "0")}</b>`));
  }
  s.innerHTML = o;
  let r = createElement("div", "h-tape-wrap");
  r.appendChild(s);
  let a = createElement("div", "h-cmarks"),
    l = createElement("div", "h-heading", "000");
  n.append(r, createElement("i", "h-needle"), a, l);
  let c = createElement(
      "div",
      "h-obj",
      '<div class="h-k">目标</div><div class="h-obj-t"></div><div class="h-relays"><span>中继</span><i></i><i></i><i></i><b>0/3</b></div>',
    ),
    u = c.querySelector(".h-obj-t"),
    h = c.querySelector(".h-relays"),
    f = h.querySelector("b"),
    p = [...h.querySelectorAll("i")],
    d = createElement("div", "h-warn"),
    v = createElement(
      "div",
      "h-cross",
      '<i class="c-t"></i><i class="c-b"></i><i class="c-l"></i><i class="c-r"></i><i class="c-dot"></i>',
    ),
    g = v.querySelectorAll("i"),
    x = createElement("div", "h-hit", "<i></i><i></i><i></i><i></i>"),
    y = createElement("div", "h-arcs"),
    b = [];
  for (let k = 0; k < 4; k++) {
    let ce = createElement(
      "div",
      "h-arc",
      '<svg viewBox="-100 -100 200 200"><path d="M -38 -84 A 92 92 0 0 1 38 -84" /><path class="tip" d="M -7 -97 L 0 -106 L 7 -97" /></svg>',
    );
    (y.appendChild(ce),
      b.push({
        el: ce,
        life: 0,
        src: new Vector3(),
        op: -1,
        rot: 1e9,
      }));
  }
  // —— §11 受击方向扇形（pvp 专属：3 槽叠加、径向红渐变 1.2s，JS 逐帧驱动）——
  let ph = createElement("div", "h-phurt"),
    phS = [];
  for (let k = 0; k < 3; k++) {
    let se = createElement("div", "h-phurt-s");
    ((se.style.opacity = "0"), ph.appendChild(se));
    phS.push({ el: se, life: 0, ang: null, op: 0, rot: 1e9 });
  }
  let m = createElement(
      "div",
      "h-prompt",
      `<svg viewBox="-24 -24 48 48"><circle class="bg" r="19"/><circle class="fg" r="19" stroke-dasharray="${ix.toFixed(2)}" stroke-dashoffset="${ix.toFixed(2)}" transform="rotate(-90)"/></svg><span class="h-key">E</span><span class="h-plabel"></span>`,
    ),
    A = m.querySelector(".fg"),
    _ = m.querySelector(".h-key"),
    M = m.querySelector(".h-plabel"),
    E = createElement("div", "h-feed"),
    w = createElement("div", "h-msg"),
    S = createElement(
      "div",
      "h-health",
      '<div class="h-k">生命体征</div><div class="h-hp-row"><b class="h-hp-n">100</b><div class="h-hp-bar">' +
        "<i></i>".repeat(10) +
        "</div></div>",
    ),
    z = S.querySelector(".h-hp-n"),
    H = [...S.querySelectorAll(".h-hp-bar i")],
    O = createElement(
      "div",
      "h-ammo",
      '<div class="h-cue"></div><div class="h-ammo-row"><b class="h-ammo-n">30</b><span class="h-ammo-r">120</span></div><div class="h-pips"></div><div class="h-wname"></div>',
    ),
    q = O.querySelector(".h-ammo-n"),
    U = O.querySelector(".h-ammo-r"),
    T = O.querySelector(".h-pips"),
    D = O.querySelector(".h-wname"),
    C = O.querySelector(".h-cue"),
    G = createElement("div", "h-marks");
  (t.append(G, n, c, d, y, ph, v, x, m, E, w, S, O), e.appendChild(t));
  // —— 对抗模式 HUD（MP-PVP §8.2）：顶部计分小条 / Tab 计分板 / 重生倒计时 ——
  let mpScoreEl = createElement(
      "div",
      "h-mp-score",
      '<b class="you"></b><span class="lead"></span>',
    ),
    // §10.2 团队比分条（蓝 n — n 红；己方队高亮描边）——独立元素，与个人小条互斥显隐
    mpTeamsEl = createElement(
      "div",
      "h-mp-score h-mp-tscore",
      '<b class="t tb">蓝 <i>0</i></b><span class="vs">—</span><b class="t tr"><i>0</i> 红</b>',
    ),
    mpBoardEl = createElement(
      "div",
      "h-mp-board",
      '<div class="h-mp-board-c"><div class="h-mp-board-h">港区对抗 · 战况</div><div class="h-mp-board-rows"></div><div class="h-mp-board-f">按住 Tab 查看 · 松开关闭</div></div>',
    ),
    mpRespEl = createElement(
      "div",
      "h-mp-respawn",
      "<b>3</b><span>重新部署</span>",
    ),
    // §10.2 重生保护提示（「重生保护 X.Xs」，开火即消失——CF 语义）
    mpProtEl = createElement(
      "div",
      "h-mp-prot",
      "<b>重生保护</b><span>3.0s</span>",
    );
  ((mpScoreEl.hidden = !0),
    (mpTeamsEl.hidden = !0),
    (mpBoardEl.hidden = !0),
    (mpRespEl.hidden = !0),
    (mpProtEl.hidden = !0),
    t.append(mpScoreEl, mpTeamsEl, mpBoardEl, mpRespEl, mpProtEl));
  let j = createElement(
    "div",
    "comms",
    '<span class="comms-who">指挥部</span><span class="comms-t"></span>',
  );
  (j.setAttribute("role", "status"), j.setAttribute("aria-live", "polite"));
  let N = j.querySelector(".comms-t"),
    jW = j.querySelector(".comms-who");
  e.appendChild(j);
  let Q = !1,
    K = 420,
    ie = innerWidth,
    F = innerHeight,
    X = {
      ammo: -1,
      mag: -1,
      reserve: -1,
      name: null,
      cue: null,
      low: null,
      hp: -1,
      hpSeg: -1,
      hurt: null,
      head: -1,
      tapeX: 1e9,
      gap: -1,
      crossOn: null,
      promptOn: null,
      promptText: null,
      promptT: -1,
      promptKey: null,
      marksOn: null,
      done: -1,
      total: -1,
    },
    ne = [],
    re = "",
    $ = 0,
    ue = 0,
    me = [],
    ee = null,
    B = 0,
    P = 0,
    V = 0,
    Y = 0,
    L = 0,
    Z = [],
    J = [],
    oe = new Vector3(),
    fe = null,
    le = -1,
    mBase = [],
    mMates = new Map(),
    mFlags = new Map(),
    mT = 0,
    netB = !1,
    // —— pvp HUD 状态（MP-PVP）——
    mpYou = mpScoreEl.querySelector(".you"),
    mpLead = mpScoreEl.querySelector(".lead"),
    mpTeamsB = mpTeamsEl.querySelector(".tb i"),
    mpTeamsR = mpTeamsEl.querySelector(".tr i"),
    mpBoardRows = mpBoardEl.querySelector(".h-mp-board-rows"),
    mpRespN = mpRespEl.querySelector("b"),
    mpProtN = mpProtEl.querySelector("span"),
    mpPayloadBoard = null, // score/roundEnd 载荷 board 兜底缓存（主路径 context.pvpBoard）
    mpPrevRows = new Map(), // 计分板差分基线（host 端击杀流来源）
    mpDedupe = new Map(), // 击杀流去重（载荷通道与差分通道双保险）
    mpRespDeadline = 0, // respawn 载荷倒计时截止（ms）
    mpTabOn = !1,
    mpScoreSig = "",
    mpTeamsSig = "", // 团队比分条差分签名（blue|red|myTeam）
    mpBoardSig = "",
    mpRespSig = "",
    mpProtSig = "", // 保护提示差分签名（0.1s 粒度文本）
    mpProtSup = null, // 开火抑制引用：fire 时快照 context.pvpProt，同一保护不再显示
    // —— §11 敌方坐标提醒状态 ——
    mThreats = new Map(), // 火力暴露：敌方 id → 罗盘威胁标（1.8s 渐隐，续射刷新）
    s11FireRef = null, // context.pvpLastFire 黑板身份戳（事件通道缺席时的兜底消费去重）
    s11HitRef = null; // context.pvpLastHitFrom 黑板身份戳（受击扇形）
  function R() {
    ((ie = innerWidth),
      (F = innerHeight),
      (K = n.clientWidth || Math.min(420, ie * 0.6)),
      (X.tapeX = 1e9),
      (X.gap = -1));
    for (let k of J) ((k.lastC = 1e9), (k.lastW = ""));
  }
  // ---- 多人模式（MP）：射手归属 / 队友电台行 / net 本地事件（防回环：只读，绝不 emit） ----
  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (ch) =>
        ch === "&"
          ? "&amp;"
          : ch === "<"
            ? "&lt;"
            : ch === ">"
              ? "&gt;"
              : ch === '"'
                ? "&quot;"
                : "&#39;",
    );
  }
  function shooterName(id) {
    let nn = context.net;
    try {
      if (nn && nn.selfId && nn.selfId() === id) return "你";
    } catch {}
    try {
      if (nn && typeof nn.players == "function")
        for (let pl of nn.players())
          if (pl && pl.id === id) return pl.name || "队友";
    } catch {}
    try {
      let rp = context.remotePlayers;
      if (rp && typeof rp.byId == "function") {
        let m = rp.byId(id);
        if (m && m.name) return m.name;
      }
    } catch {}
    return "队友";
  }
  // ---- 对抗模式（MP-PVP §8.2）：计分/击杀流/重生倒计时 ----
  function mpNameOf(id) {
    let nm = shooterName(id);
    return nm === "队友" ? "对手" : nm;
  }
  function mpSelfId() {
    try {
      return context.net && typeof context.net.selfId == "function"
        ? context.net.selfId()
        : null;
    } catch {
      return null;
    }
  }
  function mpPvpOn() {
    // 对抗模式门：roomMode 回显 + 在房（离线/连接中恒关——合作与单机零回归）
    let nn = context.net;
    if (!nn || nn.stub) return !1;
    if (nn.mode === "offline" || nn.mode === "connecting") return !1;
    if (typeof nn.roomMode != "function") return !1;
    try {
      return nn.roomMode() === "pvp";
    } catch {
      return !1;
    }
  }
  function mpSortedBoard(raw) {
    // 名次序：杀数降序 → 阵亡升序 → 呼号（与 roundend 屏同口径）；
    // team 透传（§10.1 board[] 每项 +team:0|1，旧房缺省 null）
    let rows = [];
    for (let r of raw || [])
      r &&
        r.id != null &&
        rows.push({
          id: r.id,
          name: r.name || "对手",
          you: !!r.you || r.id === mpSelfId(),
          kills: Math.max(0, r.kills | 0),
          deaths: Math.max(0, r.deaths | 0),
          team: r.team === 0 || r.team === 1 ? r.team : null,
        });
    return rows.sort(
      (a, b) =>
        b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name),
    );
  }
  // ---- 团队对抗（MP-PVP §10）：队伍取数 —— 一律消费 net.players() 的 team 字段
  // 与 context.pvpTeams/pvpProt 黑板（T2 车道写入），缺数优雅降级 ----
  function mpMyTeam() {
    // §10.2 net.myTeam() 主路径；旧 net 无此面 → players() 里找自己兜底；再缺=null
    let nn = context.net,
      self = mpSelfId();
    try {
      if (nn && typeof nn.myTeam == "function") {
        let t = nn.myTeam();
        if (t === 0 || t === 1) return t;
      }
    } catch {}
    if (self == null) return null;
    try {
      if (nn && typeof nn.players == "function")
        for (let pl of nn.players())
          if (pl && pl.id === self && (pl.team === 0 || pl.team === 1))
            return pl.team;
    } catch {}
    return null;
  }
  function mpTeamOf(id) {
    if (id == null) return null;
    if (id === mpSelfId()) return mpMyTeam();
    let nn = context.net;
    try {
      if (nn && typeof nn.players == "function")
        for (let pl of nn.players())
          if (pl && pl.id === id && (pl.team === 0 || pl.team === 1))
            return pl.team;
    } catch {}
    return null;
  }
  function mpTeamsNow() {
    // 队伍比分：context.pvpTeams 黑板（teamscore 载荷翻译，{blue,red}）→
    // board[] team 字段按 kills 求和兜底 → null（回退个人杀数显示，兼容旧房）
    let t = context.pvpTeams;
    if (t && typeof t == "object") {
      let b = t.blue != null ? +t.blue : t.blueKills != null ? +t.blueKills : NaN,
        r = t.red != null ? +t.red : t.redKills != null ? +t.redKills : NaN;
      if (Number.isFinite(b) && Number.isFinite(r))
        return { blue: Math.max(0, b | 0), red: Math.max(0, r | 0) };
    }
    let raw = mpBoardNow();
    if (raw && raw.length) {
      let b = 0,
        r = 0,
        seen = !1;
      for (let row of raw) {
        if (!row || (row.team !== 0 && row.team !== 1)) continue;
        seen = !0;
        row.team === 1
          ? (r += Math.max(0, row.kills | 0))
          : (b += Math.max(0, row.kills | 0));
      }
      if (seen) return { blue: b, red: r };
    }
    return null;
  }
  function mpProtLeft() {
    // 重生保护剩余秒（§10.0 3s 免疫）：黑板 {deadline:ms}（pvpRespawn 同款惯例）
    // 优先；{t|left|sec|prot[,at:ms]} 次之；纯数字降级直读（无时基不倒计时）
    let pr = context.pvpProt;
    if (pr == null) return 0;
    let now =
      typeof performance != "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (typeof pr == "number") return pr > 0 ? pr : 0;
    if (typeof pr == "object") {
      if (typeof pr.deadline == "number")
        return Math.max(0, (pr.deadline - now) / 1e3);
      if (typeof pr.until == "number") return Math.max(0, (pr.until - now) / 1e3);
      let base = typeof pr.at == "number" ? pr.at : null,
        v = null;
      for (let key of ["t", "left", "sec", "prot", "in"])
        if (typeof pr[key] == "number" && pr[key] >= 0) {
          v = pr[key];
          break;
        }
      if (v != null)
        return base != null ? Math.max(0, v - (now - base) / 1e3) : v;
    }
    return 0;
  }
  function mpBoardNow() {
    // 板面来源优先级：context.pvpBoard（契约黑板）→ pvp-flow 实况
    // （context.game.run.board，host-sim/pvp 载荷两路喂给 pvp:score）→ 载荷缓存
    let b = context.pvpBoard;
    if (Array.isArray(b) && b.length) return b;
    try {
      let run = context.game && context.game.run;
      if (Array.isArray(run.board) && run.board.length) return run.board;
    } catch {}
    return mpPayloadBoard;
  }
  function mpFeedKill(by, victim, hs) {
    // pvp 击杀流：「A ▸ B」，己方击杀橙色高亮；爆头行后缀「爆头」徽标
    // （§9.1 headshot:bool；em 复用 .h-fl em 既有signal橙——与「弱点命中」同款语法）
    // §10.0 敌我配色：我方（含队友）击杀敌队=高亮（自己橙/队友青）；被敌队击杀=红名
    if (by == null || victim == null) return;
    let key = by + ">" + victim,
      now = context.time.real;
    if ((mpDedupe.get(key) || 0) > now - 2.5) return;
    (mpDedupe.set(key, now),
      mpDedupe.size > 32 &&
        mpDedupe.forEach((t2, k2) => {
          t2 < now - 3 && mpDedupe.delete(k2);
        }));
    let self = mpSelfId(),
      myT = mpMyTeam(),
      byT = mpTeamOf(by),
      allyKill = myT != null && byT === myT, // 我方火力（含自己，FFA 旧房 myT=null 不进）
      diedToEnemy = victim === self && myT != null && byT != null && byT !== myT,
      a = by === self ? "你" : mpNameOf(by),
      b = victim === self ? "你" : mpNameOf(victim),
      line = I.feed(
        `<span class="kf-a">${esc(a)}</span> ▸ <span class="kf-b">${esc(b)}</span>` +
          (hs ? "<em>爆头</em>" : ""),
      );
    line &&
      line.el &&
      (line.el.className =
        "h-fl pvp" +
        (by === self ? " me" : allyKill ? " ally" : "") +
        (diedToEnemy ? " died" : "") +
        (hs ? " hs" : ""));
  }
  function mpDiffFeed(rows) {
    // 计分板差分兜底（pvp:killed 事件缺席的极端时序：如事件桥晚绑）——
    // kills/deaths 增量配对生成击杀流；与事件通道重叠由 mpDedupe 吸收
    let killers = [],
      victims = [],
      seen = new Set();
    for (let r of rows) {
      seen.add(String(r.id));
      let prev = mpPrevRows.get(String(r.id));
      if (!prev) continue; // 首帧只建基线
      let dk = (r.kills | 0) - prev.k,
        dd = (r.deaths | 0) - prev.d;
      for (let i = 0; i < dk; i++) killers.push(r.id);
      for (let i = 0; i < dd; i++) victims.push(r.id);
    }
    for (let key of mpPrevRows.keys())
      seen.has(key) || mpPrevRows.delete(key);
    for (let r of rows)
      mpPrevRows.set(String(r.id), { k: r.kills | 0, d: r.deaths | 0 });
    for (let i = 0; i < killers.length && i < victims.length; i++)
      mpFeedKill(killers[i], victims[i]);
  }
  function mpRespawnLeft() {
    // 权威读数：player.pvpRespawnState()（host/client 两端一致，pvp 重生本地驱动）；
    // 兜底：context.pvpRespawn 黑板约定 → respawn 载荷 deadline
    try {
      let st =
        context.player &&
        typeof context.player.pvpRespawnState == "function"
          ? context.player.pvpRespawnState()
          : null;
      if (st && typeof st.t == "number" && st.t > 0) return st.t;
    } catch {}
    let pr = context.pvpRespawn;
    if (typeof pr == "number" && pr > 0) return pr;
    if (pr && typeof pr == "object") {
      if (typeof pr.deadline == "number")
        return (pr.deadline - performance.now()) / 1e3;
      for (let key of ["t", "left", "sec", "in", "respawn"])
        if (typeof pr[key] == "number" && pr[key] > 0) return pr[key];
    }
    return mpRespDeadline ? (mpRespDeadline - performance.now()) / 1e3 : 0;
  }
  // ---- §11 敌方坐标提醒（MP-PVP 附录）：火力暴露罗盘威胁标 + 受击方向扇形 ----
  var THREAT_LIFE = 1.8, // 威胁标生命（1.8s 线性渐隐，同射手续射刷新）
    HIT_LIFE = 1.2; // 受击扇形生命（1.2s）
  function s11Pos(p) {
    // 载荷 pos 兼容 [x,y,z] / {x,y,z}（Vector3 字段形）→ 统一 {x,y,z}；坏形 null
    if (!p) return null;
    if (typeof p.x == "number" && typeof p.z == "number")
      return { x: p.x, y: typeof p.y == "number" ? p.y : 0, z: p.z };
    if (Array.isArray(p) && p.length >= 2)
      return { x: +p[0] || 0, y: +p[1] || 0, z: +p[2] || 0 };
    return null;
  }
  function s11ThreatShow(id, pos) {
    // 仅敌队开火上罗盘（§11.0 友军开火不标；自己/队伍未知一律静默——保守）
    if (!mpPvpOn()) return;
    let self = mpSelfId();
    if (id != null && id === self) return;
    let myT = mpMyTeam();
    if (myT == null) return;
    let t = mpTeamOf(id);
    if (t == null || t === myT) return;
    let p = s11Pos(pos);
    if (!p) return;
    let key = String(id),
      mk = mThreats.get(key);
    if (mk) {
      // 同一射手续射：位置跟进 + 生命重置（续射续曝，同位置续射刷新）
      (mk.pos.set(p.x, p.y, p.z), (mk.life = THREAT_LIFE));
      return;
    }
    mk = buildMark({
      id: id,
      kind: "threat",
      short: "敌火",
      label: "敌方火力",
      pos: new Vector3(p.x, p.y, p.z),
    });
    ((mk.life = THREAT_LIFE), (mk.op = -1), mThreats.set(key, mk));
  }
  function s11ClearThreats() {
    mThreats.size &&
      (mThreats.forEach((mk) => mk.cEl.remove()), mThreats.clear());
  }
  function s11ThreatTick(dt) {
    // 威胁标：距离米数 + 罗盘方位偏移（与主标记环同公式）+ 线性渐隐；过期摘除
    if (!mThreats.size) return;
    let ce = context.player;
    if (!ce || !ce.pos) return;
    let Pe = ((-ce.yaw * 180) / Math.PI) % 360;
    (Pe < 0 && (Pe += 360));
    let we = K / 2 - 14;
    mThreats.forEach((mk, key) => {
      mk.life -= dt;
      if (mk.life <= 0) {
        (mk.cEl.remove(), mThreats.delete(key));
        return;
      }
      let dx = mk.pos.x - ce.pos.x,
        dz = mk.pos.z - ce.pos.z,
        dist = Math.round(Math.hypot(dx, dz));
      if (dist !== mk.lastD) {
        (mk.lastD = dist), (mk.cDist.textContent = dist + "m");
      }
      let br = (Math.atan2(dx, -dz) * 180) / Math.PI - Pe;
      br = ((br + 540) % 360) - 180;
      let off = Math.round(Math.max(-we, Math.min(we, br * tx)));
      off !== mk.lastC &&
        ((mk.lastC = off),
        (mk.cEl.style.transform = `translate3d(${off}px,0,0)`),
        mk.cEl.classList.toggle("edge", Math.abs(off) >= we));
      let op =
        Math.round(Math.min(1, Math.max(0, mk.life / THREAT_LIFE)) * 20) / 20;
      op !== mk.op && ((mk.op = op), (mk.cEl.style.opacity = String(op)));
    });
  }
  function s11AngDiff(a, b) {
    let d = Math.abs(((a - b) % 360) + 360) % 360;
    return d > 180 ? 360 - d : d;
  }
  function s11HurtShow(pos) {
    // 受击扇形：方位角 = 本人 pos → 来弹 pos 水平角（视口系 0°=正前，与 h-arc 同式）；
    // 多方向叠加（3 槽），同向 ±22.5° 续击刷新，全忙替换剩命最少者
    if (!mpPvpOn()) return;
    let ce = context.player;
    if (!ce || !ce.pos) return;
    let p = s11Pos(pos);
    if (!p) return;
    let deg = Math.round(
      ((Math.atan2(p.x - ce.pos.x, -(p.z - ce.pos.z)) + (ce.yaw || 0)) *
        180) /
        Math.PI,
    );
    let slot = null;
    for (let s of phS)
      if (s.life > 0 && s.ang != null && s11AngDiff(s.ang, deg) <= 22.5) {
        slot = s;
        break;
      }
    if (!slot)
      for (let s of phS)
        if (s.life <= 0) {
          slot = s;
          break;
        }
    if (!slot) {
      slot = phS[0];
      for (let s of phS) s.life < slot.life && (slot = s);
    }
    ((slot.ang = deg),
      (slot.life = HIT_LIFE),
      deg !== slot.rot &&
        ((slot.rot = deg),
        (slot.el.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`)));
  }
  function s11HurtTick(dt) {
    for (let s of phS) {
      if (s.life <= 0) {
        s.op !== 0 && ((s.op = 0), (s.el.style.opacity = "0"));
        continue;
      }
      s.life -= dt;
      let op = Math.round(Math.max(0, Math.min(1, s.life / HIT_LIFE)) * 20) / 20;
      op !== s.op && ((s.op = op), (s.el.style.opacity = String(op)));
    }
  }
  function s11Poll() {
    // 黑板兜底通道（事件通道缺席/晚绑时）：pvpLastFire{id,pos} / pvpLastHitFrom
    // （{pos} 或裸 pos 形）；按对象身份去重——同一引用只消费一次，与事件通道
    // 重叠时威胁刷新幂等（HUD 只读黑板，绝不回灌）
    let f = context.pvpLastFire;
    if (f && f !== s11FireRef)
      ((s11FireRef = f), s11ThreatShow(f.id, f.pos != null ? f.pos : f));
    let h = context.pvpLastHitFrom;
    if (h && h !== s11HitRef)
      ((s11HitRef = h), s11HurtShow(h.pos != null ? h.pos : h));
  }
  function mpTeamColEl(label, cls, rows) {
    // Tab 板单侧队伍列（§10.2 按队分组两栏）：沿用 .h-mp-brow 行样式，
    // 名次号是全局序（跨队可比），队头带队伍色与人数
    let col = createElement("div", "h-mp-tcol " + cls),
      h = createElement("div", "h-mp-tcol-h"),
      list = createElement("div", "h-mp-tcol-rows");
    ((h.innerHTML = `<span>${label}</span><b>${rows.length}</b>`),
      col.append(h, list));
    rows.forEach((r) => {
      list.appendChild(
        createElement(
          "div",
          "h-mp-brow" +
            (r.rank === 1 && r.total > 1 ? " lead" : "") +
            (r.you ? " me" : ""),
          `<b>${r.rank}</b><span>${esc(r.name)}</span><i>${r.kills}</i><i>${r.deaths}</i>`,
        ),
      );
    });
    return col;
  }
  function mpPvpTick() {
    if (!mpPvpOn()) {
      (mpScoreEl.hidden || (mpScoreEl.hidden = !0),
        mpTeamsEl.hidden || (mpTeamsEl.hidden = !0),
        mpBoardEl.hidden || (mpBoardEl.hidden = !0),
        mpRespEl.hidden || (mpRespEl.hidden = !0),
        mpProtEl.hidden || (mpProtEl.hidden = !0),
        mpTabOn && (mpTabOn = !1),
        // §11 离开对抗模式：威胁标与受击扇形一并熄灭（合作/单机零残留）
        mThreats.size && s11ClearThreats());
      for (let s of phS)
        s.life > 0 &&
          ((s.life = 0), (s.op = 0), (s.el.style.opacity = "0"));
      return;
    }
    let raw = mpBoardNow(),
      rows = raw && raw.length ? mpSortedBoard(raw) : [];
    rows.forEach((r, idx) => ((r.rank = idx + 1), (r.total = rows.length)));
    rows.length && mpDiffFeed(rows);
    // 顶部计分条：有队伍比分（§10.2 context.pvpTeams 黑板）→「蓝 n — n 红」，
    // 己方队高亮描边；无则回退个人杀数小条（旧 FFA 房兼容）
    let teams = mpTeamsNow();
    if (teams) {
      let mine = mpMyTeam(),
        sig = teams.blue + "|" + teams.red + "|" + (mine == null ? "-" : mine);
      sig !== mpTeamsSig &&
        ((mpTeamsSig = sig),
        (mpTeamsB.textContent = String(teams.blue)),
        (mpTeamsR.textContent = String(teams.red)),
        (mpTeamsEl.className =
          "h-mp-score h-mp-tscore" +
          (mine === 0 ? " mine-blue" : mine === 1 ? " mine-red" : "")));
      ((mpTeamsEl.hidden = !1),
        mpScoreEl.hidden || (mpScoreEl.hidden = !0),
        mpScoreSig !== "" && (mpScoreSig = ""));
    } else {
      (mpTeamsEl.hidden = !0,
        mpTeamsSig !== "" && (mpTeamsSig = ""));
      // 顶部计分小条：左「你 N 杀」右「领先 玩家名 M」
      if (rows.length) {
        let self = mpSelfId(),
          you = null;
        for (let r of rows)
          if (r.you || r.id === self) {
            you = r;
            break;
          }
        let lead = rows[0],
          leadName = lead.you || lead.id === self ? "你" : lead.name,
          youK = you ? you.kills : 0,
          sig = youK + "|" + lead.kills + "|" + leadName;
        (sig !== mpScoreSig &&
          ((mpScoreSig = sig),
          (mpYou.textContent = `你 ${youK} 杀`),
          (mpLead.textContent = `领先 ${leadName} ${lead.kills}`)),
          (mpScoreEl.hidden = !1));
      } else
        (mpScoreEl.hidden = !0,
          mpScoreSig !== "" && (mpScoreSig = ""));
    }
    // 按住 Tab 计分板浮层（名次/名字/杀/死）；board 带 team → 蓝红两栏分组
    let hasTeam = !1;
    for (let r of rows)
      if (r.team != null) {
        hasTeam = !0;
        break;
      }
    if (mpTabOn && rows.length) {
      let sig =
        (hasTeam ? "T" : "S") +
        "|" +
        rows
          .map(
            (r) =>
              `${r.id}:${r.team == null ? "-" : r.team}:${r.kills}/${r.deaths}:${r.name}`,
          )
          .join("|");
      sig !== mpBoardSig &&
        ((mpBoardSig = sig),
        (mpBoardRows.textContent = ""),
        mpBoardRows.classList.toggle("teams", hasTeam),
        hasTeam
          ? mpBoardRows.append(
              mpTeamColEl("蓝队", "blue", rows.filter((r) => r.team !== 1)),
              mpTeamColEl("红队", "red", rows.filter((r) => r.team === 1)),
            )
          : rows.forEach((r, idx) => {
              mpBoardRows.append(
                createElement(
                  "div",
                  "h-mp-brow" +
                    (idx === 0 && rows.length > 1 ? " lead" : "") +
                    (r.you ? " me" : ""),
                  `<b>${idx + 1}</b><span>${esc(r.name)}</span><i>${r.kills}</i><i>${r.deaths}</i>`,
                ),
              );
            }));
      mpBoardEl.hidden = !1;
    } else
      (mpBoardEl.hidden = !0,
        mpBoardSig !== "" &&
          ((mpBoardSig = ""), mpBoardRows.classList.remove("teams")));
    // 重生保护（存活态，§10.0 3s 免疫；开火即失去——mpProtSup 快照比对）
    let protRef = context.pvpProt,
      alive = !!(context.player && context.player.alive !== !1),
      protLeft = alive && protRef && protRef !== mpProtSup ? mpProtLeft() : 0;
    if (protLeft > 0) {
      let num = protLeft.toFixed(1) + "s";
      num !== mpProtSig &&
        ((mpProtSig = num), (mpProtN.textContent = num));
      mpProtEl.hidden = !1;
    } else
      (mpProtEl.hidden = !0,
        mpProtSig !== "" && (mpProtSig = ""));
    // 重生倒计时（死亡态）
    let pl = context.player,
      dead = !!(pl && pl.alive === !1),
      left = dead ? mpRespawnLeft() : 0;
    if (dead && left > 0) {
      let num = String(Math.max(0, Math.ceil(left)));
      (num !== mpRespSig &&
        ((mpRespSig = num), (mpRespN.textContent = num)),
        (mpRespEl.hidden = !1));
    } else
      (mpRespEl.hidden = !0,
        mpRespSig !== "" && (mpRespSig = ""));
  }
  function mpOnPvpPayload(p) {
    // pvp 载荷分派（MP-PVP §8.1）：击杀流走 pvp:killed 本地事件（host 由
    // host-sim emitLocal、client 由 pvp-flow 载荷翻译，两端同源）；此处仅留
    // board 载荷缓存与重生 deadline 兜底（主读数 player.pvpRespawnState）。
    // §9.1 增补：killed 原始载荷直连击杀流——headshot:bool 是权威字段，翻译层
    // 未透传时爆头徽标不丢（中继不回声房主自身 fromHost，host 端此分支不触发，
    // 仍走 emitLocal 事件；两通道重叠由 mpDedupe 吸收，谁先到谁画）
    if (!p || p.k !== "pvp") return;
    if (p.e === "score" || p.e === "roundEnd")
      Array.isArray(p.board) && (mpPayloadBoard = p.board);
    else if (p.e === "killed")
      mpPvpOn() && mpFeedKill(p.by, p.victim, !!p.headshot);
    else if (p.e === "respawn")
      try {
        context.net.selfId() === p.id &&
          (mpRespDeadline =
            performance.now() + Math.max(0.2, +p.in || 3) * 1e3);
      } catch {}
  }
  function bindNet() {
    // 延迟绑定：context.net 可能晚于 HUD 装配（每帧重试一次，成功即停）
    if (netB) return;
    let nn = context.net;
    if (!nn || typeof nn.on != "function") return;
    netB = !0;
    try {
      nn.on("peerJoin", (ev) => {
        if (!Q) return;
        let n = ev && ev.player && ev.player.name;
        n && I.radio(n + " 已就位", 3, "小队频道");
      });
      nn.on("peerLeave", (ev) => {
        if (!Q) return;
        let n = ev && ev.player && ev.player.name;
        n && I.radio(n + " 掉线", 3, "小队频道");
      });
      nn.client &&
        typeof nn.client.onHostPayload == "function" &&
        nn.client.onHostPayload(mpOnPvpPayload);
    } catch {}
  }
  (addEventListener("resize", R),
    // Tab 计分板（对抗模式按住显示；面板/输入焦点/弹层打开时不抢占 Tab 键）
    addEventListener("keydown", (k) => {
      if (k.code !== "Tab" || k.defaultPrevented) return;
      if (!Q || !mpPvpOn()) return;
      let m = context.game && context.game.menus;
      if (m && m.panelOpen) return;
      let ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      (k.preventDefault(), (mpTabOn = !0));
    }),
    addEventListener("keyup", (k) => {
      k.code === "Tab" && (mpTabOn = !1);
    }),
    addEventListener("blur", () => (mpTabOn = !1)),
    context.events.on("player:hitEnemy", (k) => {
      // 爆头判定（§9.1）：显式 headshot:bool，或 pvp 视觉命中的 part==="head"
      // （hitbox.js 部位名；pvp 门内判定，合作敌判定 part 词汇不含 head，零回归）
      let hs = !!(k && (k.headshot || (k.pvp && k.part === "head")));
      (I.hitmarker(
        k && k.killed
          ? "kill"
          : hs
            ? "headshot"
            : k && (k.weak || k.part === "weak")
              ? "weak"
              : "hit",
        hs ? { headshot: !0 } : null,
      ),
        k &&
          k.killed &&
          k.weak &&
          fe &&
          le === context.time.frame &&
          !fe.weak &&
          ((fe.weak = !0), (fe.el.innerHTML += "<em>弱点命中</em>")));
    }),
    context.events.on("enemy:killed", (k) => {
      let ce = String(
        (k && (k.type || (k.enemy && k.enemy.type))) || "machine",
      ).toUpperCase();
      ce = ce === "GULL" ? "飞鸥" : ce === "HOUND" ? "猎犬" : "机器";
      let by = k && k.by,
        line = `<b>${ce}</b> 已击毁`;
      if (by != null) {
        let who = shooterName(by);
        line =
          who === "你"
            ? `你击毁 <b>${ce}</b>`
            : `${esc(who)}击毁 <b>${ce}</b>`;
      }
      ((fe = I.feed(line)), (le = context.time.frame));
    }),
    context.events.on("player:hit", (k) => {
      if (!k || !k.fromPos) return;
      let ce = b[0];
      for (let ve of b) {
        if (ve.life <= 0) {
          ce = ve;
          break;
        }
        ve.life < ce.life && (ce = ve);
      }
      (ce.src.copy(k.fromPos), (ce.life = 1.5), (ce.max = 1.5));
    }),
    // pvp 击杀流（MP-PVP §8.2 killfeed「A ▸ B」；§9.1 爆头徽标）：host-sim
    // emitLocal 与 pvp-flow 载荷翻译两端同源，此处统一消费
    context.events.on("pvp:killed", (ev) => {
      ev && mpPvpOn() && mpFeedKill(ev.by, ev.victim, !!ev.headshot);
    }),
    // §11 火力暴露：敌方开火 → 罗盘威胁标（pvp.js 载荷翻译 / host-sim emitLocal
    // 两端同源；敌队过滤在 s11ThreatShow 内按 net.myTeam 比对）
    context.events.on("pvp:enemyFire", (ev) => {
      ev && s11ThreatShow(ev.id, ev.pos);
    }),
    // §10.0 重生保护「开火立即解除」：本地开火即快照当前保护，同一保护不再上屏
    // （黑板清理由 T2 player.js 权威执行；此处仅表现层兜底，只读不回灌）
    context.events.on("weapon:fire", () => {
      context.pvpProt && (mpProtSup = context.pvpProt);
    }));
  // ---- 标记构建（中继/撤离 + 队友共用；队友标记持有 rp 活位姿引用，逐帧免重建） ----
  function buildMark(ce) {
    let ve = createElement(
        "div",
        "h-cm " + (ce.kind || "relay"),
        `<i></i><b>${ce.short || ""}</b><span></span>`,
      ),
      // §11 威胁标只上罗盘（§11.0 不做穿墙世界标记——不建 h-wm 投影）
      _e =
        ce.kind === "threat"
          ? null
          : createElement(
              "div",
              "h-wm " + (ce.kind || "relay"),
              `<i></i><b>${ce.short || ""}</b><span></span>`,
            );
    return (
      a.appendChild(ve),
      _e && G.appendChild(_e),
      {
        ...ce,
        cEl: ve,
        wEl: _e,
        cDist: ve.querySelector("span"),
        wDist: _e ? _e.querySelector("span") : null,
        lastD: -1,
        lastC: 1e9,
        lastW: "",
        vis: null,
      }
    );
  }
  function mateCss(m) {
    // rp.publicView().color 是 number（SLOT_COLORS 位色）；转 CSS 色串
    return typeof m.color == "number"
      ? "#" + m.color.toString(16).padStart(6, "0")
      : null;
  }
  function refreshMates() {
    // 4Hz 低频对账：列表增删/改名/换色重建，位置由 update 内的活 Vector3 引用驱动
    let rp = context.remotePlayers,
      list = [];
    if (rp && typeof rp.list == "function") {
      try {
        list = rp.list() || [];
      } catch {
        list = [];
      }
    }
    let seen = new Set(),
      changed = !1;
    for (let k of list) {
      if (!k || k.id == null || k.aboard || !k.pos) continue; // 登船撤离后不再标位；无位姿样本不建标
      let enemy = false;
      if (mpPvpOn()) {
        let mine = mpMyTeam(), team = mpTeamOf(k.id);
        // 队伍信息未同步前按敌方处理，避免先显示名字再撤回。
        if (mine !== 0 && mine !== 1 || team == null) enemy = true;
        else enemy = team !== mine;
      }
      let key = String(k.id),
        mk = mMates.get(key);
      if (mk && mk.isEnemy !== enemy) {
        mk.cEl.remove();
        mk.wEl && mk.wEl.remove();
        mMates.delete(key);
        mk = null;
        changed = !0;
      }
      // CF 式团队对抗：敌方没有常驻世界名牌，也不因准星接近临时显示红名。
      // 敌方位置只通过开火威胁罗盘、命中反馈和击杀流暴露。
      if (enemy) {
        seen.add(key);
        continue;
      }
      if (!mk) {
        mk = buildMark({
          id: k.id,
          kind: "mate",
          short: k.name || "",
          label: k.name || "队友",
          pos: k.pos,
        });
        mk.isEnemy = false;
        mk.mateDown = k.alive === !1;
        mk.mateCol = mateCss(k);
        mk.cEl.classList.toggle("down", mk.mateDown);
        mk.wEl && mk.wEl.classList.toggle("down", mk.mateDown);
        if (mk.mateCol)
          ((mk.cEl.style.color = mk.mateCol),
            mk.wEl && (mk.wEl.style.color = mk.mateCol));
        mMates.set(key, mk);
        changed = !0;
      } else {
        if (k.name && k.name !== mk.short) {
          let cb = mk.cEl.querySelector("b"),
            wb = mk.wEl.querySelector("b");
          ((mk.short = k.name),
            (mk.label = k.name),
            cb && (cb.textContent = k.name),
            wb && (wb.textContent = k.name));
        }
        k.pos && (mk.pos = k.pos);
        let down = k.alive === !1;
        if (down !== mk.mateDown)
          ((mk.mateDown = down),
            mk.cEl.classList.toggle("down", down),
            mk.wEl && mk.wEl.classList.toggle("down", down));
        let col = mateCss(k);
        if (col && col !== mk.mateCol)
          ((mk.mateCol = col),
            (mk.cEl.style.color = col),
            mk.wEl && (mk.wEl.style.color = col));
      }
      seen.add(key);
    }
    mMates.forEach((mk, key) => {
      if (!seen.has(key))
        (mk.cEl.remove(), mk.wEl.remove(), mMates.delete(key), (changed = !0));
    });
    if (changed) J = mBase.concat(Array.from(mMates.values()));
    // 电台行：ps flags 上升沿（阵亡/登船）——走 radio() 现有队列
    for (let k of list) {
      if (!k || k.id == null) continue;
      let key = String(k.id),
        prev = mFlags.get(key);
      if (!prev) {
        mFlags.set(key, {
          alive: k.alive !== !1,
          aboard: !!k.aboard,
          name: k.name || "队友",
        });
        continue;
      }
      prev.alive &&
        k.alive === !1 &&
        I.radio(prev.name + " 阵亡", 3, "小队频道");
      !prev.aboard &&
        k.aboard &&
        I.radio(prev.name + " 已登船", 3, "小队频道");
      if (k.name) prev.name = k.name;
      prev.alive = k.alive !== !1;
      prev.aboard = !!k.aboard;
    }
    let liveIds = new Set(
      list.filter((k) => k && k.id != null).map((k) => String(k.id)),
    );
    mFlags.forEach((v, key) => {
      liveIds.has(key) || mFlags.delete(key);
    });
  }
  let I = {
    root: t,
    show(k) {
      ((k = !!k), k !== Q && ((Q = k), t.classList.toggle("on", k), k && R()));
    },
    setObjective(k) {
      ((k = k || ""),
        k !== re &&
          ((re = k),
          ($ = 0),
          (ue = 0),
          (u.textContent = ""),
          c.classList.toggle("has", !!k),
          c.classList.remove("flash"),
          c.offsetWidth,
          c.classList.add("flash")));
    },
    setRelays(k, ce) {
      if (!(k === X.done && ce === X.total)) {
        if (ce !== X.total) {
          (p.forEach((ve) => ve.remove()), (p = []));
          for (let ve = 0; ve < ce; ve++) {
            let _e = document.createElement("i");
            (h.insertBefore(_e, f), p.push(_e));
          }
        }
        ((X.done = k),
          (X.total = ce),
          p.forEach((ve, _e) => ve.classList.toggle("cut", _e < k)),
          (f.textContent = `${k}/${ce}`),
          h.classList.toggle("all", k >= ce && ce > 0));
      }
    },
    setMarkers(k) {
      // flow 的基准标记（中继/撤离）+ 队友标记（refreshMates 维护）合并成一套渲染
      for (let ce of J) (ce.cEl.remove(), ce.wEl.remove());
      mBase = (k || []).map((ce) => buildMark(ce));
      J = mBase.concat(Array.from(mMates.values()));
    },
    setPrompt(k, ce = 0) {
      let ve = !!k;
      if (
        (ve !== X.promptOn &&
          ((X.promptOn = ve),
          m.classList.toggle("on", ve),
          context.input.setPrompt && context.input.setPrompt(ve)),
        !ve)
      )
        return;
      let _e = context.input.touch
        ? "USE"
        : context.input.gamepad && !context.input.locked
          ? "Y"
          : "E";
      _e !== X.promptKey &&
        ((X.promptKey = _e),
        (_.textContent = _e),
        _.classList.toggle("wide", _e.length > 1));
      let Te = `\u6309\u4f4f${_e} \u2014 ${k}`;
      Te !== X.promptText && ((X.promptText = Te), (M.textContent = Te));
      let Pe = Math.round(ce * 200) / 200;
      Pe !== X.promptT &&
        ((X.promptT = Pe),
        A.setAttribute("stroke-dashoffset", (ix * (1 - Pe)).toFixed(2)),
        m.classList.toggle("busy", Pe > 0));
    },
    radio(k, ce = 4.5, who) {
      k &&
        me.push({
          text: k,
          secs: ce,
          who: who || null,
        });
    },
    clearRadio() {
      ((me.length = 0),
        (ee = null),
        j.classList.remove("on"),
        jW && (jW.textContent = "指挥部"));
    },
    warn(k, ce = 3) {
      ((d.textContent = k),
        (Y = ce),
        d.classList.remove("on"),
        d.offsetWidth,
        d.classList.add("on"));
    },
    message(k, ce = 3) {
      ((w.textContent = k || ""),
        (L = k ? ce : 0),
        w.classList.toggle("on", !!k));
    },
    feed(k) {
      let ce = createElement("div", "h-fl", k);
      E.appendChild(ce);
      let ve = {
        el: ce,
        life: 4.2,
        weak: !1,
      };
      for (Z.push(ve); Z.length > 4;) Z.shift().el.remove();
      return ve;
    },
    hitmarker(k = "hit", o) {
      // 爆头高亮变体（§9.1）：配色/辉光由 ui.css .h-hit.headshot i 承担（集成者
      // 已落样式，内联兜底拆除防双源漂移）；kill/weak 既有配色优先不让位。
      let hs =
        (k === "headshot" || (o && o.headshot)) &&
        k !== "kill" &&
        k !== "weak";
      x.className = "h-hit " + (hs && k === "hit" ? "headshot" : k);
      let ce = k === "weak" || k === "kill" || hs ? 1.5 : 1.15;
      try {
        x.animate(
          [
            {
              opacity: 1,
              transform: `translate(-50%,-50%) scale(${ce})`,
            },
            {
              opacity: 1,
              transform: "translate(-50%,-50%) scale(1)",
              offset: 0.35,
            },
            {
              opacity: 0,
              transform: "translate(-50%,-50%) scale(0.92)",
            },
          ],
          {
            duration: k === "kill" ? 420 : 240,
            easing: "ease-out",
          },
        );
      } catch {}
    },
    reset() {
      ((me.length = 0), (ee = null), j.classList.remove("on"));
      mMates.forEach((ce) => (ce.cEl.remove(), ce.wEl.remove()));
      (mMates.clear(), mFlags.clear(), (J = mBase.slice()));
      // §11 威胁标/受击扇形复位（黑板引用一并清，防跨局残留）
      (s11ClearThreats(), (s11FireRef = null), (s11HitRef = null));
      for (let s of phS) {
        (s.life = 0), (s.op = 0), (s.ang = null), (s.el.style.opacity = "0");
      }
      for (let k of Z) k.el.remove();
      Z.length = 0;
      for (let k of b) k.life = 0;
      ((Y = 0),
        d.classList.remove("on"),
        I.message(""),
        I.setPrompt(null),
        I.setObjective(""),
        (X.hp = -1),
        // 对抗模式状态复位（pvp-flow 的 context.pvpBoard 由其自管）
        (mpPayloadBoard = null),
        mpPrevRows.clear(),
        mpDedupe.clear(),
        (mpRespDeadline = 0),
        (mpTabOn = !1),
        (mpScoreSig = ""),
        (mpTeamsSig = ""),
        (mpBoardSig = ""),
        (mpRespSig = ""),
        (mpProtSig = ""),
        (mpProtSup = null),
        mpBoardRows.classList.remove("teams"),
        (mpScoreEl.hidden = !0),
        (mpTeamsEl.hidden = !0),
        (mpBoardEl.hidden = !0),
        (mpRespEl.hidden = !0),
        (mpProtEl.hidden = !0));
    },
    update: se,
  };
  function se(k) {
    (bindNet(), mT > 0.25 ? ((mT = 0), refreshMates()) : (mT += k));
    // §11 黑板兜底通道 + 威胁标/受击扇形生命衰减（HUD 隐藏也照走，防残留）
    (s11Poll(), s11ThreatTick(k), s11HurtTick(k));
    if ((ae(k), !Q)) return;
    mpPvpTick();
    let ce = context.player,
      ve = context.weapon || {},
      _e = context.camera,
      Te = ce.ads || 0,
      Pe = ((-ce.yaw * 180) / Math.PI) % 360;
    Pe < 0 && (Pe += 360);
    let Re = Math.round((K / 2 - (Pe - nx) * tx) * 2) / 2;
    Re !== X.tapeX &&
      ((X.tapeX = Re), (s.style.transform = `translate3d(${Re}px,0,0)`));
    let Fe = Math.round(Pe) % 360;
    Fe !== X.head &&
      ((X.head = Fe), (l.textContent = String(Fe).padStart(3, "0")));
    let ze = Te < 0.5;
    if (
      (ze !== X.marksOn && ((X.marksOn = ze), G.classList.toggle("off", !ze)),
      J.length)
    ) {
      (_e.updateMatrixWorld(),
        _e.matrixWorldInverse.copy(_e.matrixWorld).invert());
      let we = K / 2 - 14;
      for (let be of J) {
        let Oe = be.pos.x - ce.pos.x,
          pt = be.pos.z - ce.pos.z,
          ut = Math.round(Math.hypot(Oe, pt));
        if (ut !== be.lastD) {
          be.lastD = ut;
          let Un = ut + "m";
          ((be.cDist.textContent = Un), (be.wDist.textContent = Un));
        }
        let nn = (Math.atan2(Oe, -pt) * 180) / Math.PI - Pe;
        nn = ((nn + 540) % 360) - 180;
        let bt = Math.round(Math.max(-we, Math.min(we, nn * tx)));
        (bt !== be.lastC &&
          ((be.lastC = bt),
          (be.cEl.style.transform = `translate3d(${bt}px,0,0)`),
          be.cEl.classList.toggle("edge", Math.abs(bt) >= we)),
          oe
            .set(
              be.pos.x,
              be.pos.y + (be.kind === "extract" ? 1.2 : 1.9),
              be.pos.z,
            )
            .project(_e));
        let Os,
          pn,
          Ti = !1;
        if (
          (oe.z > 1 && ((Ti = !0), (oe.x = -oe.x), (oe.y = -oe.y)),
          Ti || Math.abs(oe.x) > 0.9 || Math.abs(oe.y) > 0.82)
        ) {
          Ti = !0;
          let Un = Math.max(Math.abs(oe.x) / 0.9, Math.abs(oe.y) / 0.82, 0.001);
          if (((oe.x /= Un), (oe.y /= Un), oe.z > 1)) {
            let zo = Math.max(Math.abs(oe.x) / 0.9, Math.abs(oe.y) / 0.82);
            zo < 0.999 && ((oe.x /= zo), (oe.y /= zo));
          }
        }
        ((Os = Math.round((oe.x * 0.5 + 0.5) * ie)),
          (pn = Math.round((-oe.y * 0.5 + 0.5) * F)));
        let ho = !Ti && Math.hypot(oe.x, oe.y * 0.6) < 0.16,
          // CF 式对抗：敌方名牌始终隐藏；敌方位置只由开火威胁罗盘等短时反馈暴露。
          enemyVisible = be.kind !== "enemy",
          Rs =
            Os +
            "," +
            pn +
            (Ti ? "o" : "") +
            (ut < 3 ? "n" : "") +
            (ho ? "d" : "");
        let renderKey = Rs + (enemyVisible ? "v" : "h");
        renderKey !== be.lastW &&
          ((be.lastW = renderKey),
          (be.wEl.style.transform = `translate3d(${Os}px,${pn}px,0)`),
          be.wEl.classList.toggle("offscreen", Ti),
          be.wEl.classList.toggle("near", ut < 3),
          be.wEl.classList.toggle("dim", ho),
          be.wEl.classList.toggle("enemy-hidden", !enemyVisible));
      }
    }
    let We = Te <= 0.6 && ce.alive && ve.state !== "reloading_hidden";
    if (
      (We !== X.crossOn && ((X.crossOn = We), v.classList.toggle("off", !We)),
      We)
    ) {
      let we = typeof ve.spread == "number" ? ve.spread : 0.012,
        be = (_e.fov * Math.PI) / 360,
        Oe =
          (Math.tan(we) / Math.tan(be)) * (F / 2) + 4 + (ce.sprinting ? 10 : 0);
      ((Oe = Math.round(Math.max(4, Math.min(70, Oe)) * 2) / 2),
        Oe !== X.gap &&
          ((X.gap = Oe),
          (g[0].style.transform = `translate3d(-50%,${-Oe}px,0) translateY(-100%)`),
          (g[1].style.transform = `translate3d(-50%,${Oe}px,0)`),
          (g[2].style.transform = `translate3d(${-Oe}px,-50%,0) translateX(-100%)`),
          (g[3].style.transform = `translate3d(${Oe}px,-50%,0)`)));
    }
    let Ne = Math.max(1, Math.min(60, ve.magSize | 0 || 30)),
      dt = Math.max(0, ve.ammo | 0),
      // \u00a710.0 \u65e0\u9650\u5f39\u836f\uff08\u4ec5\u5bf9\u6297\uff09\uff1aweapon.js pvp \u95e8\u4e0b reserve=Infinity\u2014\u2014\u4f4d\u8fd0\u7b97
      // \u4f1a\u628a Infinity \u622a\u6210 0\uff0c\u5148\u8bc6\u522b\u518d\u5f52\u4e00\uff1bpvp \u623f\u5185\u5907\u5f39\u4f4d\u4e00\u5f8b\u6309 \u221e \u663e\u793a
      rawRes = ve.reserve,
      xe =
        typeof rawRes == "number" && !isFinite(rawRes) && rawRes > 0
          ? Infinity
          : Math.max(0, rawRes | 0),
      infAmmo = mpPvpOn() || xe === Infinity;
    if (
      (Ne !== X.mag &&
        ((X.mag = Ne),
        (T.innerHTML = "<i></i>".repeat(Ne)),
        (ne = [...T.children]),
        (X.ammo = -1)),
      dt !== X.ammo)
    ) {
      ((X.ammo = dt), (q.textContent = String(dt).padStart(2, "0")));
      for (let we = 0; we < ne.length; we++)
        ne[we].className = we < dt ? "" : "off";
    }
    let rsTxt = infAmmo ? "\u221e" : String(xe).padStart(3, "0");
    (rsTxt !== X.reserve &&
      ((X.reserve = rsTxt),
        (U.textContent = rsTxt),
        U.classList.toggle("inf", infAmmo)),
      ve.name !== X.name &&
        ((X.name = ve.name), (D.textContent = ve.name || "")));
    let Ie = dt <= Math.ceil(Ne * 0.27),
      Be =
        ve.state === "reloading"
          ? "\u6362\u5f39\u4e2d"
          : dt === 0
            ? infAmmo || xe > 0
              ? context.input.touch
                ? "\u6362\u5f39"
                : "R \u2014 \u6362\u5f39"
              : "\u5f39\u5c3d"
            : Ie
              ? "\u5f39\u836f\u4e0d\u8db3"
              : "";
    (Be !== X.cue &&
      ((X.cue = Be),
      (C.textContent = Be),
      (C.className =
        "h-cue" +
        (Be ? " on" : "") +
        (dt === 0 && ve.state !== "reloading" ? " urgent" : ""))),
      Ie !== X.low && ((X.low = Ie), O.classList.toggle("low", Ie)));
    let Xe = Math.max(0, Math.ceil(ce.health)),
      Me = ce.health < ce.maxHealth - 0.5;
    if (Xe !== X.hp) {
      ((X.hp = Xe), (z.textContent = String(Xe)));
      let we = Math.ceil((Xe / ce.maxHealth) * H.length);
      if (we !== X.hpSeg) {
        X.hpSeg = we;
        for (let be = 0; be < H.length; be++)
          H[be].className = be < we ? "" : "off";
        S.classList.toggle("crit", we <= 3);
      }
    }
    Me !== X.hurt && ((X.hurt = Me), S.classList.toggle("on", Me));
    for (let we of b) {
      if (we.life <= 0) {
        we.op !== 0 && ((we.op = 0), (we.el.style.opacity = "0"));
        continue;
      }
      we.life -= k;
      let be = Math.atan2(we.src.x - ce.pos.x, -(we.src.z - ce.pos.z)) + ce.yaw,
        Oe = Math.round((be * 180) / Math.PI);
      Oe !== we.rot &&
        ((we.rot = Oe),
        (we.el.style.transform = `translate(-50%,-50%) rotate(${Oe}deg)`));
      let pt = Math.round(Math.min(1, Math.max(0, we.life / 0.6)) * 20) / 20;
      pt !== we.op && ((we.op = pt), (we.el.style.opacity = String(pt)));
    }
    if ($ < re.length) {
      ue += k * 10;
      let we = Math.min(re.length, Math.floor(ue));
      we !== $ && (($ = we), (u.textContent = re.slice(0, we)));
    }
    (Y > 0 && ((Y -= k), Y <= 0 && d.classList.remove("on")),
      L > 0 && ((L -= k), L <= 0 && w.classList.remove("on")));
    for (let we = Z.length - 1; we >= 0; we--) {
      let be = Z[we];
      ((be.life -= k),
        be.life <= 0
          ? (be.el.remove(), Z.splice(we, 1))
          : be.life < 0.6 &&
            !be.out &&
            ((be.out = !0), be.el.classList.add("out")));
    }
  }
  function ae(k) {
    if (!ee) {
      if (!me.length) return;
      ((ee = me.shift()),
        (B = 0),
        (P = 0),
        (V = ee.secs),
        (N.textContent = ""),
        jW && (jW.textContent = ee.who || "指挥部"),
        j.classList.add("on"),
        context.events.emit("radio:line", {
          text: ee.text,
        }));
    }
    let ce = ee.text;
    if (B < ce.length) {
      P += k * 12;
      let ve = Math.min(ce.length, Math.floor(P));
      ve !== B && ((B = ve), (N.textContent = ce.slice(0, ve)));
    } else
      ((V -= k),
        V <= 0 && ((ee = null), me.length || j.classList.remove("on")));
  }
  return (R(), I);
}

export { createHUD, createElement };
