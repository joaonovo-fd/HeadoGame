const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "headgame.html"), "utf8");
const code = src.match(/<script>([\s\S]*)<\/script>/)[1];

// Minimal 2D-context stub: every canvas call is a no-op, measureText returns a
// plausible width so layout maths still works.
const gradStub = () => ({ addColorStop: () => {} });
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === "measureText") return (s) => ({ width: String(s).length * 6 });
    if (k === "canvas") return { width: 1000, height: 600 };
    if (k === "createLinearGradient" || k === "createRadialGradient" ||
        k === "createConicGradient") return gradStub;
    if (k === "createPattern") return () => ({ setTransform: () => {} });
    if (k === "getImageData") return (x, y, w, h) =>
      ({ data: new Uint8ClampedArray(Math.max(1, (w|0) * (h|0)) * 4), width: w|0, height: h|0 });
    if (k === "isPointInPath") return () => false;
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});

const store = new Map();
const WebSocketSpy = { made: [], throwOnConstruct: false };
const sandbox = {
  console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  location: { search: process.env.HG_NO_TEST ? "" : "?test=1" },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: {
    title: "",
    getElementById: () => ({
      width: 1000, height: 600, style: {},
      getContext: () => ctxStub,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
      addEventListener: () => {}, requestPointerLock: () => {},
    }),
    addEventListener: () => {},
    exitPointerLock: () => {},
    pointerLockElement: null,
    createElement: () => ({ style: {}, getContext: () => ctxStub, addEventListener: () => {} }),
  },
  navigator: { getGamepads: () => [] },
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  /*
    A scriptable WebSocket. The relay transport is driven entirely through this,
    so the address parsing, control messages and channel shim are all testable
    without a real socket or a real server.
  */
  WebSocket: class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.onopen = this.onclose = this.onerror = this.onmessage = null;
      WebSocketSpy.made.push(this);
      if (WebSocketSpy.throwOnConstruct) throw new Error("bad url");
    }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    /* Test helpers, not part of the browser API. */
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    _recv(obj) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    }
  },

  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  RTCPeerConnection: class { constructor(){ this.localDescription=null; }
    createDataChannel(){ return { addEventListener(){}, send(){}, close(){} }; }
    addEventListener(){} createOffer(){ return Promise.resolve({}); }
    setLocalDescription(){ return Promise.resolve(); }
    setRemoteDescription(){ return Promise.resolve(); }
    createAnswer(){ return Promise.resolve({}); } close(){} },
  AudioContext: class { constructor(){ this.destination={}; this.currentTime=0; this.state="running"; }
    createGain(){ return { gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}}, connect(){}, disconnect(){} }; }
    createOscillator(){ return { frequency:{value:0,setValueAtTime(){}}, type:"sine", connect(){}, start(){}, stop(){}, disconnect(){} }; }
    createBiquadFilter(){ return { frequency:{value:0,setValueAtTime(){}}, Q:{value:0}, type:"lowpass", connect(){}, disconnect(){} }; }
    createBuffer(){ return { getChannelData: () => new Float32Array(128) }; }
    createBufferSource(){ return { buffer:null, connect(){}, start(){}, stop(){}, disconnect(){} }; }
    resume(){ return Promise.resolve(); } close(){ return Promise.resolve(); } },
  Image: class { set src(v) { this._s = v; } },
  fetch: () => Promise.reject(new Error("no network in harness")),
};
sandbox.WebSocketSpy = WebSocketSpy;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "headgame.js" });
} catch (e) {
  console.error("THREW:", e && e.message);
  console.error(e && e.stack && e.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(2);
}

// Exported so a probe script can reuse these stubs instead of duplicating them.
module.exports = { sandbox, PHYS: sandbox.PHYS, WebSocketSpy };
