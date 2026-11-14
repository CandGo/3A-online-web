// 复现 trystero nostr 的确定性中继选择:shuffle(30池, strToNum(appId)).slice(0, redundancy)
// 用于诊断"两端各连各的中继导致假房间"
const APP_ID = 'saltline-p2p-v1';
const DEFAULTS = [
  'wss://bucket.coracle.social', 'wss://fanfares.nostr1.com', 'wss://no.str.cr',
  'wss://nostr-01.yakihonne.com', 'wss://nostr-pub.wellorder.net', 'wss://nostr.azzamo.net',
  'wss://nostr.chaima.info', 'wss://nostr.data.haus', 'wss://nostr.hifish.org',
  'wss://nostr.liberty.fans', 'wss://nostr.overmind.lol', 'wss://nostr.sathoarder.com',
  'wss://nostrelay.circum.space', 'wss://relay.angor.io', 'wss://relay.ditto.pub',
  'wss://relay.dwadziesciajeden.pl', 'wss://relay.fundstr.me', 'wss://relay.guggero.org',
  'wss://relay.masize.com', 'wss://relay.minibolt.info', 'wss://relay.mostro.network',
  'wss://relay.nostr.com', 'wss://relay.nostr.net', 'wss://relay.nostrhub.fr',
  'wss://relay.notoshi.win', 'wss://relay.primal.net', 'wss://relay.snort.social',
  'wss://relay.wavlake.com', 'wss://soloco.nl', 'wss://yabu.me',
];

// hash32 (FNV-1a + avalanche) — 与 @trystero-p2p/core primitives.mjs 逐行一致
function hash32(str) {
  const bytes = Buffer.from(str, 'utf8');
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  return (h ^ h >>> 16) >>> 0;
}
const strToNum = (str) => hash32(str) % Number.MAX_SAFE_INTEGER;

// shuffle — 与 utils.mjs 一致
function shuffle(xs, seed) {
  const a = [...xs];
  let state = (Math.trunc(seed) || 1) >>> 0;
  const rand = () => {
    state = (state + 1831565813) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let i = a.length;
  while (i) {
    const j = Math.floor(rand() * i--);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

const ordered = shuffle(DEFAULTS, strToNum(APP_ID));
console.log('appId =', APP_ID, ' → 确定性中继顺序(前7):');
ordered.slice(0, 7).forEach((r, i) => console.log(`  ${i + 1}. ${r}${i < 5 ? '  ← 默认连这个' : '  ← redundancy>5 才连'}`));

// TCP 443 可达性(电脑侧)
const net = await import('node:net');
console.log('\n电脑侧 TCP 443 可达性:');
await Promise.all(ordered.slice(0, 7).map((u) => new Promise((res) => {
  const host = u.replace('wss://', '');
  const s = net.connect({ host, port: 443, timeout: 4000 });
  s.on('connect', () => { console.log('  通', u); s.destroy(); });
  s.on('timeout', () => { console.log('  死', u, '(超时)'); s.destroy(); });
  s.on('error', (e) => { console.log('  死', u, e.code); });
})));
