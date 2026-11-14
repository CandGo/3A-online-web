import {
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "../vendor/three-r180.js";

var noop = () => {};

var FALLBACKS = {
  ground: () => ({
    stub: !0,
    update: noop,
    wetnessAt: () => 0.5,
    isPuddle: () => !1,
  }),
  backdrop: () => ({
    stub: !0,
    update: noop,
  }),
  fx: () => ({
    stub: !0,
    update: noop,
    muzzleFlash: noop,
    tracer: noop,
    impact: noop,
    sparks: noop,
    smoke: noop,
    explosion: noop,
    debris: noop,
    shell: noop,
    decal: noop,
    dust: noop,
    clear: noop,
    splash: noop,
    addEmitter: () => ({
      stop: noop,
      setPos: noop,
    }),
  }),
  audio: () => {
    let i = {
      setPos: noop,
      setGain: noop,
      setPitch: noop,
      stop: noop,
    };
    return {
      stub: !0,
      update: noop,
      resume: noop,
      play: noop,
      loop: () => i,
      setIntensity: noop,
      setInterior: noop,
      setVolume: noop,
      setPaused: noop,
    };
  },
  weapon: () => ({
    stub: !0,
    update: noop,
    reset: noop,
    setVisible: noop,
    ammo: 30,
    magSize: 30,
    reserve: 120,
    state: "idle",
    name: "KR-7",
    ads: 0,
    spread: 0.01,
  }),
  enemies: () => ({
    stub: !0,
    list: [],
    update: noop,
    spawn: () => null,
    raycast: () => null,
    aliveCount: () => 0,
    clear: noop,
    alert: noop,
  }),
  hud: () => ({
    stub: !0,
    update: noop,
    show: noop,
    setObjective: noop,
    message: noop,
    hitmarker: noop,
  }),
  // MP-CONTRACT §3：net 离线兜底——断网/无 WebSocket 时启动与帧循环永不因联机而死
  net: () => ({
    stub: !0,
    mode: "offline",
    update: noop,
    on: () => {},
    off: noop,
    players: () => [],
    connected: () => !1,
    isHost: () => !1,
    selfId: () => null,
    roomCode: () => null,
    latency: () => 0,
    disconnect: noop,
    host: {
      onClientPayload: noop,
      broadcast: () => !1,
      to: () => !1,
      playersState: () => [],
    },
    client: {
      onHostPayload: noop,
      send: () => !1,
    },
  }),
  mats: () => {
    let i = new Map();
    return {
      stub: !0,
      get: (t) => (
        i.has(t) ||
          i.set(
            t,
            new MeshStandardMaterial({
              color: 7829367,
              roughness: 0.7,
            }),
          ),
        i.get(t)
      ),
      emissive: (t = 16777215, n = 4) =>
        new MeshBasicMaterial({
          color: new Color(t).multiplyScalar(n),
        }),
      names: [],
      decal: () => ({
        material: new MeshBasicMaterial({
          transparent: !0,
          opacity: 0,
        }),
        aspect: 1,
      }),
      label: () => ({
        material: new MeshBasicMaterial({
          transparent: !0,
          opacity: 0,
        }),
        aspect: 4,
      }),
      uniforms: {
        wet: {
          value: 1,
        },
      },
      update: noop,
    };
  },
};

export { FALLBACKS, noop };
