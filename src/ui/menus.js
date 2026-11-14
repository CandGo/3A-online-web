// DOM menus, persisted settings and controls panels.
import { PLAYER_DIMENSIONS, QUALITY_PRESETS } from "../core/config.js";
import { DEFAULT_PORT } from "../net/protocol.js";
import { scanLan as lanScanMod, getLocalSubnet as lanSubnetMod } from "../net/lan-scan.js";

var SETTINGS_KEY = "saltline.settings.v1";

// ---- 多人模式（MP）：昵称持久化与玩家位配色 ----
// 位色四色必须与 src/net/remote-players.js 的 SLOT_COLORS 逐值对齐（青/橙/紫/黄）。
var MP_NAME_KEY = "saltline.mp.name";

var MP_SLOT_COLORS = [0x2ee6d6, 0xff8a3c, 0xb45cff, 0xffd84d];

function defaultCallsign() {
  let h = "";
  for (let i = 0; i < 4; i++) h += "0123456789ABCDEF"[(Math.random() * 16) | 0];
  return "破障手-" + h;
}

function loadPlayerName() {
  try {
    let v = (localStorage.getItem(MP_NAME_KEY) || "").trim().slice(0, 24);
    if (v) return v;
  } catch {}
  let d = defaultCallsign();
  try {
    localStorage.setItem(MP_NAME_KEY, d);
  } catch {}
  return d;
}

var DEFAULT_SETTINGS = {
  quality: "auto",
  sens: 1,
  invertY: !1,
  volume: 0.8,
  fov: PLAYER_DIMENSIONS.fov,
};

var QUALITY_NAMES = ["low", "medium", "high", "ultra"];

var QUALITY_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  ultra: "极高",
};

function loadSettings() {
  let i = {
    ...DEFAULT_SETTINGS,
  };
  try {
    let e = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    e &&
      typeof e == "object" &&
      ((e.quality === "auto" || QUALITY_NAMES.includes(e.quality)) &&
        (i.quality = e.quality),
      Number.isFinite(e.sens) && (i.sens = Math.min(3, Math.max(0.2, e.sens))),
      (i.invertY = !!e.invertY),
      Number.isFinite(e.volume) &&
        (i.volume = Math.min(1, Math.max(0, e.volume))),
      Number.isFinite(e.fov) && (i.fov = Math.min(95, Math.max(60, e.fov))));
  } catch {}
  return i;
}

function saveSettings(i) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(i));
  } catch {}
}

var KEYBOARD_CONTROLS_HTML = `
  <dl class="keys">
    <div><dt>移动</dt><dd><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dd></div>
    <div><dt>视角</dt><dd>鼠标</dd></div>
    <div><dt>开火</dt><dd>左键</dd></div>
    <div><dt>瞄准</dt><dd>右键</dd></div>
    <div><dt>换弹</dt><dd><kbd>R</kbd></dd></div>
    <div><dt>切断中继</dt><dd>按住 <kbd>E</kbd></dd></div>
    <div><dt>跳跃</dt><dd><kbd>Space</kbd></dd></div>
    <div><dt>冲刺</dt><dd><kbd>Shift</kbd></dd></div>
    <div><dt>蹲伏</dt><dd><kbd>C</kbd> 或 <kbd>Ctrl</kbd></dd></div>
    <div><dt>近战</dt><dd><kbd>F</kbd></dd></div>
    <div><dt>暂停</dt><dd><kbd>Esc</kbd> 或 <kbd>P</kbd></dd></div>
  </dl>`;

var TOUCH_CONTROLS_HTML = `
  <dl class="keys">
    <div><dt>移动</dt><dd>左侧固定虚拟摇杆</dd></div>
    <div><dt>视角</dt><dd>右半屏拖动</dd></div>
    <div><dt>开火</dt><dd>右下「开火」键，可边按边拖视角</dd></div>
    <div><dt>瞄准</dt><dd>「瞄准」为切换开关</dd></div>
    <div><dt>换弹</dt><dd>右侧「换弹」</dd></div>
    <div><dt>跳跃 / 蹲伏</dt><dd>右侧动作键</dd></div>
    <div><dt>切断中继</dt><dd>在中继旁按住「使用」</dd></div>
    <div><dt>冲刺</dt><dd>摇杆推满即冲刺</dd></div>
  </dl>`;

function createMenus(context, e) {
  let t = document.getElementById("ui"),
    n = loadSettings(),
    s = document.createElement("div");
  ((s.className = "menu"),
    (s.dataset.screen = "none"),
    (s.innerHTML = `
    <div class="m-veil"></div>
    <div class="m-bars"><i></i><i></i></div>

    <section class="m-screen m-title" data-s="title" aria-label="Saltline">
      <div class="m-title-main">
        <div class="m-eyebrow"><span class="m-tag">B4</span><span>\u6e2f\u52a1\u5c40\u7834\u969c\u5206\u961f</span><span class="m-dim">Saltline\u6e2f\u533a \xB7 05:42</span></div>
        <h1 class="m-word">SALTLINE</h1>
        <p class="m-premise">\u6e2f\u533a\u5b89\u9632\u7f51\u5df2\u7ecf\u5931\u63a7\u3002\u5207\u65ad\u5b83\u7684\u4e09\u6761\u4e0a\u884c\u94fe\u8def\u3002\u767b\u4e0a\u90a3\u8258\u8239\u3002</p>
        <div class="m-actions">
          <button class="btn primary" data-act="deploy">开始行动</button>
          <button class="btn" data-act="host">创建房间</button>
          <button class="btn" data-act="join">加入房间</button>
          <button class="btn" data-act="p2p-lobby">零服务器大厅</button>
          <button class="btn" data-act="settings">设置</button>
          <button class="btn m-only-narrow" data-act="controls">操作</button>
        </div>
        <p class="m-note">所有场景、机械与音效均在你的浏览器中实时生成，不下载任何资源。</p>
      </div>
      <aside class="m-legend" aria-label="操作速查">
        <div><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动</span><span><kbd>Mouse</kbd> 视角</span><span><kbd>LMB</kbd> 开火</span><span><kbd>RMB</kbd> 瞄准</span><span><kbd>R</kbd> 换弹</span></div>
        <div><span><kbd>E</kbd> 切断中继</span><span><kbd>Space</kbd> 跳跃</span><span><kbd>Shift</kbd> 冲刺</span><span><kbd>C</kbd> 蹲伏</span><span><kbd>Esc</kbd> 暂停</span></div>
        <div class="lg-touch"><em>触屏</em><span>左手拇指移动</span><span>右手拇指视角</span><span>开火 \xB7 瞄准 \xB7 换弹 \xB7 跳跃均在屏幕上</span></div>
      </aside>
    </section>

    <section class="m-screen m-card m-p2p-lobby" data-s="p2p-lobby" aria-label="零服务器大厅">
      <div class="m-k">零服务器 · 公共大厅</div>
      <div class="m-p2p-lobby-head">
        <div>
          <h2 class="m-h">房间列表</h2>
          <p class="m-p2p-lobby-sub">浏览器之间直接同步，不需要固定服务器。</p>
        </div>
        <div class="m-p2p-lobby-stats" aria-label="大厅统计">
          <span><b data-f="p2p-lobby-online">0</b><small>在线</small></span>
          <span><b data-f="p2p-lobby-rooms">0</b><small>房间</small></span>
        </div>
      </div>
      <div class="m-p2p-lobby-toolbar">
        <button class="btn primary" data-act="p2p-lobby-host">创建房间</button>
        <button class="btn" data-act="p2p-lobby-refresh" data-f="p2p-lobby-refresh">刷新列表</button>
      </div>
      <div class="m-p2p-lobby-list" data-f="p2p-lobby-list" role="list"></div>
      <p class="m-p2p-directory-empty" data-f="p2p-lobby-empty">正在连接目录…</p>
      <div class="m-p2p-lobby-join">
        <label for="p2p-lobby-code">房间号加入</label>
        <div class="m-p2p-code-row">
          <input id="p2p-lobby-code" data-f="p2p-lobby-code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AB12" aria-label="零服务器房间号">
          <button type="button" class="btn small" data-act="p2p-lobby-join" data-f="p2p-lobby-join" disabled>加入</button>
        </div>
      </div>
      <div class="m-actions col">
        <button class="btn" data-act="p2p-lobby-back">返回主页</button>
      </div>
    </section>

    <section class="m-screen m-card" data-s="paused" aria-label="已暂停">
      <div class="m-k">行动暂停</div>
      <h2 class="m-h">已暂停</h2>
      <p class="m-line" data-f="lookmode"></p>
      <div class="m-actions col">
        <button class="btn primary" data-act="resume">继续</button>
        <button class="btn" data-act="settings">设置</button>
        <button class="btn" data-act="controls">操作</button>
        <button class="btn" data-act="restart">重开任务</button>
      </div>
    </section>

    <section class="m-screen m-card m-dead" data-s="dead" aria-label="信号中断">
      <div class="m-k" data-f="dead-k">破障手阵亡</div>
      <h2 class="m-h">信号中断</h2>
      <dl class="m-stats" data-f="dead-stats"><div><dt>存活时间</dt><dd data-f="dead-time">00:00</dd></div><div><dt>已切中继</dt><dd data-f="dead-relays">0/3</dd></div></dl>
      <div class="m-actions col" data-f="dead-actions"><button class="btn primary" data-act="retry">重试</button></div>
      <div class="m-dead-pvp" data-f="dead-pvp" hidden>
        <p class="m-respawn-by" data-f="dead-by"></p>
        <b class="m-respawn-n" data-f="dead-respawn">3</b>
        <span class="m-respawn-k">重新部署</span>
      </div>
    </section>

    <section class="m-screen m-card m-debrief" data-s="complete" aria-label="行动简报">
      <div class="m-k">4号泊位 \xB7 行动简报</div>
      <h2 class="m-h">Saltline全网断电</h2>
      <div class="m-rating"><span data-f="rating-k">评级</span><b data-f="rating">干净利落</b></div>
      <dl class="m-stats">
        <div><dt>用时</dt><dd data-f="time">00:00</dd></div>
        <div><dt>命中率</dt><dd data-f="acc">0%</dd></div>
        <div><dt>击毁机器</dt><dd data-f="kills">0</dd></div>
        <div><dt>重试次数</dt><dd data-f="retries">0</dd></div>
      </dl>
      <div class="m-team" data-f="team" hidden>
        <div class="m-team-h">小队战绩</div>
        <div class="m-team-list" data-f="team-list"></div>
      </div>
      <div class="m-actions col"><button class="btn primary" data-act="redeploy">再次部署</button></div>
    </section>

    <section class="m-screen m-card m-roundend" data-s="roundend" aria-label="对抗结算">
      <div class="m-k" data-f="roundend-k">港区对抗 \xB7 结算</div>
      <h2 class="m-h">回合结束</h2>
      <p class="m-roundend-sub" data-f="roundend-sub"></p>
      <div class="m-roundend-team" data-f="roundend-team" hidden>
        <div class="m-ts">
          <span class="t-blue">蓝队</span><b class="n-blue" data-f="roundend-blue">0</b>
          <span class="ts-sep">:</span>
          <b class="n-red" data-f="roundend-red">0</b><span class="t-red">红队</span>
        </div>
        <div class="m-ts-banner" data-f="roundend-banner" hidden>平局</div>
      </div>
      <div class="m-rank">
        <div class="m-rank-h"><span>名次</span><span>呼号</span><b>击杀</b><b>阵亡</b></div>
        <div class="m-rank-list" data-f="roundend-list"></div>
      </div>
      <div class="m-actions col"><button class="btn primary" data-act="mp-lobby">返回房间</button></div>
    </section>

    <section class="m-screen m-card m-lobby" data-s="lobby" aria-label="联机大厅">
      <div class="m-k">港区中继站 · 联机大厅</div>
      <div class="m-room">
        <span class="m-room-k">房间码</span>
        <b class="m-room-code" data-f="lobby-code">----</b>
        <span class="m-mode-badge coop" data-f="lobby-mode" hidden>合作模式</span>
        <button class="btn small" data-act="copy-code">复制</button>
      </div>
      <div class="m-squad">
        <div class="m-squad-h"><span>突击小队</span><b data-f="lobby-count">1/4</b></div>
        <ul class="m-roster" data-f="lobby-roster"></ul>
        <div class="m-teams" data-f="lobby-teams" hidden>
          <div class="m-team-col blue">
            <div class="m-team-col-h"><i class="tdot"></i><span>蓝队</span><b data-f="lobby-blue-n">0</b></div>
            <ul class="m-roster" data-f="lobby-blue"></ul>
          </div>
          <div class="m-team-col red">
            <div class="m-team-col-h"><i class="tdot"></i><span>红队</span><b data-f="lobby-red-n">0</b></div>
            <ul class="m-roster" data-f="lobby-red"></ul>
          </div>
        </div>
        <p class="m-lobby-hint" data-f="lobby-hint"></p>
      </div>
      <div class="m-actions col">
        <button class="btn primary" data-act="mp-start" data-f="lobby-start" disabled>开始行动</button>
        <button class="btn" data-act="mp-leave">离开房间</button>
      </div>
    </section>

    <div class="panel" role="dialog" aria-modal="true" aria-label="设置与操作" tabindex="-1" hidden>
      <header class="panel-h">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="settings" aria-selected="true">设置</button>
          <button class="tab" role="tab" data-tab="controls" aria-selected="false">操作</button>
        </div>
        <button class="btn small" data-act="close-panel">关闭</button>
      </header>
      <div class="panel-b" data-pane="settings">
        <div class="row"><label id="l-q">画质</label>
          <div class="seg" role="group" aria-labelledby="l-q">${QUALITY_NAMES.map((U) => `<button data-q="${U}" aria-pressed="false">${QUALITY_LABELS[U] || U}</button>`).join("")}</div></div>
        <div class="row"><label for="s-sens">鼠标灵敏度</label><div class="slider"><input id="s-sens" type="range" min="0.2" max="3" step="0.05"><output data-o="sens"></output></div></div>
        <div class="row"><label id="l-inv">Y轴反转</label><button class="toggle" data-act="invert" aria-labelledby="l-inv" aria-pressed="false"><i></i><span>关</span></button></div>
        <div class="row"><label for="s-vol">主音量</label><div class="slider"><input id="s-vol" type="range" min="0" max="100" step="1"><output data-o="vol"></output></div></div>
        <div class="row"><label for="s-fov">视野（FOV）</label><div class="slider"><input id="s-fov" type="range" min="60" max="95" step="1"><output data-o="fov"></output></div></div>
        <div class="row"><label for="s-name">玩家昵称</label><input id="s-name" class="m-name-input" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="破障手-XXXX"><p class="panel-note">联机房间内显示的呼号，仅保存在本机。</p></div>
        <div class="row" data-row="fs"><label id="l-fs">显示</label><button class="btn small" data-act="fullscreen" aria-labelledby="l-fs fs-t"><span id="fs-t">进入全屏</span></button></div>
        <p class="panel-note" data-f="qnote"></p>
      </div>
      <div class="panel-b" data-pane="controls" hidden>
        <h3>键盘 \xB7 鼠标</h3>${KEYBOARD_CONTROLS_HTML}
        <p class="panel-note">若浏览器无法锁定鼠标，按住鼠标键并拖动即可转动视角（左键同时开火，右键同时瞄准）。方向键或 <kbd>I</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> 也可转向，<kbd>Enter</kbd> 开火。</p>
        <h3>触屏</h3>${TOUCH_CONTROLS_HTML}
        <h3>手柄</h3>
        <p class="panel-note">双摇杆移动与视角 \xB7 RT 开火 \xB7 LT 瞄准 \xB7 A 跳跃 \xB7 B 蹲伏 \xB7 X 换弹 \xB7 Y 切断中继 \xB7 L3 冲刺 \xB7 Start 暂停。</p>
      </div>
    </div>

    <div class="m-host" role="dialog" aria-modal="true" aria-label="创建房间" tabindex="-1" hidden>
      <div class="m-host-card">
        <div class="m-k">创建房间</div>
        <p class="m-host-tip">选择行动模式与房间可见性。两者建立后不可更改，最多 4 人。</p>
        <div class="m-name-row">
          <label for="host-name">玩家昵称</label>
          <input id="host-name" data-f="host-name" class="m-name-input" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="破障手-XXXX">
        </div>
        <div class="m-mode-seg" role="group" aria-label="行动模式">
          <button type="button" class="mode-btn" data-mode="coop" aria-pressed="true"><b>合作</b><span>切断中继 \xB7 全员登船撤离</span></button>
          <button type="button" class="mode-btn" data-mode="pvp" aria-pressed="false"><b>对抗</b><span>团队死斗 \xB7 蓝红分队 \xB7 先到 20 杀</span></button>
        </div>
        <div class="m-sec-k">房间可见性</div>
        <div class="m-vis-seg" role="group" aria-label="房间可见性">
          <button type="button" class="mode-btn vis-btn" data-vis="private" aria-pressed="true"><b>私密</b><span>凭 4 位房间码加入（默认）</span></button>
          <button type="button" class="mode-btn vis-btn" data-vis="public" aria-pressed="false"><b>公开</b><span>免房间码 \xB7 可被快速加入匹配</span></button>
        </div>
        <div class="m-p2p-host-extra" data-f="host-p2p-extra">
          <div class="m-sec-k">零服务器（§13）</div>
          <div class="m-p2p-host-row">
            <label class="m-p2p-room-label" for="host-room-code">房间名 / 房号</label>
            <input id="host-room-code" data-f="host-room-code" class="m-name-input m-room-name-input" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="留空自动生成" aria-label="自定义房间名或房号">
            <button type="button" class="btn" data-act="host-p2p" data-f="host-p2p">零服务器建房</button>
            <p class="m-p2p-tip">两台电脑输入同一个 4 位房间名即可选择进入；留空则自动生成（首次连接需联网）。</p>
          </div>
        </div>
        <div class="m-actions">
          <button class="btn primary" data-act="host-confirm" data-f="host-ok">建立房间</button>
          <button class="btn" data-act="host-cancel">取消</button>
        </div>
      </div>
    </div>
    <div class="m-join" role="dialog" aria-modal="true" aria-label="加入房间" tabindex="-1" hidden>
      <div class="m-join-card">
        <div class="m-k">加入房间</div>
        <p class="m-join-tip">快速加入自动匹配公开且未满的行动房间；或凭 4 位房间码定点接入。</p>
        <div class="m-name-row">
          <label for="join-name">玩家昵称</label>
          <input id="join-name" data-f="join-name" class="m-name-input" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="破障手-XXXX">
        </div>
        <div class="m-quick-row">
          <button class="btn primary m-quick" data-act="quick-join" data-f="quick-ok">快速加入</button>
          <button class="btn m-lan" data-act="lan-scan" data-f="lan-ok">自动发现</button>
        </div>
        <button class="btn m-p2p-toggle" data-act="p2p-join" data-f="p2p-toggle">零服务器 \xB7 同文件联机</button>
        <div class="m-p2p-box" data-f="p2p-box" hidden>
          <div class="m-lan-head"><span class="m-lan-k">零服务器（免服务器 P2P）</span><b class="m-lan-stat" data-f="p2p-stat"></b></div>
          <div class="m-p2p-directory" data-f="p2p-directory">
            <div class="m-lan-head"><span class="m-lan-k">可加入房间</span><button type="button" class="btn small" data-act="p2p-directory-refresh" data-f="p2p-directory-refresh">刷新</button></div>
            <div class="m-p2p-directory-list" data-f="p2p-directory-list" role="list"></div>
            <p class="m-p2p-directory-empty" data-f="p2p-directory-empty">正在连接目录…</p>
          </div>
           <button type="button" class="btn primary m-p2p-public" data-act="p2p-public" data-f="p2p-public-ok">公共匹配（免房号）</button>
           <div class="m-p2p-shards" data-f="p2p-shards" aria-label="探测公共分片">
             ${Array.from({ length: 9 }, (_, i) => `<button type="button" class="m-p2p-shard" data-p2p-shard="${i + 1}">探测分片 ${i + 1}</button>`).join("")}
           </div>
          <p class="m-p2p-sub">分片是全网共享的配对入口，不代表本机已经开房；点击后才会探测并加入其中的公共队伍。4 人满员自动换片；私人房请使用房号。首次连接需联网。</p>
          <div class="m-p2p-code-row">
            <input data-f="p2p-code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="————" aria-label="零服务器房间码">
            <button type="button" class="btn small" data-act="p2p-join-confirm" data-f="p2p-join-ok" disabled>加入</button>
          </div>
        </div>
        <div class="m-lan-box" data-f="lan-box" hidden>
          <div class="m-lan-head"><span class="m-lan-k">局域网房间</span><b class="m-lan-stat" data-f="lan-stat"></b></div>
          <div class="m-lan-list" data-f="lan-list" role="list"></div>
          <div class="m-lan-subnet" data-f="lan-subnet" hidden>
            <span class="m-lan-sk">网段</span>
            <input data-f="lan-subnet-input" type="text" maxlength="15" autocomplete="off" spellcheck="false" placeholder="192.168.1" aria-label="手动输入网段">
            <button class="btn small" data-act="lan-rescan">重扫</button>
          </div>
          <p class="m-lan-empty" data-f="lan-empty" hidden></p>
        </div>
        <div class="m-join-alt">凭房间码加入</div>
        <input class="m-join-code" data-f="join-code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="————" aria-label="房间码">
        <div class="m-join-mode" data-f="join-mode" hidden></div>
        <div class="m-actions">
          <button class="btn" data-act="join-confirm" data-f="join-ok" disabled>加入</button>
          <button class="btn" data-act="join-cancel">取消</button>
        </div>
      </div>
    </div>
    <div class="m-toast" role="status" aria-live="polite"></div>

    <div class="loc-card" aria-hidden="true"><i></i><b>Saltline\u6e2f\u533a \xB7 4\u53f7\u6cca\u4f4d \xB7 05:42</b><span>\u6e2f\u52a1\u5c40\u7834\u969c\u5206\u961f \u2014 \u5355\u4eba\u6e17\u900f\uff0c\u6ca1\u6709\u540e\u63f4</span></div>
  `),
    t.appendChild(s));
  let o = (U) => s.querySelector(U),
    r = (U) => [...s.querySelectorAll(U)],
    a = o(".panel"),
    l = o(".loc-card"),
    c = (U) => s.querySelector(`[data-f="${U}"]`),
    u = o("#s-sens"),
    h = o("#s-vol"),
    f = o("#s-fov"),
    fi = o("#s-name"),
    hostNameInput = c("host-name"),
    joinNameInput = c("join-name"),
    p = "none",
    d = null;
  function v(U) {
    if (
      ((!U || U === "sens") && (context.input.sensitivity = n.sens),
      (!U || U === "invertY") && (context.input.invertY = n.invertY),
      !U || U === "volume")
    )
      try {
        context.audio &&
          context.audio.setVolume &&
          context.audio.setVolume(n.volume);
      } catch (T) {
        console.error(T);
      }
    if (
      ((!U || U === "fov") &&
        context.player &&
        context.player.setFov &&
        context.player.setFov(n.fov),
      U === "quality" ||
        (!U &&
          n.quality !== "auto" &&
          !context.params.shot &&
          !context.params.q &&
          n.quality !== (context.quality && context.quality.name)))
    ) {
      let T = QUALITY_PRESETS[n.quality];
      if (T)
        try {
          context.render && context.render.setQuality
            ? context.render.setQuality({
                ...T,
              })
            : (context.quality = {
                ...T,
              });
        } catch (D) {
          console.error("[game] setQuality failed", D);
        }
    }
  }
  function g() {
    let U =
      n.quality === "auto"
        ? context.quality && context.quality.name
        : n.quality;
    for (let D of r(".seg button"))
      D.setAttribute("aria-pressed", String(D.dataset.q === U));
    ((u.value = n.sens),
      (h.value = Math.round(n.volume * 100)),
      (f.value = n.fov),
      (o('[data-o="sens"]').textContent = n.sens.toFixed(2) + "\xD7"),
      (o('[data-o="vol"]').textContent = Math.round(n.volume * 100) + "%"),
      (o('[data-o="fov"]').textContent = Math.round(n.fov) + "\xB0"));
    let T = o('[data-act="invert"]');
    (T.setAttribute("aria-pressed", String(n.invertY)),
      (T.querySelector("span").textContent = n.invertY ? "开" : "关"),
      (c("qnote").textContent =
        n.quality === "auto"
          ? `画质已按本机自动选定（${QUALITY_LABELS[U] || U || "默认"}）。帧率吃紧时可调低。`
          : "画质更改即时生效；阴影与反射重建需要片刻。"));
  }
  (u.addEventListener("input", () => {
    ((n.sens = +u.value), v("sens"), g(), saveSettings(n));
  }),
    h.addEventListener("input", () => {
      ((n.volume = +h.value / 100), v("volume"), g(), saveSettings(n));
    }),
    f.addEventListener("input", () => {
      ((n.fov = +f.value), v("fov"), g(), saveSettings(n));
    }));
  let x = o('[data-row="fs"]'),
    y = o("#fs-t"),
    b = () =>
      document.fullscreenElement || document.webkitFullscreenElement || null,
    m = document.getElementById("app") || document.documentElement;
  (m &&
    (m.requestFullscreen || m.webkitRequestFullscreen) &&
    document.fullscreenEnabled !== !1 &&
    document.webkitFullscreenEnabled !== !1) ||
    (x.hidden = !0);
  function _() {
    y.textContent = "当前环境无法使用全屏";
  }
  function M() {
    try {
      if (b()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(
          document,
        );
        return;
      }
      let U = (m.requestFullscreen || m.webkitRequestFullscreen).call(m);
      U && U.catch && U.catch(_);
    } catch {
      _();
    }
  }
  // 浏览器禁止页面加载时无手势全屏；移动端首次进入行动时借用这次点击请求。
  // 失败时静默降级，玩家仍可通过设置里的全屏按钮手动开启。
  let defaultFullscreenAttempted = !1;
  function requestDefaultFullscreen() {
    if (defaultFullscreenAttempted || b()) return;
    let touch = !1;
    try {
      touch =
        (navigator.maxTouchPoints || 0) > 0 ||
        (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    } catch {}
    if (!touch || !m || !(m.requestFullscreen || m.webkitRequestFullscreen))
      return;
    defaultFullscreenAttempted = !0;
    try {
      let U = (m.requestFullscreen || m.webkitRequestFullscreen).call(m);
      U && U.catch && U.catch(() => {});
    } catch {}
  }
  let E = () => {
    y.textContent = b() ? "退出全屏" : "进入全屏";
  };
  (document.addEventListener("fullscreenchange", E),
    document.addEventListener("webkitfullscreenchange", E));

  // ---- 多人模式 UI：加入弹层 / 联机大厅 / toast / 联机文案（MP） ----
  let joinEl = o(".m-join"),
    joinInput = c("join-code"),
    joinOk = c("join-ok"),
    toastEl = o(".m-toast"),
    toastTimer = null,
    netBound = !1;
  // —— 对抗模式（MP-PVP §8.2）：建房弹层 / 模式徽章 / roundend / 死亡屏变体 ——
  let hostEl = o(".m-host"),
    hostMode = "coop", // 建房弹层当前选择（默认合作）
    hostVis = "private", // 建房弹层可见性（§10.0 默认私密；data-vis 互斥钮）
    hostModeTouched = !1, // 用户是否主动选过建房模式（快速加入的 mode 偏好源）
    quickOk = c("quick-ok"),
    quickPending = !1,
    joinModeEl = c("join-mode"),
    joinPending = !1,
    joinCloseTimer = null,
    deadTicker = null,
    deadPvp = null, // 死亡屏 pvp 变体状态 {by,left,at,hs}
    pvpKillerName = "", // 最近一次击杀本地玩家者（respawn 屏「被 XX 击杀」）
    pvpKillerHeadshot = !1, // 该击杀是否爆头（§9.1 pvp:killed headshot:bool）
    pvpRoundBoard = null, // roundEnd 载荷的 board（roundend 屏渲染源之一）
    pvpTeamScore = null, // §10.1 roundEnd 团队结算 {blue,red,winner:'blue'|'red'|'draw'}
    pvpTimeUp = !1,
    roundendSet = !1,
    // —— §12 局域网自动发现（加入弹层）：扫描态 / 结果 / 手输网段 ——
    lanOk = c("lan-ok"),
    lanBox = c("lan-box"),
    lanListEl = c("lan-list"),
    lanStatEl = c("lan-stat"),
    lanEmptyEl = c("lan-empty"),
    lanSubEl = c("lan-subnet"),
    lanSubInput = c("lan-subnet-input"),
    lanGen = 0, // 扫描代号：closeJoin/重扫时 +1，在途扫描回调全部作废
    lanTimer = null,
    lanScanning = !1,
    lanFound = [],
    lanKeys = new Set(),
    // —— §13 零服务器（Trystero P2P）：建房第三钮 + 加入侧公共匹配/码加入 ——
    hostP2pOk = c("host-p2p"),
    p2pToggle = c("p2p-toggle"),
    p2pBox = c("p2p-box"),
    p2pStatEl = c("p2p-stat"),
    p2pDirectoryListEl = c("p2p-directory-list"),
    p2pDirectoryEmptyEl = c("p2p-directory-empty"),
    p2pDirectoryRefreshEl = c("p2p-directory-refresh"),
    p2pDirectoryScanning = !1,
    p2pDirectoryGen = 0,
    p2pPublicOk = c("p2p-public-ok"),
    p2pShardsEl = c("p2p-shards"),
    p2pCodeInput = c("p2p-code"),
    hostRoomCodeInput = c("host-room-code"),
    hostP2pExtra = c("host-p2p-extra"),
    p2pJoinOk = c("p2p-join-ok"),
    p2pLobbyListEl = c("p2p-lobby-list"),
    p2pLobbyEmptyEl = c("p2p-lobby-empty"),
    p2pLobbyOnlineEl = c("p2p-lobby-online"),
    p2pLobbyRoomsEl = c("p2p-lobby-rooms"),
    p2pLobbyRefreshEl = c("p2p-lobby-refresh"),
    p2pLobbyCodeInput = c("p2p-lobby-code"),
    p2pLobbyJoinOk = c("p2p-lobby-join"),
    p2pLobbyScanning = !1,
    p2pLobbyGen = 0,
    p2pLobbyTimer = null,
    hostP2pContext = !1,
    p2pPending = !1; // p2p 码加入在途（复用 joinPending 的 roomState 关弹层时序）
  fi && (fi.value = loadPlayerName());
  function syncPlayerNameInputs() {
    let name = loadPlayerName();
    fi && (fi.value = name);
    hostNameInput && (hostNameInput.value = name);
    joinNameInput && (joinNameInput.value = name);
    let nn = netApi();
    nn && nn.setName && nn.setName(name);
  }
  function updatePlayerName(value) {
    let name = String(value == null ? "" : value).trim().slice(0, 16);
    if (!name) name = loadPlayerName();
    try {
      localStorage.setItem(MP_NAME_KEY, name);
    } catch {}
    let nn = netApi();
    nn && nn.setName && nn.setName(name);
    syncPlayerNameInputs();
  }
  function netApi() {
    let nn = context.net;
    return nn && typeof nn.on == "function" ? nn : null;
  }
  function toast(text, isErr) {
    if (!text) return;
    ((toastEl.textContent = text),
      (toastEl.className = "m-toast on" + (isErr ? " err" : "")),
      clearTimeout(toastTimer),
      (toastTimer = setTimeout(
        () => (toastEl.className = "m-toast"),
        isErr ? 4500 : 3200,
      )));
  }
  function slotColor(id, idx) {
    // 优先 remote-players.colorOf（真实化身配色），缺席时按 roster 位次镜像四色
    try {
      let rp = context.remotePlayers;
      if (rp && typeof rp.colorOf == "function") {
        let col = rp.colorOf(id);
        if (typeof col == "number")
          return "#" + col.toString(16).padStart(6, "0");
      }
    } catch {}
    let i = ((idx % MP_SLOT_COLORS.length) + MP_SLOT_COLORS.length) % MP_SLOT_COLORS.length;
    return "#" + MP_SLOT_COLORS[i].toString(16).padStart(6, "0");
  }
  function mpRoomMode() {
    // 房间模式（MP-PVP §8.1 回显）：未进房/旧 net 无此面 → null
    let nn = netApi();
    if (!nn || !mpInRoom(nn)) return null;
    try {
      return typeof nn.roomMode == "function" ? nn.roomMode() : null;
    } catch {
      return null;
    }
  }
  function mpInRoom(nn) {
    nn = nn || netApi();
    if (!nn || !nn.mode) return !1;
    return (
      nn.mode === "lobby-host" ||
      nn.mode === "lobby-client" ||
      nn.mode === "host" ||
      nn.mode === "client"
    );
  }
  function mpSelfId() {
    let nn = netApi();
    try {
      return nn && typeof nn.selfId == "function" ? nn.selfId() : null;
    } catch {
      return null;
    }
  }
  function mpNameOf(id) {
    let nn = netApi();
    try {
      if (nn && typeof nn.players == "function")
        for (let pl of nn.players())
          if (pl && pl.id === id) return pl.name || "对手";
    } catch {}
    try {
      let rp = context.remotePlayers;
      if (rp && typeof rp.byId == "function") {
        let m = rp.byId(id);
        if (m && m.name) return m.name;
      }
    } catch {}
    return "对手";
  }
  function killerLabel(by) {
    // setDead 的 by 现为玩家 id（pvp.js 透传 ev.by 原值）：解析成呼号再上屏，
    // 解析不了原样透传（兼容未来直接传名字的调用方；net id 是 seq36+随机串）
    let s = String(by);
    let nn = netApi();
    try {
      if (nn && typeof nn.players == "function")
        for (let pl of nn.players()) if (pl && pl.id === by) return pl.name || s;
    } catch {}
    try {
      let rp = context.remotePlayers;
      if (rp && typeof rp.byId == "function") {
        let m = rp.byId(by);
        if (m && m.name) return m.name;
      }
    } catch {}
    return s;
  }
  function renderModeBadge(el, mode) {
    if (!el) return;
    let pvp = mode === "pvp";
    if (!mode) {
      el.hidden = !0;
      return;
    }
    ((el.hidden = !1),
      (el.className = "m-mode-badge " + (pvp ? "pvp" : "coop")),
      (el.textContent = pvp ? "对抗模式" : "合作模式"));
  }
  function refreshJoinMode() {
    // 加入弹层：加入成功（roomState 回显）当拍展示目标房间模式徽章
    renderModeBadge(joinModeEl, mpRoomMode());
  }
  function setHostMode(mode) {
    hostMode = mode === "pvp" ? "pvp" : "coop";
    for (let b of r(".m-mode-seg .mode-btn"))
      b.setAttribute("aria-pressed", String(b.dataset.mode === hostMode));
  }
  function setHostVis(vis) {
    // §10.0 房间可见性：私密(默认)/公开 互斥；公开房可被 quickJoin 匹配
    hostVis = vis === "public" ? "public" : "private";
    for (let b of r(".m-vis-seg .vis-btn"))
      b.setAttribute("aria-pressed", String(b.dataset.vis === hostVis));
  }
  function openHost(fromP2pLobby) {
    hostP2pContext = !!fromP2pLobby;
    (closeJoin(),
      (hostEl.hidden = !1),
      hostP2pExtra && (hostP2pExtra.hidden = hostP2pContext),
      syncPlayerNameInputs(),
      setHostMode(hostMode),
      setHostVis(hostVis));
    setTimeout(() => {
      try {
        hostEl.focus({ preventScroll: !0 });
      } catch {}
    }, 30);
  }
  function closeHost() {
    hostEl.hidden ||
      ((hostEl.hidden = !0),
        (hostP2pContext = !1),
        hostP2pExtra && (hostP2pExtra.hidden = !1),
        H());
  }
  function openP2PLobby() {
    closeJoin();
    closeHost();
    p2pLobbyCodeInput && (p2pLobbyCodeInput.value = "");
    p2pLobbyJoinOk && ((p2pLobbyJoinOk.disabled = !0), (p2pLobbyJoinOk.textContent = "加入"));
    p2pLobbyOnlineEl && (p2pLobbyOnlineEl.textContent = "0");
    p2pLobbyRoomsEl && (p2pLobbyRoomsEl.textContent = "0");
    q.show("p2p-lobby");
    clearInterval(p2pLobbyTimer);
    p2pLobbyTimer = setInterval(() => {
      if (p === "p2p-lobby") refreshP2PLobby();
    }, 8000);
    refreshP2PLobby();
  }
  function confirmHost() {
    // 建房确认：模式+可见性随 createRoom 上行（net 新签名 createRoom(name,{mode,visibility})，
    // 旧 net 把对象参当 seed 安全忽略 → 退化为私密合作房，不炸链路）
    let mode = hostMode === "pvp" ? "pvp" : "coop",
      vis = hostVis === "public" ? "public" : "private";
    let p2p = hostP2pContext;
    ((hostEl.hidden = !0), closeJoin());
    let nn = netApi();
    if (!nn || typeof nn.createRoom != "function")
      return toast("联机服务不可用", !0);
    try {
      context.audio &&
        context.audio.resume &&
        context.audio.resume();
    } catch {}
    toast(
      p2p
        ? mode === "pvp"
          ? "正在建立零服务器对抗房间…"
          : "正在建立零服务器合作房间…"
        : mode === "pvp"
          ? vis === "public"
            ? "正在建立公开对抗房间…"
            : "正在建立对抗房间…"
          : vis === "public"
            ? "正在建立公开合作房间…"
            : "正在建立港区联机链路…",
    );
    nn.createRoom(loadPlayerName(), {
      mode: mode,
      visibility: vis,
      ...(p2p ? { transport: "p2p" } : {}),
    }).catch((err) => {
      toast((err && err.message) || "创建房间失败", !0);
    });
  }
  function stopDeadTicker() {
    deadTicker && (clearInterval(deadTicker), (deadTicker = null));
  }
  function applyDeadVariant() {
    let statsEl = c("dead-stats"),
      actEl = c("dead-actions"),
      pvpEl = c("dead-pvp"),
      byEl = c("dead-by"),
      nEl = c("dead-respawn");
    if (!statsEl || !pvpEl) return;
    if (deadPvp) {
      ((statsEl.hidden = !0),
        actEl && (actEl.hidden = !0),
        (pvpEl.hidden = !1),
        (byEl.textContent = deadPvp.by
          ? deadPvp.hs
            ? `被 ${deadPvp.by} 爆头击杀`
            : `被 ${deadPvp.by} 击杀`
          : "已阵亡"));
      let draw = () => {
        let left = Math.max(
          0,
          Math.ceil(deadPvp.left - (performance.now() - deadPvp.at) / 1e3),
        );
        nEl.textContent = String(left);
      };
      (draw(),
        stopDeadTicker(),
        (deadTicker = setInterval(() => {
          p === "dead" ? draw() : stopDeadTicker();
        }, 120)));
    } else {
      (stopDeadTicker(),
        (pvpEl.hidden = !0),
        (statsEl.hidden = !1),
        actEl && (actEl.hidden = !1));
    }
  }
  function setRespawnNow(info) {
    // 死亡屏 pvp 变体倒计时刷新（pvp-flow 或 respawn 载荷驱动皆可；
    // 兼容 {in}|{respawn}|{t}|{left} 秒数字段）
    let by = info && info.by != null ? String(info.by) : pvpKillerName,
      raw =
        info &&
        (info.in != null
          ? info.in
          : info.respawn != null
            ? info.respawn
            : info.t != null
              ? info.t
              : info.left),
      left = Number(raw);
    if (!(left > 0)) return;
    ((deadPvp = {
      by: by || "",
      left: left,
      at: performance.now(),
      // §9.1 headshot:bool：载荷/调用方带上则用，缺席回落击杀缓存
      hs:
        info && info.headshot != null
          ? !!info.headshot
          : pvpKillerHeadshot,
    }),
      applyDeadVariant());
  }
  function rankBoard(board) {
    // 名次排序：杀数降序 → 阵亡升序 → 名字（并列=并列名次由渲染位次呈现）
    let rows = [];
    for (let row of board || [])
      row &&
        row.id != null &&
        rows.push({
          id: row.id,
          name: row.name || "对手",
          you: !!row.you || row.id === mpSelfId(),
          kills: Math.max(0, row.kills | 0),
          deaths: Math.max(0, row.deaths | 0),
        });
    return rows.sort(
      (a, b) =>
        b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name),
    );
  }
  function setTeamScore(data) {
    // §10.1 roundEnd 团队结算 {blueKills, redKills, winner:'blue'|'red'|'draw'}——
    // 原始载荷为平铺字段；pvp.js setRoundEnd 走嵌套 data.team（两种形都收）。
    // 数值缺时从 board[] 的 team 字段（0=蓝 1=红）按 kills 求和兜底；全缺=清空
    // （老 FFA 房/旧服务器不显团队块，个人排名照旧）
    let src =
      data && data.team && typeof data.team == "object"
        ? Object.assign({}, data, data.team)
        : data;
    let blue = null,
      red = null,
      winner = null;
    if (src && typeof src == "object") {
      Number.isFinite(+src.blueKills) && (blue = Math.max(0, src.blueKills | 0));
      Number.isFinite(+src.redKills) && (red = Math.max(0, src.redKills | 0));
      (src.winner === "blue" || src.winner === "red" || src.winner === "draw") &&
        (winner = src.winner);
    }
    if (blue == null || red == null) {
      let b = 0,
        r = 0,
        seen = !1;
      for (let row of pvpRoundBoard || [])
        if (row && (row.team === 0 || row.team === 1)) {
          seen = !0;
          row.team === 1
            ? (r += Math.max(0, row.kills | 0))
            : (b += Math.max(0, row.kills | 0));
        }
      if (seen) {
        blue == null && (blue = b);
        red == null && (red = r);
      }
    }
    if (blue == null || red == null) {
      pvpTeamScore = null;
      return;
    }
    winner ||
      (winner = blue > red ? "blue" : red > blue ? "red" : "draw");
    pvpTeamScore = { blue: blue, red: red, winner: winner };
  }
  function renderRoundEnd() {
    let list = c("roundend-list"),
      sub = c("roundend-sub"),
      teamEl = c("roundend-team"),
      bEl = c("roundend-blue"),
      rEl = c("roundend-red"),
      banEl = c("roundend-banner");
    if (!list) return;
    let raw =
        (pvpRoundBoard && pvpRoundBoard.length ? pvpRoundBoard : null) ||
        (Array.isArray(context.pvpBoard) && context.pvpBoard.length
          ? context.pvpBoard
          : null) ||
        (context.game &&
        context.game.run &&
        Array.isArray(context.game.run.board) &&
        context.game.run.board.length
          ? context.game.run.board
          : []),
      rows = rankBoard(raw);
    list.textContent = "";
    rows.forEach((row, idx) => {
      let el = document.createElement("div");
      el.className =
        "m-rank-row" +
        (idx === 0 && rows.length > 1 ? " lead" : "") +
        (row.you ? " me" : "");
      let rk = document.createElement("b"),
        nm = document.createElement("span"),
        k = document.createElement("i"),
        d = document.createElement("i");
      ((rk.className = "rk"),
        (rk.textContent = String(idx + 1)),
        (nm.className = "nm"),
        (nm.textContent = row.name + (row.you ? "（你）" : "")),
        (k.textContent = String(row.kills)),
        (d.textContent = String(row.deaths)),
        el.append(rk, nm, k, d),
        list.append(el));
    });
    // 团队结算块（§10.2 roundend：大比分 蓝 X : Y 红 + 胜利方横幅）
    if (teamEl) {
      if (pvpTeamScore) {
        ((teamEl.hidden = !1),
          bEl && (bEl.textContent = String(pvpTeamScore.blue)),
          rEl && (rEl.textContent = String(pvpTeamScore.red)));
        banEl &&
          ((banEl.hidden = !1),
            (banEl.className = "m-ts-banner " + pvpTeamScore.winner),
            (banEl.textContent =
              pvpTeamScore.winner === "blue"
                ? "蓝队获胜"
                : pvpTeamScore.winner === "red"
                  ? "红队获胜"
                  : "平局"));
      } else {
        teamEl.hidden = !0;
        banEl && (banEl.hidden = !0);
      }
    }
    if (sub) {
      if (pvpTeamScore)
        sub.textContent = pvpTimeUp
          ? "队伍杀数达标 · 战斗结束"
          : "队伍杀数达标 · 战斗结束";
      else {
        let top = rows[0];
        sub.textContent = top
          ? "达成 20 杀 · " +
            (rows.length > 1 && rows[1] && rows[1].kills === top.kills
              ? "并列领先"
              : top.kills + " 杀封王：" + (top.you ? "你" : top.name))
          : "";
      }
    }
  }
  function quickJoinReset() {
    ((quickPending = !1),
      quickOk && ((quickOk.disabled = !1), (quickOk.textContent = "快速加入")),
      p2pShardsEl &&
        [...p2pShardsEl.querySelectorAll("[data-p2p-shard]")].forEach((b) => (b.disabled = !1)));
  }
  // ---- §13 零服务器（Trystero P2P）：建房第三钮 / 公共匹配 / 码加入 ----
  function confirmHostP2P() {
    // §13.2 私人房轨道：本地生成 4 位码 → slp-{code} joinRoom → 建房者优先选举
    // 选举出房主；模式取建房弹层当前选择，码房恒私密。成功后与 ws 建房同款
    // 由 roomState 事件转场大厅（lobby 屏显示房号，同文件+同房号即可加入）
    let nn = netApi();
    if (!nn || typeof nn.createRoom != "function")
      return toast("联机服务不可用", !0);
    let mode = hostMode === "pvp" ? "pvp" : "coop";
    try {
      context.audio &&
        context.audio.resume &&
        context.audio.resume();
    } catch {}
    ((hostEl.hidden = !0), closeJoin());
    toast(
      mode === "pvp"
        ? "正在建立零服务器对抗房（Nostr 信令配对）…"
        : "正在建立零服务器合作房（Nostr 信令配对）…",
    );
    nn.createRoom(loadPlayerName(), {
      mode: mode,
      visibility: "private",
      transport: "p2p",
      roomCode: hostRoomCodeInput ? hostRoomCodeInput.value : "",
    }).catch((err) => {
      toast((err && err.message) || "零服务器建房失败", !0);
    });
  }
  function p2pJoinReset() {
    ((p2pPending = !1),
      p2pJoinOk && ((p2pJoinOk.disabled = !1), (p2pJoinOk.textContent = "加入")));
  }
  function toggleP2pBox() {
    // 加入弹层零服务器盒：开盒即复位在途态（与 §12 lan-box 同款开关语义）
    p2pBox.hidden ? ((p2pBox.hidden = !1), p2pJoinReset(), refreshP2PDirectory()) : (p2pBox.hidden = !0);
    p2pStatEl && (p2pStatEl.textContent = "Nostr 信令");
    p2pCodeInput &&
      !p2pBox.hidden &&
      setTimeout(() => {
        try {
          p2pCodeInput.focus({ preventScroll: !0 });
        } catch {}
      }, 30);
  }
  function renderP2PDirectory(list, listEl, emptyEl) {
    listEl = listEl || p2pDirectoryListEl;
    emptyEl = emptyEl || p2pDirectoryEmptyEl;
    if (!listEl) return;
    listEl.textContent = "";
    let rows = Array.isArray(list) ? list : [];
    rows.forEach((room) => {
      if (!room || !/^[A-Z0-9]{4}$/.test(String(room.code || ""))) return;
      let row = document.createElement("button");
      row.type = "button";
      let full = Number(room.players) >= Number(room.maxPlayers || 4);
      let busy = room.phase === "playing";
      row.className = "m-p2p-directory-item" + (full || busy ? " dim" : "");
      row.disabled = full || busy;
      row.dataset.act = "p2p-directory-room";
      row.dataset.p2pRoomCode = String(room.code).toUpperCase();
      let badge = document.createElement("span");
      renderModeBadge(badge, room.mode === "pvp" ? "pvp" : "coop");
      row.append(badge);
      let name = document.createElement("b");
      name.className = "room-name";
      name.textContent = room.name || "房间 " + room.code;
      row.append(name);
      let host = document.createElement("span");
      host.className = "room-host";
      host.textContent = room.host || "房主";
      row.append(host);
      let count = document.createElement("span");
      count.className = "room-count";
      count.textContent = `${room.players || 0}/${room.maxPlayers || 4}`;
      row.append(count);
      let state = document.createElement("span");
      state.className = "room-state";
      state.textContent = busy ? "对局中" : full ? "已满" : "大厅";
      row.append(state);
      listEl.appendChild(row);
    });
    if (emptyEl) {
      emptyEl.hidden = rows.length > 0;
      emptyEl.textContent = rows.length ? "" : "暂无在线房间，建房后会自动出现在这里";
    }
  }
  async function refreshP2PDirectory() {
    if (p2pDirectoryScanning) return;
    let gen = ++p2pDirectoryGen;
    let nn = netApi();
    if (!nn || typeof nn.discoverP2PRooms !== "function") {
      renderP2PDirectory([]);
      if (p2pDirectoryEmptyEl) p2pDirectoryEmptyEl.textContent = "当前版本不支持零服务器房间目录";
      return;
    }
    p2pDirectoryScanning = !0;
    p2pDirectoryRefreshEl && (p2pDirectoryRefreshEl.disabled = !0);
    p2pDirectoryEmptyEl && ((p2pDirectoryEmptyEl.hidden = !1), (p2pDirectoryEmptyEl.textContent = "正在读取目录…"));
    try {
      let list = await nn.discoverP2PRooms({ waitMs: 10000 });
      if (gen !== p2pDirectoryGen) return;
      renderP2PDirectory(list);
      p2pStatEl && (p2pStatEl.textContent = `目录 ${Array.isArray(list) ? list.length : 0} 间`);
    } catch (err) {
      if (gen !== p2pDirectoryGen) return;
      renderP2PDirectory([]);
      p2pDirectoryEmptyEl && (p2pDirectoryEmptyEl.textContent = (err && err.message) || "目录暂不可用");
    } finally {
      p2pDirectoryScanning = !1;
      p2pDirectoryRefreshEl && (p2pDirectoryRefreshEl.disabled = !1);
    }
  }
  async function refreshP2PLobby() {
    if (p2pLobbyScanning) return;
    let gen = ++p2pLobbyGen;
    let nn = netApi();
    if (!nn || (typeof nn.p2pDirectoryStats !== "function" && typeof nn.discoverP2PRooms !== "function")) {
      renderP2PDirectory([], p2pLobbyListEl, p2pLobbyEmptyEl);
      p2pLobbyEmptyEl && (p2pLobbyEmptyEl.textContent = "当前版本不支持零服务器大厅");
      return;
    }
    p2pLobbyScanning = !0;
    p2pLobbyRefreshEl && (p2pLobbyRefreshEl.disabled = !0);
    p2pLobbyEmptyEl && ((p2pLobbyEmptyEl.hidden = !1), (p2pLobbyEmptyEl.textContent = "正在读取目录…"));
    try {
      let stats = typeof nn.p2pDirectoryStats === "function"
        ? await nn.p2pDirectoryStats({ waitMs: 3000 })
        : { online: 0, rooms: await nn.discoverP2PRooms({ waitMs: 3000 }) };
      if (gen !== p2pLobbyGen) return;
      let list = Array.isArray(stats && stats.rooms) ? stats.rooms : [];
      renderP2PDirectory(list, p2pLobbyListEl, p2pLobbyEmptyEl);
      p2pLobbyOnlineEl && (p2pLobbyOnlineEl.textContent = String(Math.max(0, Number(stats && stats.online) || 0)));
      p2pLobbyRoomsEl && (p2pLobbyRoomsEl.textContent = String(list.length));
    } catch (err) {
      if (gen !== p2pLobbyGen) return;
      renderP2PDirectory([], p2pLobbyListEl, p2pLobbyEmptyEl);
      p2pLobbyEmptyEl && (p2pLobbyEmptyEl.textContent = (err && err.message) || "目录暂不可用");
    } finally {
      p2pLobbyScanning = !1;
      p2pLobbyRefreshEl && (p2pLobbyRefreshEl.disabled = !1);
    }
  }
  function joinP2PDirectoryRoom(code, inputEl, okEl, statEl) {
    inputEl = inputEl || p2pCodeInput;
    okEl = okEl || p2pJoinOk;
    statEl = statEl || p2pStatEl;
    if (!inputEl) return;
    inputEl.value = String(code || "").toUpperCase().slice(0, 4);
    okEl && (okEl.disabled = inputEl.value.length !== 4);
    confirmP2pJoin(inputEl, okEl, statEl);
  }
  function confirmP2pPublic(startShard) {
    // §13.2 公共匹配：依次探测 slpub-{mode}-{n} 分片（<4 留驻），免房号；
    // 满员驱逐由 host 侧广播（探测侧 ≥4 即自动换片，通常到不了驱逐分支）
    if (quickPending) return;
    let nn = netApi();
    if (!nn || typeof nn.quickJoin != "function")
      return toast("当前版本不支持零服务器公共匹配", !0);
    let pref = hostModeTouched ? (hostMode === "pvp" ? "pvp" : "coop") : undefined;
    let shard = Number.isFinite(+startShard)
      ? Math.max(1, Math.min(9, (+startShard) | 0))
      : null;
    try {
      context.audio &&
        context.audio.resume &&
        context.audio.resume();
    } catch {}
    ((quickPending = !0),
      p2pPublicOk && ((p2pPublicOk.disabled = !0), (p2pPublicOk.textContent = "探测分片中…")),
      p2pShardsEl &&
        [...p2pShardsEl.querySelectorAll("[data-p2p-shard]")].forEach((b) => (b.disabled = !0)),
      toast("正在零服务器公共匹配（自动探测分片）…"));
    nn.quickJoin(pref, { transport: "p2p", shard: shard || undefined }).then(
      function () {}, // 成功由 roomState 处理器关弹层（与 quickJoin 同款时序）
      function (err) {
        quickJoinReset();
        p2pPublicOk &&
          ((p2pPublicOk.disabled = !1),
            (p2pPublicOk.textContent = "公共匹配（免房号）"));
        p2pShardsEl &&
          [...p2pShardsEl.querySelectorAll("[data-p2p-shard]")].forEach((b) => (b.disabled = !1));
        toast((err && err.message) || "零服务器公共匹配失败", !0);
      },
    );
  }
  function confirmP2pJoin(inputEl, okEl, statEl) {
    // §13.2 私人房进房：输码 joinRoom（slp-{code}），与 ws 模式的码体验一致；
    // 复用 joinPending 使接入成功的关弹层时序与 confirmJoin 完全同款
    inputEl = inputEl || p2pCodeInput;
    okEl = okEl || p2pJoinOk;
    statEl = statEl || p2pStatEl;
    let code = inputEl ? inputEl.value.trim().toUpperCase() : "";
    if (code.length !== 4 || joinPending || p2pPending) return;
    let nn = netApi();
    if (!nn || typeof nn.joinRoom != "function")
      return toast("联机服务不可用", !0);
    try {
      context.audio &&
        context.audio.resume &&
        context.audio.resume();
    } catch {}
    ((joinPending = !0),
      (p2pPending = !0),
      okEl && ((okEl.disabled = !0), (okEl.textContent = "接入中…")),
      (statEl && (statEl.textContent = "配对中…")),
      toast("正在零服务器接入（同文件 + 同房号）…"));
    nn.joinRoom(code, loadPlayerName(), { transport: "p2p" }).catch((err) => {
      p2pPending = !1;
      okEl && ((okEl.disabled = !1), (okEl.textContent = "加入"));
      statEl && (statEl.textContent = "Nostr 信令");
      joinPending && ((joinPending = !1), (joinOk.disabled = !1), (joinOk.textContent = "加入"));
      toast((err && err.message) || "零服务器加入失败", !0);
    });
  }
  function confirmQuickJoin() {
    // §10.0 快速加入：服务器匹配公开且未满且 lobby 态的房；无匹配则服务器自动
    // 建公开房。mode 偏好仅在用户主动选过建房模式后携带（无模式上下文=不带，
    // §10.1 {t:"quickJoin", mode?}）；旧 net 无 quickJoin 面时降级提示不炸链路。
    if (quickPending) return;
    let nn = netApi();
    if (!nn || typeof nn.quickJoin != "function")
      return toast("当前版本不支持快速加入，请用房间码", !0);
    let pref = hostModeTouched ? (hostMode === "pvp" ? "pvp" : "coop") : undefined;
    try {
      context.audio &&
        context.audio.resume &&
        context.audio.resume();
    } catch {}
    ((quickPending = !0),
      (quickOk.disabled = !0),
      (quickOk.textContent = "匹配中…"));
    toast("正在匹配公开房间…");
    nn.quickJoin(pref).then(
      function () {}, // 接入成功由 roomState 处理器关弹层（与 joinPending 同款时序）
      function (err) {
        quickJoinReset();
        toast((err && err.message) || "快速加入失败", !0);
      },
    );
  }
  // ---- §12 局域网自动发现（MP-PVP §12.1）：扫 /24 找服务器进程，点选直连 ----
  var LAN_SCAN_TIMEOUT = 450; // 单探针超时（ms）——浏览器连接池安全参数见 lan-scan.js 注释
  function lanScanApi() {
    // §12 装配：net 挂载面（测试/集成注入位）优先，否则静态 import 的
    // src/net/lan-scan.js（实交签名：scanLan(opts) 对象形 + getLocalSubnet()）
    let nn = netApi();
    if (nn && typeof nn.scanLan == "function")
      return Promise.resolve({
        scanLan: nn.scanLan,
        getLocalSubnet:
          typeof nn.getLocalSubnet == "function" ? nn.getLocalSubnet : null,
      });
    return Promise.resolve({
      scanLan: lanScanMod,
      getLocalSubnet: lanSubnetMod || null,
    });
  }
  function lanSubnetErr(err) {
    // 网段推断失败识别（§12.0 WebRTC ICE 提取内网 IP 失败 → 手输兜底）
    let code = err && err.code;
    if (code === "NO_SUBNET" || code === "LAN_SUBNET" || code === "SUBNET")
      return !0;
    return /网段|子网|内网|subnet|candidate/i.test((err && err.message) || "");
  }
  function lanInfoOf(it) {
    // 条目归一：lan-scan 返回 {ip, info}（info=/lan-info 应答）；容忍扁平旧形
    return it && it.info && typeof it.info == "object" ? it.info : it || {};
  }
  function lanEntriesOf(it) {
    // 一台局域网服务器可以同时开多间房。旧服务只返回单条摘要，新服务在
    // roomList 中返回完整目录；这里统一摊平成大厅中的房间行。
    let root = lanInfoOf(it);
    if (!Array.isArray(root.roomList) || !root.roomList.length) return [it];
    let ip = lanIpOf(it);
    return root.roomList.map((info, index) => ({
      ip: ip,
      info: info,
      _roomIndex: index,
    }));
  }
  function lanIpOf(it) {
    let ip = it && it.ip != null ? it.ip : lanInfoOf(it).ip;
    return ip != null ? String(ip) : "";
  }
  function lanHostOf(it) {
    // 房主名：/lan-info 公开房 host 字符串（rooms.lanInfo 房主居首）；
    // names 名单 / players 数组兜底；私密房脱敏无名 → 通用呼号
    let info = lanInfoOf(it);
    if (info.host != null && typeof info.host != "object")
      return String(info.host) || "房主";
    if (Array.isArray(info.names) && info.names.length)
      return String(info.names[0] || "房主");
    if (Array.isArray(info.players) && info.players.length) {
      let p0 = info.players[0];
      return typeof p0 == "object" && p0
        ? String(p0.name || "房主")
        : String(p0);
    }
    return "房主";
  }
  function lanCountOf(it) {
    // 人数：/lan-info 公开房 players 是数字、私密房 n 是数字；名单形兜底取长度
    let info = lanInfoOf(it),
      n = info.n != null ? info.n : info.players;
    if (Array.isArray(n)) n = n.length;
    return Number.isFinite(+n) ? Math.max(0, n | 0) : 0;
  }
  function lanRowEl(it, idx) {
    // 结果行：模式徽章 + 房主名 + 人数 n/4 + 状态（私密/对局中灰态不可点）
    let info = lanInfoOf(it),
      priv = !it || info.visible === !1 || info.visibility === "private" || !info.code,
      busy = !!(info.phase && info.phase !== "lobby"),
      row = document.createElement("button");
    ((row.className = "m-lan-item" + (priv || busy ? " dim" : "")),
      row.setAttribute("type", "button"),
      row.setAttribute("data-act", "lan-join"),
      row.setAttribute("data-code", priv ? "" : String(info.code || "")),
      row.setAttribute("data-idx", String(idx)),
      (row.disabled = !!(priv || busy)));
    let badge = document.createElement("span");
    (renderModeBadge(badge, info.mode === "pvp" ? "pvp" : "coop"),
      row.append(badge));
    let room = document.createElement("span");
    ((room.className = "room"),
      (room.textContent = info.code ? "房间 " + String(info.code) : "房间"),
      row.append(room));
    let nm = document.createElement("b");
    ((nm.className = "nm"), (nm.textContent = lanHostOf(it)), row.append(nm));
    let cn = document.createElement("span");
    ((cn.className = "c"), (cn.textContent = lanCountOf(it) + "/4"), row.append(cn));
    let st = document.createElement("span");
    ((st.className = "st"),
      (st.textContent = priv ? "私密" : busy ? "对局中" : lanIpOf(it)),
      row.append(st));
    return row;
  }
  function lanRowPush(it) {
    // 渐进发现（onFound 通道）：按 ip|房码（或私密房序号）去重入列
    for (let entry of lanEntriesOf(it)) {
      let info = lanInfoOf(entry);
      let key = lanIpOf(entry) + "|" + (info.code || "private-" + (entry._roomIndex || 0));
      if (lanKeys.has(key)) continue;
      lanKeys.add(key);
      lanFound.push(entry);
      lanListEl && lanListEl.appendChild(lanRowEl(entry, lanFound.length - 1));
    }
  }
  function lanStopTimer() {
    lanTimer && (clearInterval(lanTimer), (lanTimer = null));
  }
  function lanResetUI() {
    (lanStopTimer(),
      (lanScanning = !1),
      (lanFound = []),
      lanKeys.clear(),
      lanListEl && (lanListEl.textContent = ""),
      lanEmptyEl && ((lanEmptyEl.hidden = !0), (lanEmptyEl.textContent = "")),
      lanSubEl && (lanSubEl.hidden = !0),
      lanStatEl && (lanStatEl.textContent = ""),
      lanOk && ((lanOk.disabled = !1), (lanOk.textContent = "自动发现")));
  }
  function lanScanDone(gen, err, subnet, list) {
    if (gen !== lanGen) return; // 弹层已关/已重扫：结果作废
    (lanStopTimer(), (lanScanning = !1));
    lanOk && ((lanOk.disabled = !1), (lanOk.textContent = "自动发现"));
    if (err) {
      if (!subnet && lanSubnetErr(err)) {
        // §12.0 网段推断失败 → 手输网段兜底（前缀形 192.168.1）
        (lanStatEl && (lanStatEl.textContent = "无法推断本机网段"),
          lanEmptyEl && (lanEmptyEl.hidden = !0));
        if (lanSubEl) {
          (lanSubEl.hidden = !1);
          try {
            lanSubInput && lanSubInput.focus({ preventScroll: !0 });
          } catch {}
        }
        return;
      }
      ((lanBox.hidden = !0), toast((err && err.message) || "局域网扫描失败", !0));
      return;
    }
    if (Array.isArray(list) && list.length) {
      // 返回列表为权威形：整体重渲染（吸收与 onFound 通道的重叠）
      ((lanFound = []), lanKeys.clear(), lanListEl && (lanListEl.textContent = ""));
      for (let it of list)
        for (let entry of lanEntriesOf(it)) {
          let info = lanInfoOf(entry);
          let key = lanIpOf(entry) + "|" + (info.code || "private-" + (entry._roomIndex || 0));
          lanKeys.has(key) || (lanKeys.add(key), lanFound.push(entry));
        }
      lanFound.forEach((it, i) => lanListEl && lanListEl.appendChild(lanRowEl(it, i)));
    }
    lanStatEl && (lanStatEl.textContent = `发现 ${lanFound.length} 个房间`);
    lanFound.length ||
      (lanEmptyEl &&
        ((lanEmptyEl.hidden = !1),
          (lanEmptyEl.textContent = "未发现房间，检查房主服务器是否已启动")));
  }
  function lanStartScan(subnet) {
    // §12.1 入口：lan-scan 实交签名 scanLan({port,timeoutMs,onFound,subnet})——
    // 自动网段先 getLocalSubnet()（ICE host 候选；mDNS 混淆/无 WebRTC → null →
    // 手输兜底，不发无的之矢）；手输网段直扫。UI 侧只做态与渲染。
    if (lanScanning) return;
    let nn = netApi();
    if (!nn || typeof nn.joinRoom != "function")
      return toast("联机服务不可用", !0);
    let gen = ++lanGen;
    (lanResetUI(), (lanScanning = !0));
    lanOk && ((lanOk.disabled = !0), (lanOk.textContent = "扫描中…"));
    if (lanBox) {
      (lanBox.hidden = !1);
      subnet && lanSubEl && (lanSubEl.hidden = !1); // 手输重扫保持输入可见
    }
    lanStatEl && (lanStatEl.textContent = "正在探测网段…");
    let t0 = Date.now();
    (lanStopTimer(),
      (lanTimer = setInterval(() => {
        gen === lanGen
          ? lanStatEl &&
            (lanStatEl.textContent = `扫描中 ${((Date.now() - t0) / 1e3).toFixed(1)}s · 已发现 ${lanFound.length}`)
          : lanStopTimer();
      }, 200)));
    lanScanApi().then(async (api) => {
      if (gen !== lanGen) return;
      if (!api)
        return lanScanDone(gen, new Error("自动发现组件未装配"), subnet, null);
      let sn = subnet || null;
      if (!sn && api.getLocalSubnet) {
        try {
          sn = await api.getLocalSubnet();
        } catch {
          sn = null;
        }
        if (gen !== lanGen) return;
        if (!sn)
          return lanScanDone(
            gen,
            Object.assign(new Error("无法推断本机网段"), { code: "NO_SUBNET" }),
            subnet,
            null,
          );
      }
      let res;
      try {
        res = api.scanLan({
          port: DEFAULT_PORT,
          timeoutMs: LAN_SCAN_TIMEOUT,
          onFound: (entry) => {
            gen === lanGen && entry && lanRowPush(entry);
          },
          subnet: sn || undefined,
        });
      } catch (err) {
        return lanScanDone(gen, err, subnet, null);
      }
      (res && typeof res.then == "function" ? res : Promise.resolve(res)).then(
        (list) => lanScanDone(gen, null, subnet, Array.isArray(list) ? list : null),
        (err) => lanScanDone(gen, err, subnet, null),
      );
    });
  }
  function lanRescanManual() {
    // 手输网段重扫：校验前缀形（≥2 段，如 192.168 或 192.168.1）
    let v = lanSubInput ? lanSubInput.value.trim().replace(/\.$/, "") : "";
    if (!/^\d{1,3}(\.\d{1,3}){1,2}$/.test(v))
      return toast("网段格式如 192.168.1", !0);
    lanStartScan(v);
  }
  function lanJoinRoom(code) {
    // 点公开房直连：与 confirmJoin 同款时序（joinPending + roomState 关弹层）；
    // flow 动作缺席时直接 net.joinRoom(code, name)（任务书：直连 net.joinRoom）
    code = String(code || "").trim().toUpperCase();
    if (code.length !== 4 || joinPending || quickPending) return;
    let nn = netApi();
    if (!nn || typeof nn.joinRoom != "function")
      return toast("联机服务不可用", !0);
    try {
      context.audio && context.audio.resume && context.audio.resume();
    } catch {}
    ((joinPending = !0),
      (joinOk.disabled = !0),
      (joinOk.textContent = "接入中…"),
      toast("正在接入港区中继站…"));
    if (e.join) e.join(code);
    else
      nn.joinRoom(code, loadPlayerName()).catch((err) => {
        joinPending &&
          ((joinPending = !1),
            (joinOk.disabled = !1),
            (joinOk.textContent = "加入"));
        toast((err && err.message) || "加入房间失败", !0);
      });
  }
  function openJoin() {
    ((joinInput.value = ""),
      syncPlayerNameInputs(),
      (joinOk.disabled = !0), // 空码不可加入（输入事件按 4 位门启用）
      (joinPending = !1),
      (joinOk.textContent = "加入"),
      quickJoinReset(),
      // §12：开弹层即复位扫描态（上一局的列表/手输网段不跨开）
      (lanGen++),
      lanResetUI(),
      (lanBox.hidden = !0),
      // §13：开弹层即复位零服务器盒（隐藏 + 清码 + 复位按钮）
      (p2pBox.hidden = !0),
      (++p2pDirectoryGen),
      (p2pCodeInput && (p2pCodeInput.value = "")),
      p2pJoinReset(),
      (p2pPublicOk &&
        ((p2pPublicOk.disabled = !1),
          (p2pPublicOk.textContent = "公共匹配（免房号）"))),
      (p2pStatEl && (p2pStatEl.textContent = "Nostr 信令")),
      clearTimeout(joinCloseTimer),
      refreshJoinMode(),
      (joinEl.hidden = !1));
    setTimeout(() => {
      try {
        joinInput.focus({ preventScroll: !0 });
      } catch {}
    }, 30);
  }
  function closeJoin() {
    clearTimeout(joinCloseTimer);
    joinEl.hidden ||
      ((joinEl.hidden = !0),
        (joinInput.value = ""),
        (joinOk.disabled = !0),
        (joinPending = !1),
        (joinOk.textContent = "加入"),
        quickJoinReset(),
        // §12：关弹层即作废在途扫描（代号 +1），扫描态与列表复位
        (lanGen++),
        lanResetUI(),
        (lanBox.hidden = !0),
        // §13：关弹层即收起零服务器盒并复位在途态
        (p2pBox.hidden = !0),
        (++p2pDirectoryGen),
        (p2pCodeInput && (p2pCodeInput.value = "")),
        p2pJoinReset(),
        (p2pPublicOk &&
          ((p2pPublicOk.disabled = !1),
            (p2pPublicOk.textContent = "公共匹配（免房号）"))),
        H());
  }
  function confirmJoin() {
    let code = joinInput.value.trim().toUpperCase();
    if (code.length !== 4 || joinPending) return;
    let nn = netApi();
    if (!nn || typeof nn.joinRoom != "function")
      return toast("联机服务不可用", !0);
    if (!e.join) return toast("联机功能尚未装配", !0);
    // 弹层保持开启等待回显：模式徽章在接入成功当拍展示（MP-PVP §8.2 加入弹层徽章）
    ((joinPending = !0),
      (joinOk.disabled = !0),
      (joinOk.textContent = "接入中…"),
      toast("正在接入港区中继站…"));
    e.join ? e.join(code) : toast("联机功能尚未装配", !0);
  }
  function copyCode() {
    let nn = netApi(),
      code = "";
    try {
      code = (nn && nn.roomCode && nn.roomCode()) || "";
    } catch {}
    if (!code) {
      // §13.2 公共房分享：无房码，复制「同文件 + 公共匹配」指引
      let label = "";
      try {
        label = (nn && nn.roomLabel && nn.roomLabel()) || "";
      } catch {}
      if (label)
        return copyText(
          "Saltline 零服务器公共房：打开同一份游戏文件，选「加入房间 → 零服务器 → 公共匹配」即可相遇（无需房号）。",
          "已复制公共房加入指引",
        );
      return toast("暂无房间码", !0);
    }
    return copyText(code, "房间码已复制：" + code);
  }
  function copyText(text, doneMsg) {
    let done = () => toast(doneMsg),
      fail = () => toast("复制失败，请手动记录", !0);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        return void navigator.clipboard.writeText(text).then(done, fail);
    } catch {}
    try {
      let ta = document.createElement("textarea");
      ((ta.value = text),
        (ta.style.position = "fixed"),
        (ta.style.opacity = "0"),
        document.body.appendChild(ta),
        ta.select());
      let ok = document.execCommand("copy");
      (ta.remove(), ok ? done() : fail());
    } catch {
      fail();
    }
  }
  function mpLive() {
    let nn = netApi();
    return !!(nn && nn.mode && nn.mode !== "offline");
  }
  function isHostSide() {
    let nn = netApi();
    try {
      return !!(nn && nn.isHost && nn.isHost());
    } catch {
      return !1;
    }
  }
  function setWait(btn, wait, waitText, normText) {
    btn &&
      ((btn.disabled = !!wait),
        (btn.textContent = wait ? waitText : normText));
  }
  function refreshMpScreens() {
    let mp = mpLive(),
      host = isHostSide(),
      wait = mp && !host;
    let pvp = mpRoomMode() === "pvp",
      restartBtn = o('[data-act="restart"]'),
      lobbyBtn = o('[data-act="mp-lobby"]');
    // 对抗是一局制：暂停菜单不提供重开任务；合作联机仍保留房主权限提示。
    if (restartBtn) restartBtn.hidden = !!(mp && pvp);
    setWait(restartBtn, wait, "等待房主重开", "重开任务");
    setWait(lobbyBtn, mp && !host, "等待房主返回房间", "返回房间");
    setWait(o('[data-act="retry"]'), wait, "等待房主重开", "重试");
    setWait(o('[data-act="redeploy"]'), wait, "等待房主重开", "再次部署");
    let dk = c("dead-k"),
      pvpMode = pvp;
    dk &&
      (dk.textContent = pvpMode
        ? "破障手阵亡 \xB7 重新部署中"
        : mp
          ? "破障手阵亡 — 观战中"
          : "破障手阵亡");
    refreshJoinMode();
  }
  function plTeam(pl) {
    // §10.1 joined/roomState 每玩家 team:0|1（仅 pvp 房有意义，coop 恒 0）；
    // 旧服务器不带该字段 → null（大厅退回单列名单）
    return pl && (pl.team === 0 || pl.team === 1) ? pl.team : null;
  }
  function lobbyRowEl(pl, idx, host) {
    // 成员行：位色点照旧 + 呼号 + 房主/你 标签 + 就绪态（蓝红两栏与单列共用）
    let row = document.createElement("li"),
      dot = document.createElement("i");
    ((dot.className = "dot"),
      (dot.style.background = slotColor(pl.id, idx)));
    let nm = document.createElement("b");
    ((nm.className = "nm"), (nm.textContent = pl.name || "队员"));
    row.append(dot, nm);
    let tag;
    if (idx === 0 || (host && pl.you)) tag = ["tag lead", "房主"];
    else if (pl.you) tag = ["tag you", "你"];
    if (tag) {
      let el = document.createElement("span");
      ((el.className = tag[0]), (el.textContent = tag[1]), row.append(el));
    }
    let rdy = document.createElement("span");
    return (
      (rdy.className = "rdy" + (pl.ready ? " on" : "")),
      (rdy.textContent = pl.ready ? "就绪" : "待命"),
      row.append(rdy),
      row
    );
  }
  function refreshLobby() {
    let nn = netApi();
    if (!nn) return;
    let players = [];
    try {
      players = nn.players() || [];
    } catch {}
    let code = "";
    try {
      code = nn.roomCode() || "";
    } catch {}
    // §13.2 公共房无房码：以「公共房 · 分片 n」标签呈现（net.roomLabel）
    let label = "";
    try {
      label = (typeof nn.roomLabel == "function" && nn.roomLabel()) || "";
    } catch {}
    let p2p = !1;
    try {
      p2p = typeof nn.transportKind == "function" && nn.transportKind() === "p2p";
    } catch {}
    let host = isHostSide(),
      codeEl = c("lobby-code"),
      countEl = c("lobby-count"),
      rosterEl = c("lobby-roster"),
      startBtn = c("lobby-start"),
      hintEl = c("lobby-hint");
    if (!codeEl || !rosterEl) return;
    let pvp = mpRoomMode() === "pvp";
    (codeEl.classList.toggle("is-label", !code && !!label),
      (codeEl.textContent = code || label || "----"),
      (countEl.textContent = players.length + "/4"));
    renderModeBadge(c("lobby-mode"), pvp ? "pvp" : mpInRoom() ? "coop" : null);
    // §10.2 lobby 队伍分组：pvp 房且 players 带 team 字段 → 蓝队/红队两栏；
    // 缺 team（旧服务器）退回单列「交战各方」名单
    let teamsEl = c("lobby-teams"),
      blueEl = c("lobby-blue"),
      redEl = c("lobby-red"),
      blueN = c("lobby-blue-n"),
      redN = c("lobby-red-n"),
      hasTeam = !1;
    if (pvp)
      for (let pl of players)
        if (plTeam(pl) != null) {
          hasTeam = !0;
          break;
        }
    if (pvp && hasTeam && teamsEl && blueEl && redEl) {
      ((rosterEl.hidden = !0),
        (teamsEl.hidden = !1),
        (blueEl.textContent = ""),
        (redEl.textContent = ""));
      let nb = 0,
        nr = 0;
      players.forEach((pl, idx) => {
        if (!pl) return;
        plTeam(pl) === 1 ? nr++ : nb++;
        (plTeam(pl) === 1 ? redEl : blueEl).append(lobbyRowEl(pl, idx, host));
      });
      (blueN && (blueN.textContent = String(nb)),
        redN && (redN.textContent = String(nr)));
    } else {
      (teamsEl && (teamsEl.hidden = !0)),
        (rosterEl.hidden = !1),
        (rosterEl.textContent = ""),
        players.forEach((pl, idx) => {
          pl && rosterEl.append(lobbyRowEl(pl, idx, host));
        });
    }
    ((startBtn.hidden = !1),
      (startBtn.disabled = !host || players.length < 2),
      (startBtn.textContent = host ? "开始行动" : "等待房主开始行动"));
    let squadH = rosterEl.previousElementSibling;
    squadH &&
      squadH.querySelector("span") &&
      (squadH.querySelector("span").textContent = pvp ? "交战各方" : "突击小队");
    hintEl.textContent = p2p
      ? host
        ? (label
            ? "零服务器公共房：同文件点「公共匹配」即相遇，4 人满员自动换片。"
            : "零服务器房：把房号告知同文件玩家即可加入。") +
          "信令断开对局继续，房主掉线即终局。"
        : (label ? "零服务器公共房。" : "零服务器房。") +
          "已就位，等待房主开始行动…（房主掉线即终局）"
      : pvp
        ? host
          ? players.length < 2
            ? "团队对抗至少需要 2 人。按加入序自动分队，队伍先达 20 杀获胜。"
            : "团队死斗：蓝红分队、各自固定侧重生，队伍先达 20 杀获胜。"
          : "团队死斗：队伍先达 20 杀获胜。已就位，等待房主开始行动…"
        : host
          ? players.length < 2
            ? "至少 2 名队员集结后才能开始行动。"
            : "全员登船才算完成撤离，阵亡者无需登船。"
          : "已就位。等待房主开始行动…";
  }
  function renderTeam(team) {
    let wrap = c("team"),
      list = c("team-list"),
      rk = c("rating-k");
    if (!wrap || !list) return;
    if (!(Array.isArray(team) && team.length)) {
      ((wrap.hidden = !0), rk && (rk.textContent = "评级"));
      return;
    }
    (rk && (rk.textContent = "房级评级"), (list.textContent = ""));
    team.forEach((pl, idx) => {
      if (!pl) return;
      let row = document.createElement("div");
      row.className = "m-team-row" + (pl.you ? " me" : "");
      let dot = document.createElement("i");
      ((dot.className = "dot"),
        (dot.style.background = slotColor(pl.id, idx)));
      let nm = document.createElement("b");
      ((nm.className = "nm"),
        (nm.textContent = (pl.name || "队员") + (pl.you ? "（你）" : "")));
      let st = document.createElement("span");
      ((st.className = "st"),
        (st.textContent =
          "击毁 " +
          (pl.kills | 0) +
          " · 命中率 " +
          (pl.accuracy == null ? "—" : Math.round(pl.accuracy * 100) + "%")),
        row.append(dot, nm, st),
        list.append(row));
    });
    wrap.hidden = !1;
  }
  function fallbackLeave() {
    let nn = netApi();
    nn && nn.disconnect && nn.disconnect("离开房间");
    toast("已离开房间");
    q.show("title");
  }
  function mpScreenSync() {
    // 大厅屏归属（与 flow 约定）：lobby 期 menus 自主切屏——roomState 到达且仍在标题屏
    let nn = netApi();
    if (!nn) return;
    let m = nn.mode;
    if ((m === "lobby-host" || m === "lobby-client") && (p === "title" || p === "p2p-lobby"))
      q.show("lobby");
    else if (m === "offline" && (p === "lobby" || p === "roundend" || p === "p2p-lobby"))
      q.show("title");
  }
  function bindNet() {
    if (netBound) return;
    let nn = netApi();
    if (!nn) return;
    netBound = !0;
    syncPlayerNameInputs();
    nn.on("roomState", () => {
      if (
        (joinPending || quickPending) &&
        !joinEl.hidden &&
        (nn.mode === "lobby-client" || nn.mode === "lobby-host")
      ) {
        // 加入/快速加入成功：弹层内亮出目标房间模式徽章，稍候自动转场大厅
        ((joinPending = !1),
          refreshJoinMode(),
          (joinOk.disabled = !0),
          (joinOk.textContent = "已接入"),
          quickOk &&
            ((quickOk.disabled = !0), (quickOk.textContent = "已接入")),
          // §13 零服务器接入成功：p2p 按钮同拍转「已接入」（盒随弹层自动收起）
          p2pJoinOk &&
            ((p2pJoinOk.disabled = !0), (p2pJoinOk.textContent = "已接入")),
          (p2pStatEl && (p2pStatEl.textContent = "已接入")),
          p2pPublicOk &&
            ((p2pPublicOk.disabled = !0), (p2pPublicOk.textContent = "已接入")),
          clearTimeout(joinCloseTimer),
          (joinCloseTimer = setTimeout(closeJoin, 750)));
      }
      (mpScreenSync(), refreshLobby(), refreshMpScreens());
    });
    nn.on("peerJoin", () => refreshLobby());
    nn.on("peerLeave", () => refreshLobby());
    nn.on("phase", () => {
      (mpScreenSync(), refreshLobby(), refreshMpScreens());
    });
    nn.on("error", (ev) => {
      joinPending &&
        !joinEl.hidden &&
        ((joinPending = !1),
          (joinOk.disabled = !1),
          (joinOk.textContent = "加入"));
      // §13 零服务器接入失败：p2p 按钮/状态行同拍复位（joinPending 复位含码加入路径）
      p2pJoinReset();
      p2pPublicOk &&
        ((p2pPublicOk.disabled = !1),
          (p2pPublicOk.textContent = "公共匹配（免房号）"));
      p2pStatEl && (p2pStatEl.textContent = "Nostr 信令");
      quickPending && quickJoinReset();
      toast((ev && ev.msg) || "联机链路错误", !0);
    });
    nn.on("hostGone", () => {
      (toast("房主已离开，行动终止", !0), mpScreenSync());
    });
    // pvp 载荷分派（MP-PVP §8.1）：客户端侧自主消费 roundEnd/respawn/killed；
    // host 端由 pvp-flow 本地驱动同名 menus API（setRoundEnd/setDead/setRespawn）
    try {
      nn.client &&
        typeof nn.client.onHostPayload == "function" &&
        nn.client.onHostPayload((pl) => {
          if (!pl || pl.k !== "pvp") return;
          if (pl.e === "roundEnd") {
            (Array.isArray(pl.board) && (pvpRoundBoard = pl.board),
              (pvpTimeUp = !!pl.timeUp),
              // §10.1 团队结算字段（blueKills/redKills/winner）直读原始载荷
              setTeamScore(pl),
              (roundendSet = !0));
            p === "roundend" && renderRoundEnd();
          } else if (pl.e === "respawn") {
            let me = mpSelfId();
            me != null && pl.id === me && setRespawnNow(pl);
          } else if (pl.e === "killed") {
            let me = mpSelfId();
            me != null &&
              pl.victim === me &&
              ((pvpKillerName = mpNameOf(pl.by)),
              // 原始载荷直读（§9.1 headshot:bool 权威字段，不依赖翻译层透传）
              (pvpKillerHeadshot = !!pl.headshot));
          }
        });
    } catch {}
    // host 端不经 onHostPayload：pvp:* 本地事件（host-sim emitLocal）同源补齐
    // 死亡屏变体的倒计时/击杀者缓存（消费方，绝不向 context.events 回灌）
    try {
      context.events &&
        typeof context.events.on == "function" &&
        (context.events.on("pvp:respawn", (ev) => {
          let me = mpSelfId();
          me != null && ev && ev.id === me && setRespawnNow(ev);
        }),
        context.events.on("pvp:killed", (ev) => {
          let me = mpSelfId();
          me != null &&
            ev &&
            ev.victim === me &&
            ((pvpKillerName = mpNameOf(ev.by)),
            // §9.1 headshot:bool 两端一致：pvp.js 翻译层已透传，host emitLocal
            // 同字段名；字段缺席（旧字段防御）不清缓存，原始载荷路径已写入权威值
            ev.headshot != null && (pvpKillerHeadshot = !!ev.headshot));
        }));
    } catch {}
  }
  let MPUI = {
    host() {
      let nn = netApi();
      if (!nn || typeof nn.createRoom != "function")
        return toast("联机服务不可用", !0);
      openHost(); // 建房弹层：模式切换（默认合作）后确认建立
    },
    "host-confirm": confirmHost,
    "host-cancel": closeHost,
    "host-p2p": confirmHostP2P,
    "p2p-lobby": openP2PLobby,
    "p2p-lobby-host": () => openHost(!0),
    "p2p-lobby-refresh": refreshP2PLobby,
    "p2p-lobby-back"() {
      q.show("title");
    },
    "p2p-lobby-join"() {
      confirmP2pJoin(p2pLobbyCodeInput, p2pLobbyJoinOk, null);
    },
    join: openJoin,
    "join-confirm": confirmJoin,
    "join-cancel": closeJoin,
    "quick-join": confirmQuickJoin,
    "p2p-join": toggleP2pBox,
    "p2p-public": confirmP2pPublic,
    "p2p-join-confirm": confirmP2pJoin,
    "lan-scan"() {
      lanStartScan();
    },
    "lan-rescan": lanRescanManual,
    "copy-code": copyCode,
    "mp-start"() {
      let nn = netApi();
      if (!nn || typeof nn.startGame != "function")
        return toast("联机服务不可用", !0);
      e.mpStart ? e.mpStart() : toast("联机功能尚未装配", !0);
    },
    "mp-leave"() {
      e.mpLeave ? e.mpLeave() : fallbackLeave();
    },
    "mp-lobby"() {
      e.mpLobby ? e.mpLobby() : toast("等待房主返回房间");
    },
  };
  (joinInput.addEventListener("input", () => {
    ((joinInput.value = joinInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4)),
      (joinOk.disabled = joinInput.value.length !== 4));
  }),
    joinInput.addEventListener("keydown", (U) => {
      if (
        (U.stopPropagation(),
        (U.code === "Enter" || U.code === "NumpadEnter") &&
          (U.preventDefault(), confirmJoin()),
        U.code === "Escape")
      )
        (U.preventDefault()), closeJoin();
    }),
    // §12 手输网段：只留数字与点；Enter 重扫 / Esc 关弹层（与房间码输入同款）
    lanSubInput &&
      (lanSubInput.addEventListener("input", () => {
        lanSubInput.value = lanSubInput.value
          .replace(/[^0-9.]/g, "")
          .replace(/\.{2,}/g, ".")
          .split(".")
          .slice(0, 3)
          .join(".");
      }),
      lanSubInput.addEventListener("keydown", (U) => {
        if (
          (U.stopPropagation(),
          (U.code === "Enter" || U.code === "NumpadEnter") &&
            (U.preventDefault(), lanRescanManual()),
          U.code === "Escape")
        )
          (U.preventDefault()), closeJoin();
      })),
    // §13 零服务器码输入：只留大写字母数字；Enter 加入 / Esc 关弹层（同款时序）
    p2pCodeInput &&
      (p2pCodeInput.addEventListener("input", () => {
        ((p2pCodeInput.value = p2pCodeInput.value
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 4)),
          p2pJoinOk && (p2pJoinOk.disabled = p2pCodeInput.value.length !== 4));
      }),
      p2pCodeInput.addEventListener("keydown", (U) => {
        if (
          (U.stopPropagation(),
          (U.code === "Enter" || U.code === "NumpadEnter") &&
            (U.preventDefault(), confirmP2pJoin()),
          U.code === "Escape")
        )
          (U.preventDefault()), closeJoin();
      })),
    p2pLobbyCodeInput &&
      (p2pLobbyCodeInput.addEventListener("input", () => {
        ((p2pLobbyCodeInput.value = p2pLobbyCodeInput.value
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 4)),
          p2pLobbyJoinOk && (p2pLobbyJoinOk.disabled = p2pLobbyCodeInput.value.length !== 4));
      }),
      p2pLobbyCodeInput.addEventListener("keydown", (U) => {
        if (
          (U.stopPropagation(),
          (U.code === "Enter" || U.code === "NumpadEnter") &&
            (U.preventDefault(), confirmP2pJoin(p2pLobbyCodeInput, p2pLobbyJoinOk, null)),
          U.code === "Escape")
        )
          (U.preventDefault()), q.show("title");
      })),
    hostRoomCodeInput &&
      hostRoomCodeInput.addEventListener("input", () => {
        hostRoomCodeInput.value = hostRoomCodeInput.value
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 4);
      }),
    fi && fi.addEventListener("input", () => updatePlayerName(fi.value)),
    hostNameInput &&
      hostNameInput.addEventListener("input", () => updatePlayerName(hostNameInput.value)),
    joinNameInput &&
      joinNameInput.addEventListener("input", () => updatePlayerName(joinNameInput.value)),
    bindNet());

  function w(U) {
    ((d = document.activeElement),
      (a.hidden = !1),
      s.classList.add("panel-open"),
      z(U || "settings"));
    try {
      a.focus({
        preventScroll: !0,
      });
    } catch {}
  }
  function S() {
    return a.hidden
      ? !1
      : ((a.hidden = !0),
        s.classList.remove("panel-open"),
        d && d.focus && s.contains(d) ? d.focus() : H(),
        !0);
  }
  function z(U) {
    for (let T of r(".tab"))
      T.setAttribute("aria-selected", String(T.dataset.tab === U));
    for (let T of r(".panel-b")) T.hidden = T.dataset.pane !== U;
  }
  function H() {
    let U = s.querySelector(`.m-screen[data-s="${p}"] .btn.primary`);
    if (U)
      try {
        U.focus({
          preventScroll: !0,
        });
      } catch {}
  }
  (s.addEventListener("click", (U) => {
    let T = U.target.closest("button");
    if (!T || !s.contains(T)) return;
    if ((context.events.emit("ui:click", {}), T.dataset.mode)) {
      // 建房弹层模式切换钮（合作/对抗互斥，aria-pressed 呈现）；
      // 主动选过模式后 quickJoin 才带 mode 偏好（§10.1）
      setHostMode(T.dataset.mode);
      hostModeTouched = !0;
      return;
    }
    if (T.dataset.vis) {
      // 建房弹层可见性切换钮（§10.0 私密/公开互斥，data-vis 呈现）
      setHostVis(T.dataset.vis);
      return;
    }
    if (T.dataset.act === "p2p-directory-refresh") {
      refreshP2PDirectory();
      return;
    }
    if (T.dataset.act === "p2p-directory-room") {
      if (!T.disabled) {
        let inLobby = T.closest('[data-s="p2p-lobby"]');
        joinP2PDirectoryRoom(
          T.dataset.p2pRoomCode,
          inLobby ? p2pLobbyCodeInput : p2pCodeInput,
          inLobby ? p2pLobbyJoinOk : p2pJoinOk,
          inLobby ? null : p2pStatEl,
        );
      }
      return;
    }
    if (T.dataset.p2pShard) {
      confirmP2pPublic(+T.dataset.p2pShard);
      return;
    }
    if (T.dataset.q) {
      ((n.quality = T.dataset.q), v("quality"), g(), saveSettings(n));
      return;
    }
    if (T.dataset.tab) {
      z(T.dataset.tab);
      return;
    }
    if (T.dataset.act === "lan-join") {
      // §12 结果行点选直连（灰态行 disabled：真浏览器点击不达，桩测双保险）
      T.disabled || lanJoinRoom(T.dataset.code);
      return;
    }
    let D = T.dataset.act;
    if (D === "deploy" || D === "mp-start" || D === "redeploy")
      requestDefaultFullscreen();
    if (MPUI[D]) return MPUI[D]();
    if (D === "redeploy" && !e.redeploy && mpRoomMode() === "pvp") {
      // roundend「再来一局」兜底：流程未提供 redeploy 动作时房主直发房间级重开
      let nn = netApi();
      if (isHostSide() && nn && typeof nn.restartGame == "function") {
        try {
          context.audio && context.audio.resume && context.audio.resume();
        } catch {}
        nn.restartGame({});
      } else toast("等待房主重开");
      return;
    }
    D === "settings"
      ? w("settings")
      : D === "controls"
        ? w("controls")
        : D === "close-panel"
          ? S()
          : D === "invert"
            ? ((n.invertY = !n.invertY), v("invertY"), g(), saveSettings(n))
            : D === "fullscreen"
              ? M()
              : D && e[D] && e[D](U);
  }),
    s.addEventListener("mouseover", (U) => {
      let T = U.target.closest("button");
      T &&
        U.relatedTarget &&
        !T.contains(U.relatedTarget) &&
        context.events.emit("ui:hover", {});
    }),
    s.addEventListener("keydown", (U) => {
      if (!joinEl.hidden || !hostEl.hidden) {
        // 加入/建房弹层：焦点圈兼容 input（Tab 圈内循环），Escape 关闭
        let modal = joinEl.hidden ? hostEl : joinEl;
        if (U.code === "Escape")
          return (
            joinEl.hidden ? closeHost() : closeJoin(),
            U.stopPropagation(),
            void U.preventDefault()
          );
        if (U.code === "Enter" || U.code === "NumpadEnter") U.stopPropagation();
        else if (U.code === "Tab") {
          let jt = [...modal.querySelectorAll("button, input")].filter(
              (G) => G.offsetParent !== null,
            ),
            jf = jt[0],
            jl = jt[jt.length - 1];
          if (jt.length)
            (U.shiftKey && document.activeElement === jf
              ? (jl.focus(), U.preventDefault())
              : !U.shiftKey && document.activeElement === jl
                ? (jf.focus(), U.preventDefault())
                : 0,
              U.stopPropagation());
        }
      }
      if (
        (U.code === "Escape" &&
          !a.hidden &&
          (S(), U.stopPropagation(), U.preventDefault()),
        U.code === "Tab" && !a.hidden)
      ) {
        let T = [...a.querySelectorAll("button, input")].filter(
          (G) => G.offsetParent !== null,
        );
        if (!T.length) return;
        let D = T[0],
          C = T[T.length - 1];
        U.shiftKey && document.activeElement === D
          ? (C.focus(), U.preventDefault())
          : !U.shiftKey &&
            document.activeElement === C &&
            (D.focus(), U.preventDefault());
      }
    }));
  let O = (U) => (
      (U = Math.max(0, Math.floor(U))),
      String(Math.floor(U / 60)).padStart(2, "0") +
        ":" +
        String(U % 60).padStart(2, "0")
    ),
    q = {
      root: s,
      settings: n,
      fmtTime: O,
      get screen() {
        return p;
      },
      get panelOpen() {
        return !a.hidden || !joinEl.hidden || !hostEl.hidden;
      },
      closePanel: S,
      show(U) {
        if (U !== "p2p-lobby" && p2pLobbyTimer) {
          clearInterval(p2pLobbyTimer);
          p2pLobbyTimer = null;
        }
        U !== p &&
          ((p !== "dead" || U === "dead") ||
            (stopDeadTicker(),
            deadPvp && ((deadPvp = null), applyDeadVariant())),
          (p = U),
          (s.dataset.screen = U),
          S(),
          s.classList.toggle("open", U !== "none"),
          U !== "none"
            ? (g(), setTimeout(H, 30))
            : document.activeElement &&
              s.contains(document.activeElement) &&
              document.activeElement.blur(),
          U === "dead" &&
            mpRoomMode() === "pvp" &&
            !deadPvp &&
            ((deadPvp = {
              by: pvpKillerName,
              left: 3,
              at: performance.now(),
              hs: pvpKillerHeadshot,
            }),
            applyDeadVariant()),
          U === "roundend" && renderRoundEnd());
        (bindNet(), U === "lobby" && refreshLobby(), refreshMpScreens());
      },
      locationCard(U) {
        l.classList.toggle("on", !!U);
      },
      setLookMode(U) {
        c("lookmode").textContent = U || "";
      },
      setDead({ time: U, relays: T, total: D, pvp: PV, by: BY, headshot: HS, respawn: RS }) {
        if (PV) {
          // 死亡屏 pvp 变体：中央大字重生倒计时 +「被 XX 击杀/爆头击杀」
          // （MP-PVP §8.2；§9.1 headshot:bool——by 是玩家 id，先解析呼号再上屏）
          ((deadPvp = {
            by: BY != null ? killerLabel(BY) : pvpKillerName,
            left: Number(RS) > 0 ? Number(RS) : 3,
            at: performance.now(),
            hs: HS != null ? !!HS : pvpKillerHeadshot,
          }),
            applyDeadVariant());
          return;
        }
        ((deadPvp = null),
          applyDeadVariant(),
          (c("dead-time").textContent = O(U)),
          (c("dead-relays").textContent = `${T}/${D}`));
      },
      setRespawn(info) {
        setRespawnNow(info);
      },
      setRoundEnd(data) {
        let board = Array.isArray(data) ? data : data && data.board;
        (Array.isArray(board) &&
          board.length &&
          (pvpRoundBoard = board),
        data &&
          !Array.isArray(data) &&
          typeof data.timeUp == "boolean" &&
          (pvpTimeUp = data.timeUp),
        // §10.1 pvp.js setRoundEnd 携带 {blueKills, redKills, winner}（团队死斗结算）
        data && !Array.isArray(data) && setTeamScore(data),
        (roundendSet = !0),
        renderRoundEnd());
      },
      setDebrief({ time: U, accuracy: T, kills: D, retries: C, rating: G, team }) {
        ((c("time").textContent = O(U)),
          (c("acc").textContent =
            T == null ? "\u2014" : Math.round(T * 100) + "%"),
          (c("kills").textContent = String(D)),
          (c("retries").textContent = String(C)),
          (c("rating").textContent = G),
          renderTeam(team));
      },
      applySettings: v,
    };
  return (g(), q);
}

export {
  createMenus,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  QUALITY_NAMES,
  KEYBOARD_CONTROLS_HTML,
  TOUCH_CONTROLS_HTML,
  MP_NAME_KEY,
  loadPlayerName,
};
