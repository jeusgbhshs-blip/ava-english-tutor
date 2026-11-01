/**
 * talking-head.js — Ava 实时口播动画引擎（v2.0 分层 2.5D）
 * ---------------------------------------------------------------------------
 * 纯浏览器原生 ESM，零依赖，只读素材：绝不修改、重绘或调色人物图片。
 *
 * v2.0「方案 A：分层 2.5D」：
 *   - 若 motion.layers = { fg, bg } 可加载，则 WebGL 两次绘制：
 *       1) bg：轻微缩放（1.02–1.03，避免露边）＋ ≤3px 慢视差；
 *       2) fg：与 bg 完全对齐的 RGBA 前景，alpha 混合到 bg 上；
 *          发丝多正弦波浪 / 衣摆低频轻摆（motion.flows 椭圆区域叠加）；
 *          再叠加口型 / 眨眼 / 视线漂移 / 表情微动 / 呼吸 / 头部轻摆。
 *   - 分层资源失败（404/解码失败）或 WebGL 不可用 → 自动回退旧单图引擎（<img> 静态）。
 *
 * 用法：
 *   const motion = await fetch('./assets/characters/motion.json').then(r => r.json());
 *   const th = createTalkingHead(hostEl, { image: './assets/characters/elena.jpg', motion: motion.elena });
 *   th.setMode('speaking'); th.setSpeechLevel(0.8);
 *
 * API（v1 兼容）：createTalkingHead(host, { image, motion, focal?, reducedMotion?, layers? }) →
 *   { el, setImage(src, motion?), setMode, setSpeechLevel, setFocal, blink, start, stop,
 *     destroy, ok, layered, speechLevel, blinkLevel }
 */

const MODES = ['idle', 'listening', 'speaking', 'thinking'];
// 口型有效驱动上限：传 1.0 实际也只到 0.7（防夸张/防融化）
const SPEECH_MAX = 0.7;
// 发丝/衣摆流动区域数量上限（shader 固定 6 槽，未用槽幅度为 0）
const MAX_FLOWS = 6;

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uTex;
uniform float uLayer;     // 0 = 背景层, 1 = 前景层（单图模式也走 1）
uniform float uFlowOn;    // 1 = 启用发丝/衣摆流动（仅分层前景）
uniform float uTime;

uniform vec2  uCover;     // object-fit: cover 的可见比例
uniform vec2  uFocus;     // 放在屏幕中心的图片 uv 点
uniform vec2  uLook;      // 视线/头部微平移
uniform vec4  uMouth;     // cx, cy, rx, ry（图片 uv，自上而下）
uniform vec4  uEye0;
uniform vec4  uEye1;
uniform vec4  uGuard;     // 脸部保护椭圆 cx,cy,rx,ry（发丝/衣摆不碰脸）
uniform vec4  uFlowRect[6]; // cx, cy, rx, ry
uniform vec4  uFlowA[6];    // ampX, ampY, freq(Hz), phase(rad)
uniform vec4  uFlowB[6];    // spatialK*speed, dirX, dirY, secondaryGain

uniform float uOpen;
uniform float uBlink;
uniform float uSquash;
uniform float uBreath;
uniform float uSway;
uniform float uBob;
uniform float uBgScale;
uniform vec2  uBgShift;

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float gauss(vec2 p, vec2 c, vec2 r, float k) {
  vec2 d = (p - c) / max(r, vec2(0.0008));
  return exp(-dot(d, d) * k);
}

// 流动区域权重：平滑四次衰减（比 exp 便宜），边界无硬切
float flowW(vec2 p, vec2 c, vec2 r) {
  vec2 d = (p - c) / max(r, vec2(0.0008));
  float dd = dot(d, d);
  float w = max(0.0, 1.0 - dd);
  return w * w;
}

// 抛物线近似的 sin（误差 <6%，对 2-6px 位移不可见；明显省 GPU/CPU）
float fastSin(float x) {
  float y = x - 6.2831853 * floor(x * 0.15915494 + 0.5);
  return y * (1.2732395 - 0.4052847 * abs(y));
}
float fastCos(float x) { return fastSin(x + 1.5707963); }

void main() {
  /* ---- 屏幕 uv -> 图片 uv（cover + focal 锚点，两层共用同一映射保证对齐） ---- */
  vec2 uv = (vUv - 0.5) * uCover + uFocus;

  /* ================= 背景层：轻微缩放 + 慢视差（≤3px） ================= */
  if (uLayer < 0.5) {
    vec2 c = uFocus;
    uv = c + (uv - c) / uBgScale + uBgShift;
    gl_FragColor = texture2D(uTex, clamp(uv, vec2(0.0005), vec2(0.9995)));
    return;
  }

  /* ================= 前景层 ================= */
  // 1) 发丝/衣摆流动场（仅前景；脸部保护椭圆内权重≈0）
  if (uFlowOn > 0.5) {
    float guard = flowW(uv, uGuard.xy, uGuard.zw);
    float allow = 1.0 - clamp(guard, 0.0, 1.0);
    vec2 flow = vec2(0.0);
    for (int i = 0; i < 6; i++) {
      vec4 r = uFlowRect[i];
      vec4 a = uFlowA[i];
      vec4 b = uFlowB[i];
      if (a.x > 0.0 || a.y > 0.0) {
        float w = flowW(uv, r.xy, r.zw) * allow;
        // 时间相位 + 空间相位（沿区域方向推进 => 波浪而不是整体平移）
        float th = 6.2831853 * a.z * uTime + a.w + b.x * ((uv.x - r.x) * b.y + (uv.y - r.y) * b.z);
        flow += w * vec2(a.x * fastSin(th), a.y * fastCos(th * 0.83 + 1.1));
        // 二次谐波（有机感，避免机械同步）
        flow += w * b.w * vec2(a.x * fastSin(th * 1.73 + 2.1), a.y * fastCos(th * 1.31 + 0.6));
      }
    }
    // 总位移限幅（≤约 8px @1024 层宽）
    float len = length(flow);
    flow *= min(1.0, 0.0078 / max(len, 1e-5));
    uv += flow;
  }

  // 2) 头部轻摆 / 呼吸 / 视线微漂 / 点头（只动前景，背景静止 => 2.5D 视差）
  vec2 f = uFocus;
  vec2 p = uv - f;
  p = rot2(uSway) * p;
  p *= uBreath;
  uv = f + p + uLook;
  uv.y += uBob;

  // 3) 眨眼：只挤眼区（掩膜收紧，不牵动眉毛/睫毛）
  float bt = clamp(uBlink, 0.0, 1.0) * uSquash;
  if (bt > 0.001) {
    float w0 = gauss(uv, uEye0.xy, uEye0.zw * vec2(1.05, 1.25), 4.2);
    uv.y = mix(uv.y, uEye0.y + (uv.y - uEye0.y) * (1.0 - 0.25 * bt), w0 * bt);
    float w1 = gauss(uv, uEye1.xy, uEye1.zw * vec2(1.05, 1.25), 4.2);
    uv.y = mix(uv.y, uEye1.y + (uv.y - uEye1.y) * (1.0 - 0.25 * bt), w1 * bt);
  }

  // 4) 口型（v2 小区域、小幅度，硬限幅 ±0.006）
  if (uOpen > 0.001) {
    vec2 base = uv;
    vec2 mr = vec2(max(uMouth.z, 0.004) * 1.5, max(uMouth.w, 0.004) * 2.0);
    float mw = gauss(uv, uMouth.xy, mr, 4.5);
    float wLow = gauss(uv, vec2(uMouth.x, uMouth.y - uMouth.w * 0.85), vec2(uMouth.z * 1.30, uMouth.w * 1.45), 4.5);
    uv.y += 0.0052 * uOpen * wLow;
    float wUp = gauss(uv, vec2(uMouth.x, uMouth.y + uMouth.w * 0.55), vec2(uMouth.z * 1.15, uMouth.w * 1.10), 5.0);
    uv.y -= 0.0015 * uOpen * wUp;
    float k = 1.0 - 0.16 * uOpen;
    uv.y = mix(uv.y, uMouth.y + (uv.y - uMouth.y) * k, mw * 0.8);
    uv.y = clamp(uv.y, base.y - 0.006, base.y + 0.006);
  }

  gl_FragColor = texture2D(uTex, clamp(uv, vec2(0.0012), vec2(0.9988)));
}
`;

const DEFAULT_MOTION = {
  mouth: { cx: 0.5, cy: 0.55, rx: 0.02, ry: 0.012 },
  eyes: [
    { cx: 0.44, cy: 0.42, rx: 0.02, ry: 0.015 },
    { cx: 0.56, cy: 0.42, rx: 0.02, ry: 0.015 },
  ],
  focal: { x: 0.5, y: 0.4 },
  sway: 0.006,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const NUM = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

function normalizeMotion(motion, image) {
  let m = motion;
  if (m && typeof m === 'object' && !m.mouth) {
    const key = String(image || '')
      .split('/')
      .pop()
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase();
    m = m[key] || m[Object.keys(m)[0]];
  }
  const out = {
    mouth: { ...DEFAULT_MOTION.mouth, ...(m && m.mouth) },
    eyes: Array.isArray(m && m.eyes) && m.eyes.length ? m.eyes.slice(0, 2) : DEFAULT_MOTION.eyes.map((e) => ({ ...e })),
    focal: { ...DEFAULT_MOTION.focal, ...(m && m.focal) },
    sway: NUM(m && m.sway, DEFAULT_MOTION.sway),
    layers:
      m && m.layers && (m.layers.fg || m.layers.bg)
        ? { fg: m.layers.fg || '', bg: m.layers.bg || '' }
        : null,
    flows: Array.isArray(m && m.flows) ? m.flows.slice(0, MAX_FLOWS) : [],
  };
  while (out.eyes.length < 2) out.eyes.push({ ...DEFAULT_MOTION.eyes[out.eyes.length] });
  for (const e of out.eyes) {
    e.rx = Math.max(0.004, NUM(e.rx, 0.02));
    e.ry = Math.max(0.004, NUM(e.ry, 0.015));
  }
  out.mouth.rx = Math.max(0.006, NUM(out.mouth.rx, 0.02));
  out.mouth.ry = Math.max(0.004, NUM(out.mouth.ry, 0.012));
  out.flows = out.flows
    .map((f) => ({
      type: f.type === 'cloth' ? 'cloth' : 'hair',
      cx: NUM(f.cx, 0.5),
      cy: NUM(f.cy, 0.5),
      rx: Math.max(0.02, NUM(f.rx, 0.1)),
      ry: Math.max(0.02, NUM(f.ry, 0.1)),
      ampX: clamp(NUM(f.ampX, 0), 0, 8),
      ampY: clamp(NUM(f.ampY, 0), 0, 8),
      freq: clamp(NUM(f.freq, 0.2), 0.02, 2),
      speed: clamp(NUM(f.speed, 1), 0, 4),
      phase: NUM(f.phase, 0),
    }))
    .filter((f) => f.ampX > 0.01 || f.ampY > 0.01);
  return out;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('talking-head: shader compile failed: ' + log);
  }
  return sh;
}

/**
 * 创建口播动画实例（分层 2.5D，API 与 v1 兼容）。
 * @param {HTMLElement} host
 * @param {{image?: string|HTMLImageElement, motion?: object, focal?: {x:number,y:number}, reducedMotion?: boolean, layers?: {fg?:string,bg?:string}}} [opts]
 */
export function createTalkingHead(host, opts = {}) {
  if (!host || !host.appendChild) throw new TypeError('talking-head: host element required');
  const { image = '', motion = null, focal: focalOverride = null } = opts;
  const forcedLayers =
    opts.layers && (opts.layers.fg || opts.layers.bg) ? { fg: opts.layers.fg || '', bg: opts.layers.bg || '' } : null;

  const reduceQuery =
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = opts.reducedMotion === true || (!!reduceQuery && reduceQuery.matches);

  const doc = host.ownerDocument || document;
  const win = doc.defaultView || window;

  /* ---------------- DOM ---------------- */
  const canvas = doc.createElement('canvas');
  canvas.className = 'talking-head-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
    userSelect: 'none',
  });
  try {
    if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';
  } catch (_) {}
  host.appendChild(canvas);

  /* ---------------- state ---------------- */
  const state = {
    mode: 'idle',
    target: 0,
    userDrivenLevel: false,
    level: 0,
    open: 0,
    blinkStart: -1,
    blinkDur: 0.26,
    blinkSquash: 1,
    nextBlink: 2.0 + Math.random() * 2.5,
    blinkClosure: 0,
    squint: 0,
    time: 0,
    running: false,
    raf: 0,
    last: 0,
    destroyed: false,
    motionCur: normalizeMotion(motion, image),
    focal: null,
    cover: [1, 1],
    focus: [0.5, 0.5],
    layerW: 1024,
    layerH: 768,
    layered: false,
    flowPxScale: 1 / 1024,
    loadToken: 0,
    img: null,
    fgImg: null,
    bgImg: null,
    imageUrl: '',
  };
  state.focal = focalOverride
    ? { x: NUM(focalOverride.x, 0.5), y: NUM(focalOverride.y, 0.5) }
    : { x: state.motionCur.focal.x, y: state.motionCur.focal.y };

  /* ---------------- WebGL ---------------- */
  let gl = null;
  let program = null;
  const tex = { fg: null, bg: null, single: null };
  let u = {};
  let fallbackImg = null;
  let ok = false;

  try {
    const attrs = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    gl =
      canvas.getContext('webgl', attrs) ||
      canvas.getContext('experimental-webgl', attrs) ||
      canvas.getContext('webgl2', attrs);
  } catch (_) {
    gl = null;
  }

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function uploadTexture(t, img) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }

  if (gl) {
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('talking-head: link failed: ' + gl.getProgramInfoLog(program));
      }
      gl.useProgram(program);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      for (const name of [
        'uTex', 'uLayer', 'uFlowOn', 'uTime', 'uCover', 'uFocus', 'uLook', 'uMouth', 'uEye0', 'uEye1',
        'uGuard', 'uOpen', 'uBlink', 'uSquash', 'uBreath', 'uSway', 'uBob', 'uBgScale', 'uBgShift',
      ]) {
        u[name] = gl.getUniformLocation(program, name);
      }
      u.uFlowRect = gl.getUniformLocation(program, 'uFlowRect[0]');
      u.uFlowA = gl.getUniformLocation(program, 'uFlowA[0]');
      u.uFlowB = gl.getUniformLocation(program, 'uFlowB[0]');

      tex.bg = makeTexture();
      // 占位深色 1x1，图片加载完成前不闪白
      gl.bindTexture(gl.TEXTURE_2D, tex.bg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 10, 16, 255]));

      gl.disable(gl.DEPTH_TEST);
      gl.viewport(0, 0, canvas.width, canvas.height);
      ok = true;
    } catch (err) {
      ok = false;
      gl = null;
      if (typeof console !== 'undefined') console.warn('[talking-head] WebGL init failed, fallback <img>:', err);
    }
  }

  /* ---------------- fallback <img> ---------------- */
  function ensureFallback() {
    if (fallbackImg || !state.imageUrl) return;
    fallbackImg = doc.createElement('img');
    fallbackImg.alt = '';
    fallbackImg.decoding = 'async';
    fallbackImg.src = state.imageUrl;
    Object.assign(fallbackImg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      objectPosition: `${(state.focal.x * 100).toFixed(2)}% ${(state.focal.y * 100).toFixed(2)}%`,
      display: 'block',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    host.appendChild(fallbackImg);
  }
  if (!ok) canvas.style.display = 'none';

  /* ---------------- 尺寸 / cover 映射 ---------------- */
  const FIT_EPS = 1e-4;
  function resize() {
    if (state.destroyed) return;
    const dpr = clamp(win.devicePixelRatio || 1, 1, 2);
    const cw = Math.max(1, Math.round((host.clientWidth || 1) * dpr));
    const ch = Math.max(1, Math.round((host.clientHeight || 1) * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      if (gl) gl.viewport(0, 0, cw, ch);
    }
    const ca = cw / ch;
    const ia = state.layerW / state.layerH;
    let sx = 1;
    let sy = 1;
    if (ca > ia) sy = ia / ca;
    else sx = ca / ia;
    state.cover = [sx, sy];
    const fx = sx < 1 - FIT_EPS ? clamp(state.focal.x, 0.5 * sx, 1 - 0.5 * sx) : 0.5;
    const fy = sy < 1 - FIT_EPS ? clamp(state.focal.y, 0.5 * sy, 1 - 0.5 * sy) : 0.5;
    state.focus = [fx, fy];
    if (fallbackImg) fallbackImg.style.objectPosition = `${(fx * 100).toFixed(2)}% ${(fy * 100).toFixed(2)}%`;
    draw(0);
  }

  /* ---------------- 渲染 ---------------- */
  function setCommonUniforms(t) {
    const m = state.motionCur;
    const e0 = m.eyes[0];
    const e1 = m.eyes[1];
    const rect = new Float32Array(MAX_FLOWS * 4);
    const amp = new Float32Array(MAX_FLOWS * 4);
    const extra = new Float32Array(MAX_FLOWS * 4);
    for (let i = 0; i < MAX_FLOWS; i++) {
      const f = m.flows[i];
      if (!f) continue;
      rect[i * 4] = f.cx;
      rect[i * 4 + 1] = f.cy;
      rect[i * 4 + 2] = f.rx;
      rect[i * 4 + 3] = f.ry;
      amp[i * 4] = f.ampX * state.flowPxScale;
      amp[i * 4 + 1] = f.ampY * state.flowPxScale;
      amp[i * 4 + 2] = f.freq;
      amp[i * 4 + 3] = f.phase;
      extra[i * 4] = (f.type === 'cloth' ? 9.0 : 14.0) * f.speed;
      extra[i * 4 + 1] = f.type === 'cloth' ? 1.0 : 0.75;
      extra[i * 4 + 2] = f.type === 'cloth' ? 0.35 : 0.9;
      extra[i * 4 + 3] = f.type === 'cloth' ? 0.28 : 0.32;
    }
    gl.uniform4fv(u.uFlowRect, rect);
    gl.uniform4fv(u.uFlowA, amp);
    gl.uniform4fv(u.uFlowB, extra);

    // 脸部保护椭圆：由双眼+嘴的位置自动推导（发丝/衣摆权重在脸内≈0）
    const faceCx = (e0.cx + e1.cx + m.mouth.cx) / 3;
    const faceCy = (e0.cy + e1.cy + m.mouth.cy) / 3;
    gl.uniform4f(u.uGuard, faceCx, 1 - faceCy, 0.10, 0.145);
    gl.uniform4f(u.uMouth, m.mouth.cx, 1 - m.mouth.cy, m.mouth.rx, m.mouth.ry);
    gl.uniform4f(u.uEye0, e0.cx, 1 - e0.cy, e0.rx, e0.ry);
    gl.uniform4f(u.uEye1, e1.cx, 1 - e1.cy, e1.rx, e1.ry);
    gl.uniform2f(u.uCover, state.cover[0], state.cover[1]);
    gl.uniform2f(u.uFocus, state.focus[0], 1 - state.focus[1]);

    // 背景：1.020–1.028 慢缩放（避免露边）+ ≤3px 视差
    // 背景：1.022–1.026 极慢缩放（避免露边）+ ≤1.2px 视差
    gl.uniform1f(u.uBgScale, 1.022 + 0.004 * (0.5 + 0.5 * Math.sin(t * 0.55)));
    gl.uniform2f(u.uBgShift, 0.0012 * Math.sin(t * 0.22), 0.0009 * Math.sin(t * 0.17 + 0.9));
  }

  function draw(dt) {
    if (!ok || !gl) return;
    const m = state.motionCur;
    const t = state.time;
    const mode = state.mode;

    let breathAmp = 0.0032;
    let swayAmp = m.sway * 0.55;
    let lookX = 0;
    let lookY = 0;
    let bobFreq = 0.9;
    let bobAmp = 0.0007;
    let blinkIntervalScale = 1;

    if (mode === 'listening') {
      breathAmp = 0.0045;
      swayAmp = m.sway * 0.4;
      bobFreq = 1.15;
      bobAmp = 0.0013;
      lookY = 0.0008;
      blinkIntervalScale = 0.9;
    } else if (mode === 'speaking') {
      breathAmp = 0.0045;
      swayAmp = m.sway * 0.6;
      bobFreq = 2.4;
      bobAmp = 0.0012;
      blinkIntervalScale = 0.88;
      lookY = -0.0004;
    } else if (mode === 'thinking') {
      breathAmp = 0.003;
      swayAmp = m.sway * 0.3;
      bobFreq = 0.55;
      bobAmp = 0.0005;
      lookX = -0.0016;
      lookY = 0.0018;
      blinkIntervalScale = 1.05;
    }

    let open = 0;
    if (mode === 'speaking') {
      const syl =
        0.5 +
        0.5 *
          Math.sin(t * Math.PI * 2 * 3.15 + 0.9 * Math.sin(t * Math.PI * 2 * 1.35 + 0.4)) *
          (0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 2.05 + 2.1));
      const targetOpen = clamp(state.level, 0, SPEECH_MAX) * (0.62 + 0.38 * clamp(syl, 0, 1));
      open = clamp(targetOpen, 0, SPEECH_MAX);
    }
    state.open += (open - state.open) * (1 - Math.exp(-(dt || 0.016) / 0.06));
    state.open = clamp(state.open, 0, SPEECH_MAX);

    // 眨眼（v1.8：0.22–0.30s 余弦缓动、无二次补眨、间隔 3.5–7.5s）
    let closure = 0;
    if (state.blinkStart >= 0) {
      const p = (t - state.blinkStart) / state.blinkDur;
      if (p >= 1) {
        state.blinkStart = -1;
        state.nextBlink = t + blinkIntervalScale * (3.5 + Math.random() * 4.0);
      } else if (p < 0.35) {
        closure = 0.5 - 0.5 * Math.cos((Math.PI * p) / 0.35);
      } else {
        closure = 0.5 + 0.5 * Math.cos((Math.PI * (p - 0.35)) / 0.65);
      }
    } else if (!reduced && t >= state.nextBlink) {
      state.blinkStart = t;
      state.blinkDur = 0.22 + Math.random() * 0.08;
      state.blinkSquash = 0.88 + Math.random() * 0.24;
    }
    state.blinkClosure = clamp(closure, 0, 1);
    state.squint += ((mode === 'thinking' ? 0.06 : 0) - state.squint) * (1 - Math.exp(-(dt || 0.016) / 0.2));

    const breath = 1 + Math.min(breathAmp, 0.0075) * (0.5 + 0.5 * Math.sin(t * 0.85 * Math.PI * 2 * 0.32));
    const tilt = 0.0011 * Math.sin((2 * Math.PI * t) / 3.7 + 1.1) + 0.0006 * Math.sin((2 * Math.PI * t) / 2.4 + 0.4);
    const sway = clamp(
      swayAmp *
        (0.62 * Math.sin(t * 0.55) +
          0.38 * Math.sin(t * 0.23 + 1.7) +
          (mode === 'speaking' ? 0.12 * Math.sin(t * 4.2) * (0.3 + state.open) : 0)) +
        tilt,
      -0.0069,
      0.0069,
    );
    const bob =
      bobAmp * Math.sin(t * Math.PI * 2 * bobFreq) * (mode === 'speaking' ? 0.4 + 0.9 * state.open : 1) +
      (mode === 'speaking' ? 0.0006 * state.open * Math.sin(t * 21.0) : 0);

    const gazeX = 0.0008 * (0.6 * Math.sin((2 * Math.PI * t) / 4.3 + 0.6) + 0.4 * Math.sin((2 * Math.PI * t) / 2.3 + 2.1));
    const gazeY = 0.00065 * (0.55 * Math.sin((2 * Math.PI * t) / 5.2 + 1.4) + 0.45 * Math.sin((2 * Math.PI * t) / 3.1 + 0.3));

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uOpen, state.open);
    gl.uniform1f(u.uBlink, clamp(state.blinkClosure + state.squint, 0, 1));
    gl.uniform1f(u.uSquash, state.blinkSquash);
    gl.uniform1f(u.uBreath, breath);
    gl.uniform1f(u.uSway, sway);
    gl.uniform2f(u.uLook, gazeX + lookX, gazeY + lookY);
    gl.uniform1f(u.uBob, bob);
    setCommonUniforms(t);

    if (state.layered) {
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, tex.bg);
      gl.uniform1f(u.uLayer, 0);
      gl.uniform1f(u.uFlowOn, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindTexture(gl.TEXTURE_2D, tex.fg);
      gl.uniform1f(u.uLayer, 1);
      gl.uniform1f(u.uFlowOn, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, tex.single || tex.bg);
      gl.uniform1f(u.uLayer, 1);
      gl.uniform1f(u.uFlowOn, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* ---------------- 主循环 ---------------- */
  function tick(now) {
    if (state.destroyed || !state.running) return;
    state.raf = win.requestAnimationFrame(tick);
    const dt = state.last ? clamp((now - state.last) / 1000, 0, 0.05) : 0.016;
    state.last = now;
    state.time += dt;
    const autoSpeak = state.mode === 'speaking' && !state.userDrivenLevel;
    const target = clamp(autoSpeak ? 0.55 : state.target, 0, SPEECH_MAX);
    state.level += (target - state.level) * (1 - Math.exp(-dt / 0.1));
    draw(dt);
  }

  function start() {
    if (state.destroyed || reduced || !ok) return;
    if (state.running) return;
    state.running = true;
    state.last = 0;
    state.raf = win.requestAnimationFrame(tick);
  }

  function stop() {
    state.running = false;
    if (state.raf && win.cancelAnimationFrame) win.cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.last = 0;
  }

  /* ---------------- 加载 ---------------- */
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error('empty src'));
      if (typeof src !== 'string') {
        if (src.naturalWidth || src.width) return resolve(src);
        return reject(new Error('bad image object'));
      }
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
    });
  }

  function layerPath(p, base) {
    if (!p) return '';
    if (/^(https?:|data:|blob:|\/)/i.test(p)) return p;
    if (p.startsWith('./') || p.startsWith('../')) return p;
    const m = /^(.*\/)/.exec(base || '');
    return (m ? m[1] : '') + p;
  }

  function applyImageSizes(w, h) {
    if (w > 0 && h > 0) {
      state.layerW = w;
      state.layerH = h;
      state.flowPxScale = 1 / Math.max(256, w);
    }
  }

  function singleMode() {
    state.layered = false;
    if (fallbackImg) fallbackImg.style.display = '';
    resize();
    draw(0);
    if (!reduced) start();
  }

  function loadSingle(src) {
    const token = ++state.loadToken;
    state.imageUrl = typeof src === 'string' ? src : (src && (src.currentSrc || src.src)) || '';
    if (!ok) {
      ensureFallback();
      if (fallbackImg) fallbackImg.src = state.imageUrl;
      singleMode();
      return;
    }
    loadImageEl(src)
      .then((img) => {
        if (state.destroyed || token !== state.loadToken) return;
        try {
          if (!tex.single) tex.single = makeTexture();
          uploadTexture(tex.single, img);
        } catch (err) {
          console.warn('[talking-head] texture upload failed, fallback <img>:', err);
          ok = false;
          gl = null;
          canvas.style.display = 'none';
          ensureFallback();
          if (fallbackImg) fallbackImg.src = state.imageUrl;
          singleMode();
          return;
        }
        applyImageSizes(img.naturalWidth, img.naturalHeight);
        state.img = img;
        if (fallbackImg) fallbackImg.src = state.imageUrl;
        singleMode();
      })
      .catch((err) => {
        if (state.destroyed || token !== state.loadToken) return;
        console.warn('[talking-head]', err.message || err);
        ensureFallback();
        singleMode();
      });
  }

  function loadLayered(layers, fallbackImage) {
    const token = ++state.loadToken;
    state.imageUrl = typeof fallbackImage === 'string' ? fallbackImage : '';
    if (!ok) {
      ensureFallback();
      if (fallbackImg) fallbackImg.src = state.imageUrl;
      singleMode();
      return;
    }
    const fgSrc = layerPath(layers.fg, state.imageUrl);
    const bgSrc = layerPath(layers.bg, state.imageUrl);
    const needBg = !!bgSrc;
    Promise.all([loadImageEl(fgSrc), needBg ? loadImageEl(bgSrc).catch(() => null) : Promise.resolve(null)])
      .then(([fgImg, bgImg]) => {
        if (state.destroyed || token !== state.loadToken) return;
        if (!fgImg) throw new Error('fg missing');
        if (!bgImg) throw new Error('bg missing');
        uploadTexture((tex.fg = tex.fg || makeTexture()), fgImg);
        uploadTexture((tex.bg = tex.bg || makeTexture()), bgImg);
        state.fgImg = fgImg;
        state.bgImg = bgImg;
        applyImageSizes(fgImg.naturalWidth || fgImg.width, fgImg.naturalHeight || fgImg.height);
        if (fallbackImg) fallbackImg.src = state.imageUrl;
        state.layered = true;
        resize();
        draw(0);
        if (!reduced) start();
      })
      .catch((err) => {
        if (state.destroyed || token !== state.loadToken) return;
        console.warn('[talking-head] layers unavailable, fallback to single image:', err.message || err);
        loadSingle(fallbackImage);
      });
  }

  function applyLayers(layers, fallbackImage) {
    if (layers && (layers.fg || layers.bg)) loadLayered(layers, fallbackImage);
    else loadSingle(fallbackImage);
  }

  function loadImage(src) {
    const layers = state.motionCur.layers || forcedLayers;
    if (layers && (layers.fg || layers.bg)) loadLayered(layers, src);
    else loadSingle(src);
  }

  /* ---------------- 观察尺寸 / 可见性 ---------------- */
  let ro = null;
  try {
    ro = new win.ResizeObserver(() => resize());
    ro.observe(host);
  } catch (_) {
    ro = null;
  }
  const onWinResize = () => resize();
  win.addEventListener('resize', onWinResize);
  const onVis = () => {
    if (doc.hidden) stop();
    else if (!reduced) start();
  };
  doc.addEventListener('visibilitychange', onVis);

  let mqHandler = null;
  if (reduceQuery) {
    mqHandler = () => {
      reduced = opts.reducedMotion === true || reduceQuery.matches;
      if (reduced) {
        stop();
        draw(0);
      } else start();
    };
    if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', mqHandler);
    else if (reduceQuery.addListener) reduceQuery.addListener(mqHandler);
  }

  resize();
  if (forcedLayers) {
    state.motionCur.layers = forcedLayers;
    applyLayers(forcedLayers, image);
  } else {
    loadImage(image);
  }

  /* ---------------- 对外 API ---------------- */
  const api = {
    el: canvas,
    get ok() {
      return ok;
    },
    get layered() {
      return state.layered;
    },
    get reducedMotion() {
      return reduced;
    },
    get mode() {
      return state.mode;
    },
    get loaded() {
      return !!state.fgImg || !!state.img || !ok;
    },
    get speechLevel() {
      return state.open;
    },
    get blinkLevel() {
      return clamp(state.blinkClosure + state.squint, 0, 1);
    },

    setImage(src, nextMotion) {
      if (state.destroyed) return api;
      if (nextMotion) {
        state.motionCur = normalizeMotion(nextMotion, typeof src === 'string' ? src : '');
        state.focal = { x: state.motionCur.focal.x, y: state.motionCur.focal.y };
      }
      loadImage(src);
      return api;
    },

    setMode(mode) {
      if (state.destroyed) return api;
      state.mode = MODES.indexOf(mode) >= 0 ? mode : 'idle';
      if (state.mode !== 'speaking') state.target = Math.min(state.target, 0.15);
      return api;
    },

    setSpeechLevel(level) {
      state.userDrivenLevel = true;
      state.target = clamp(Number(level) || 0, 0, 1);
      return api;
    },

    setFocal(x, y) {
      if (state.destroyed) return api;
      state.focal = { x: clamp(Number(x) || 0.5, 0, 1), y: clamp(Number(y) || 0.5, 0, 1) };
      resize();
      return api;
    },

    blink() {
      if (state.destroyed || reduced) return api;
      if (state.blinkStart < 0) {
        state.blinkStart = state.time;
        state.blinkDur = 0.26;
        state.blinkSquash = 1;
        state.nextBlink = state.time + 3.5 + Math.random() * 4.0;
      }
      return api;
    },

    start() {
      start();
      return api;
    },

    stop() {
      stop();
      return api;
    },

    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      stop();
      try {
        ro && ro.disconnect();
      } catch (_) {}
      win.removeEventListener('resize', onWinResize);
      doc.removeEventListener('visibilitychange', onVis);
      if (reduceQuery && mqHandler) {
        if (reduceQuery.removeEventListener) reduceQuery.removeEventListener('change', mqHandler);
        else if (reduceQuery.removeListener) reduceQuery.removeListener(mqHandler);
      }
      try {
        if (gl) {
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
          for (const k of ['fg', 'bg', 'single']) if (tex[k]) gl.deleteTexture(tex[k]);
          if (program) gl.deleteProgram(program);
        }
      } catch (_) {}
      gl = null;
      fallbackImg && fallbackImg.remove();
      canvas.remove();
      state.img = null;
      state.fgImg = null;
      state.bgImg = null;
    },
  };

  return api;
}

export default createTalkingHead;
