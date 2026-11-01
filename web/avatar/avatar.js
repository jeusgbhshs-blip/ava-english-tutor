/**
 * Ava — AI 数字人英语老师：渲染 + 动画 + 口型引擎
 * ------------------------------------------------------------------
 * 契约：SPEC.md 第 4 节
 *   import { mountAvatar } from './avatar/avatar.js'
 *   const avatar = mountAvatar(container, { teacherName:'Ava', level:'A2', theme:'teal-violet' })
 *
 * 返回 API（全部幂等、可高频调用）：
 *   setState('idle'|'listening'|'thinking'|'speaking'|'celebrate'|'sad'|'encouraging')
 *   setEmotion('neutral'|'happy'|'proud'|'curious'|'thinking'|'encouraging'|'surprised')
 *   beginSpeech({ text, durationMs? }) / wordBoundary({ word, charIndex, elapsedMs }) / endSpeech()
 *   setSpeechLevel(0..1)  // v1.4：外部实时振幅（豆包 PCM 播放）优先驱动口型，endSpeech 后复位
 *   setMicLevel(0..1) / setSpeechLevel(0..1) / setLevel('A2') / setTeacherName('Ava')
 *   wave() / nod() / blink() / destroy()
 * 额外便捷方法（非契约必需）：setReducedMotion(bool) / setHudVisible(bool) / el
 *
 * 纯内联 SVG + CSS + 原生 JS，零外部依赖、零网络请求。
 */

export const AVATAR_VERSION = '1.1.0';

const NS = 'http://www.w3.org/2000/svg';

const STATE_META = {
  idle:        { emotion: 'neutral',    label: '待机',   aria: '待机中' },
  listening:   { emotion: 'curious',    label: '聆听中', aria: '正在聆听你说话' },
  thinking:    { emotion: 'thinking',   label: '思考中', aria: '正在思考' },
  speaking:    { emotion: 'neutral',    label: '说话中', aria: '正在说话' },
  celebrate:   { emotion: 'happy',      label: '太棒了', aria: '在为你庆祝' },
  sad:         { emotion: 'sad',        label: '有点低落', aria: '看起来有点低落' },
  encouraging: { emotion: 'encouraging', label: '鼓励你', aria: '正在鼓励你' },
};

const EMOTIONS = ['neutral', 'happy', 'proud', 'curious', 'thinking', 'encouraging', 'surprised'];
const VISEMES = ['rest', 'aa', 'ee', 'o', 'u', 'mf'];

/* ------------------------------------------------------------------ *
 * 口型计划：把文本拆成 [{t0,t1,viseme}] 时间轴（不依赖 TTS 回调）
 * ------------------------------------------------------------------ */

const VOWEL_VISEME = { a: 'aa', e: 'ee', i: 'ee', o: 'o', u: 'u', y: 'ee' };
const FRICATIVE = 'szcx';
const LABIAL = 'mbpfv';

function visemeForChar(ch) {
  const c = String(ch).toLowerCase();
  if (VOWEL_VISEME[c]) return VOWEL_VISEME[c];
  if (FRICATIVE.includes(c)) return 'ee';
  if (LABIAL.includes(c)) return 'mf';
  if (/[a-z0-9]/.test(c)) return 'rest';
  if (c === ' ') return 'rest';
  return 'rest';
}

function charWeight(ch) {
  const c = String(ch);
  if (c === ' ') return 0.5;
  if (/[.!?]/.test(c)) return 1.1;
  if (/[,;:]/.test(c)) return 0.7;
  if (/[a-z0-9]/i.test(c)) return VOWEL_VISEME[c.toLowerCase()] ? 1 : 0.5;
  return 0.5;
}

function buildSpeechPlan(text, durationMs) {
  const chars = Array.from(String(text || ''));
  const weights = chars.map(charWeight);
  const rawTotal = weights.reduce((a, b) => a + b, 0);
  const lead = 60;
  const target = Number.isFinite(durationMs) && durationMs > 200
    ? Math.max(320, durationMs)
    : Math.max(650, rawTotal * 122);
  const k = target / Math.max(rawTotal, 0.001);
  const segments = [];
  const charTimes = new Float64Array(chars.length + 1);
  let t = lead;
  for (let i = 0; i < chars.length; i++) {
    charTimes[i] = t;
    const d = Math.max(34, weights[i] * k);
    const v = visemeForChar(chars[i]);
    const last = segments[segments.length - 1];
    if (last && last.v === v) last.t1 = t + d;
    else segments.push({ t0: t, t1: t + d, v });
    t += d;
  }
  charTimes[chars.length] = t;
  return { segments, charTimes, total: t + 90, lead };
}

const PROCEDURAL = ['aa', 'ee', 'o', 'rest', 'ee', 'aa', 'u', 'mf', 'o', 'ee', 'rest', 'aa', 'ee', 'o'];

function proceduralViseme(nowMs) {
  const idx = Math.floor(nowMs / 116);
  return PROCEDURAL[((idx % PROCEDURAL.length) + PROCEDURAL.length) % PROCEDURAL.length];
}

/* ------------------------------------------------------------------ *
 * 样式注入（避免每个使用方都手动引 CSS）
 * ------------------------------------------------------------------ */

const STYLE_HREF = (() => {
  try { return new URL('./avatar.css', import.meta.url).href; } catch { return './avatar.css'; }
})();

function ensureStyles() {
  if (typeof document === 'undefined') return null;
  const found = document.querySelector('link[data-ava-styles]');
  if (found) return found;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.setAttribute('data-ava-styles', '');
  document.head.appendChild(link);
  return link;
}

/* ------------------------------------------------------------------ *
 * 场景 SVG（全部内联，id 带实例前缀，多实例安全）
 * ------------------------------------------------------------------ */

function sceneMarkup(u) {
  return `
<svg class="ava-svg" viewBox="0 0 720 820" preserveAspectRatio="xMidYMid meet" role="presentation" focusable="false">
  <defs>
    <radialGradient id="${u}-glow-teal" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#5eead4" stop-opacity=".46"/>
      <stop offset="40%" stop-color="#2dd4bf" stop-opacity=".15"/>
      <stop offset="100%" stop-color="#0f766e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-glow-violet" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#a78bfa" stop-opacity=".42"/>
      <stop offset="42%" stop-color="#7c5cf0" stop-opacity=".14"/>
      <stop offset="100%" stop-color="#4c1d95" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-glow-warm" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffb86b" stop-opacity=".4"/>
      <stop offset="45%" stop-color="#f59e0b" stop-opacity=".12"/>
      <stop offset="100%" stop-color="#92400e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-glow-rose" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fb7185" stop-opacity=".26"/>
      <stop offset="50%" stop-color="#be123c" stop-opacity=".08"/>
      <stop offset="100%" stop-color="#4c0519" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-flash" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff6dd" stop-opacity=".85"/>
      <stop offset="34%" stop-color="#ffd28a" stop-opacity=".38"/>
      <stop offset="100%" stop-color="#ffb86b" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-blush" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ff8e8e" stop-opacity=".7"/>
      <stop offset="100%" stop-color="#ff8e8e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${u}-led" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#affcf0" stop-opacity=".9"/>
      <stop offset="55%" stop-color="#5eead4" stop-opacity=".35"/>
      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${u}-halo-line" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5eead4" stop-opacity="0"/>
      <stop offset="30%" stop-color="#5eead4" stop-opacity=".85"/>
      <stop offset="58%" stop-color="#a78bfa" stop-opacity=".65"/>
      <stop offset="82%" stop-color="#a78bfa" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${u}-skin" x1=".22" y1="0" x2=".78" y2="1">
      <stop offset="0%" stop-color="#ffdcc2"/>
      <stop offset="42%" stop-color="#f7c6a4"/>
      <stop offset="100%" stop-color="#e7aa87"/>
    </linearGradient>
    <linearGradient id="${u}-skin-neck" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2a37f"/>
      <stop offset="55%" stop-color="#efb894"/>
      <stop offset="100%" stop-color="#f5c3a1"/>
    </linearGradient>
    <linearGradient id="${u}-hair" x1=".18" y1="0" x2=".82" y2="1">
      <stop offset="0%" stop-color="#4a2a1d"/>
      <stop offset="38%" stop-color="#341d14"/>
      <stop offset="100%" stop-color="#1d0f0a"/>
    </linearGradient>
    <linearGradient id="${u}-hair-light" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8a5a3c" stop-opacity=".85"/>
      <stop offset="100%" stop-color="#8a5a3c" stop-opacity=".1"/>
    </linearGradient>
    <linearGradient id="${u}-hair-gloss" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#b98a63" stop-opacity="0"/>
      <stop offset="35%" stop-color="#c79772" stop-opacity=".6"/>
      <stop offset="70%" stop-color="#8f6a9f" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${u}-blazer" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0%" stop-color="#2c3c69"/>
      <stop offset="55%" stop-color="#1d2950"/>
      <stop offset="100%" stop-color="#121b36"/>
    </linearGradient>
    <linearGradient id="${u}-lapel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3a4c7e"/>
      <stop offset="100%" stop-color="#243257"/>
    </linearGradient>
    <linearGradient id="${u}-blouse" x1="0" y1="0" x2=".85" y2="1">
      <stop offset="0%" stop-color="#f6f0e8"/>
      <stop offset="55%" stop-color="#e9e1d7"/>
      <stop offset="100%" stop-color="#cfc6bb"/>
    </linearGradient>
    <radialGradient id="${u}-iris" cx="34%" cy="28%" r="82%">
      <stop offset="0%" stop-color="#8ef7e4"/>
      <stop offset="38%" stop-color="#3ce0c4"/>
      <stop offset="78%" stop-color="#159c8f"/>
      <stop offset="100%" stop-color="#0b6b66"/>
    </radialGradient>
    <linearGradient id="${u}-sclera" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fffdfb"/>
      <stop offset="70%" stop-color="#fdf3ee"/>
      <stop offset="100%" stop-color="#f0ddd6"/>
    </linearGradient>
    <linearGradient id="${u}-mouth-inner" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4c1622"/>
      <stop offset="55%" stop-color="#6e2030"/>
      <stop offset="100%" stop-color="#8d2c3e"/>
    </linearGradient>
    <linearGradient id="${u}-sleeve" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2a3a64"/>
      <stop offset="100%" stop-color="#16203a"/>
    </linearGradient>
  </defs>

  <!-- ================= 背景氛围 ================= -->
  <g class="ava-scene" aria-hidden="true">
    <g class="ava-halo">
      <circle class="ava-glow ava-glow--teal" cx="322" cy="268" r="332" fill="url(#${u}-glow-teal)"/>
      <circle class="ava-glow ava-glow--violet" cx="436" cy="378" r="332" fill="url(#${u}-glow-violet)"/>
      <circle class="ava-glow ava-glow--warm" cx="360" cy="430" r="300" fill="url(#${u}-glow-warm)" opacity="0"/>
      <circle class="ava-glow ava-glow--rose" cx="360" cy="390" r="300" fill="url(#${u}-glow-rose)" opacity="0"/>
      <g class="ava-halo-rings">
        <circle class="ava-halo-ring ava-halo-ring--a" cx="360" cy="306" r="246" fill="none" stroke="url(#${u}-halo-line)" stroke-width="1.7" stroke-dasharray="2 13"/>
        <circle class="ava-halo-ring ava-halo-ring--b" cx="360" cy="306" r="282" fill="none" stroke="url(#${u}-halo-line)" stroke-width="1" stroke-dasharray="1 26" opacity=".6"/>
        <circle class="ava-halo-ring ava-halo-ring--c" cx="360" cy="306" r="206" fill="none" stroke="#5eead4" stroke-opacity=".1" stroke-width="1"/>
        <g class="ava-orbit ava-orbit--a"><circle cx="360" cy="60" r="3.2" fill="#5eead4" opacity=".9"/><circle cx="360" cy="60" r="9" fill="url(#${u}-led)" opacity=".5"/></g>
        <g class="ava-orbit ava-orbit--b"><circle cx="642" cy="306" r="2.4" fill="#a78bfa" opacity=".9"/></g>
        <g class="ava-orbit ava-orbit--c"><circle cx="360" cy="552" r="2" fill="#ffb86b" opacity=".75"/></g>
      </g>
      <g class="ava-mic-ring">
        <circle class="ava-mic-ring__main" cx="360" cy="306" r="248" fill="none" stroke="#5eead4" stroke-width="2.4" opacity=".3"/>
        <circle class="ava-mic-ring__sub" cx="360" cy="306" r="264" fill="none" stroke="#a78bfa" stroke-width="1.2" opacity=".18"/>
      </g>
      <circle class="ava-flash" cx="360" cy="336" r="360" fill="url(#${u}-flash)" opacity="0"/>
      <g class="ava-think" opacity="0">
        <circle class="ava-think__ring" cx="360" cy="306" r="158" fill="none" stroke="#a78bfa" stroke-width="1.4" stroke-dasharray="5 17" opacity=".65"/>
        <circle class="ava-think__dot ava-think__dot--1" cx="516" cy="196" r="5" fill="#a78bfa"/>
        <circle class="ava-think__dot ava-think__dot--2" cx="540" cy="172" r="3.6" fill="#8b7bf0" opacity=".85"/>
        <circle class="ava-think__dot ava-think__dot--3" cx="558" cy="154" r="2.6" fill="#8b7bf0" opacity=".65"/>
      </g>
    </g>

    <!-- 悬浮平台 / 地面光圈 -->
    <g class="ava-floor" aria-hidden="true">
      <ellipse class="ava-floor__glow" cx="360" cy="838" rx="316" ry="132" fill="url(#${u}-glow-teal)" opacity=".28"/>
      <ellipse class="ava-floor__ring ava-floor__ring--1" cx="360" cy="808" rx="266" ry="46" fill="none" stroke="#5eead4" stroke-opacity=".15" stroke-width="1.2"/>
      <ellipse class="ava-floor__ring ava-floor__ring--2" cx="360" cy="808" rx="198" ry="32" fill="none" stroke="#a78bfa" stroke-opacity=".12" stroke-width="1"/>
      <path class="ava-floor__line" d="M112 768 L 268 768 M 452 768 L 608 768" stroke="#5eead4" stroke-opacity=".12" stroke-width="1.2" stroke-linecap="round"/>
      <path class="ava-floor__line" d="M136 790 L 236 790 M 484 790 L 584 790" stroke="#a78bfa" stroke-opacity=".1" stroke-width="1" stroke-linecap="round"/>
    </g>

    <!-- 漂浮粒子 -->
    <g class="ava-particles" aria-hidden="true">
      <circle class="ava-mote ava-mote--1" cx="182" cy="242" r="2.4" fill="#5eead4"/>
      <circle class="ava-mote ava-mote--2" cx="548" cy="196" r="2" fill="#a78bfa"/>
      <circle class="ava-mote ava-mote--3" cx="628" cy="424" r="1.8" fill="#5eead4"/>
      <circle class="ava-mote ava-mote--4" cx="118" cy="462" r="1.6" fill="#a78bfa"/>
      <circle class="ava-mote ava-mote--5" cx="252" cy="136" r="1.8" fill="#ffb86b"/>
      <circle class="ava-mote ava-mote--6" cx="478" cy="112" r="2.2" fill="#5eead4"/>
      <circle class="ava-mote ava-mote--7" cx="666" cy="288" r="1.5" fill="#5eead4"/>
      <circle class="ava-mote ava-mote--8" cx="76" cy="338" r="2" fill="#a78bfa"/>
      <circle class="ava-mote ava-mote--9" cx="574" cy="562" r="1.8" fill="#5eead4"/>
      <circle class="ava-mote ava-mote--10" cx="152" cy="620" r="1.5" fill="#ffb86b"/>
      <g class="ava-spark ava-spark--1" transform="translate(520 152)"><path class="ava-spark__path" d="M0 -7 C1 -1.8 1.8 -1 7 0 C1.8 1 1 1.8 0 7 C-1 1.8 -1.8 1 -7 0 C-1.8 -1 -1 -1.8 0 -7 Z" fill="#5eead4"/></g>
      <g class="ava-spark ava-spark--2" transform="translate(140 296)"><path class="ava-spark__path" d="M0 -6 C1 -1.6 1.6 -1 6 0 C1.6 1 1 1.6 0 6 C-1 1.6 -1.6 1 -6 0 C-1.6 -1 -1 -1.6 0 -6 Z" fill="#a78bfa"/></g>
      <g class="ava-spark ava-spark--3" transform="translate(648 512)"><path class="ava-spark__path" d="M0 -5 C.8 -1.4 1.4 -.8 5 0 C1.4 .8 .8 1.4 0 5 C-.8 1.4 -1.4 .8 -5 0 C-1.4 -.8 -.8 -1.4 0 -5 Z" fill="#ffb86b"/></g>
      <g class="ava-spark ava-spark--4" transform="translate(88 570)"><path class="ava-spark__path" d="M0 -5 C.8 -1.4 1.4 -.8 5 0 C1.4 .8 .8 1.4 0 5 C-.8 1.4 -1.4 .8 -5 0 C-1.4 -.8 -.8 -1.4 0 -5 Z" fill="#5eead4"/></g>
    </g>

    <g class="ava-confetti"></g>
  </g>

  <!-- ================= 角色 ================= -->
  <g class="ava-body">
    <g class="ava-rig">
      <g class="ava-breathe">

        <!-- 后发 -->
        <g class="ava-hair-back">
          <path d="M360 112 C 246 112 190 188 192 306 C 193 362 188 414 174 472 C 158 542 144 620 140 700 C 172 726 220 728 258 712 C 298 696 322 668 336 634 L 384 634 C 398 668 422 696 462 712 C 500 728 548 726 580 700 C 576 620 562 542 546 472 C 532 414 527 362 528 306 C 530 188 474 112 360 112 Z" fill="url(#${u}-hair)"/>
          <path d="M216 340 C 202 412 192 486 184 556 C 178 608 172 656 168 700" stroke="url(#${u}-hair-light)" stroke-width="10" fill="none" opacity=".34" stroke-linecap="round"/>
          <path d="M504 340 C 518 412 528 486 536 556 C 542 608 548 656 552 700" stroke="url(#${u}-hair-gloss)" stroke-width="9" fill="none" opacity=".32" stroke-linecap="round"/>
        </g>

        <!-- 脖子 -->
        <g class="ava-neck">
          <path d="M320 418 L318 484 C 318 504 336 516 360 516 C 384 516 402 504 402 484 L400 418 Z" fill="url(#${u}-skin-neck)"/>
          <path d="M320 440 C 338 456 382 456 400 440 L 400 462 C 382 476 338 476 320 462 Z" fill="#b9765a" opacity=".24"/>
        </g>

        <!-- 躯干 -->
        <g class="ava-torso">
          <!-- 内搭（象牙白高领） -->
          <path class="ava-blouse" d="M360 462 C 324 464 292 482 268 502 C 220 538 184 598 168 674 C 160 714 156 766 156 820 L 564 820 C 564 766 560 714 552 674 C 536 598 500 538 452 502 C 428 482 396 464 360 462 Z" fill="url(#${u}-blouse)"/>
          <path d="M268 502 C 236 530 210 578 196 638 C 186 684 180 744 180 820 L 156 820 C 156 766 160 714 168 674 C 184 598 220 538 268 502 Z" fill="#c4b7a7" opacity=".26"/>
          <path d="M452 502 C 484 530 510 578 524 638 C 534 684 540 744 540 820 L 564 820 C 564 766 560 714 552 674 C 536 598 500 538 452 502 Z" fill="#c4b7a7" opacity=".2"/>
          <!-- 高领 -->
          <path d="M314 456 C 316 490 334 512 360 512 C 386 512 404 490 406 456 C 406 482 400 502 386 514 C 374 524 346 524 334 514 C 320 502 314 482 314 456 Z" fill="#ede3d4"/>
          <path d="M334 514 C 346 524 374 524 386 514 C 380 530 340 530 334 514 Z" fill="#b6a894" opacity=".45"/>
          <path d="M314 456 C 316 490 334 512 360 512 C 386 512 404 490 406 456" fill="none" stroke="#dbcfbd" stroke-width="1.4" opacity=".75"/>

          <!-- 西装（腰线以下闭合） -->
          <g class="ava-blazer">
            <path d="M300 480 C 262 492 232 514 210 544 C 172 588 150 644 140 704 C 134 746 132 788 132 820 L 360 820 L 360 700 C 356 664 352 630 348 600 C 342 560 330 520 300 480 Z" fill="url(#${u}-blazer)"/>
            <g transform="translate(720 0) scale(-1 1)">
              <path d="M300 480 C 262 492 232 514 210 544 C 172 588 150 644 140 704 C 134 746 132 788 132 820 L 360 820 L 360 700 C 356 664 352 630 348 600 C 342 560 330 520 300 480 Z" fill="url(#${u}-blazer)"/>
            </g>
            <!-- 驳头 -->
            <path d="M298 478 C 316 494 330 516 338 542 C 344 560 346 580 346 600 C 352 622 356 648 356 672 C 348 656 338 640 330 626 C 322 610 312 590 302 572 C 294 552 288 512 286 490 Z" fill="url(#${u}-lapel)"/>
            <path d="M346 600 C 352 622 356 648 356 672" stroke="#5eead4" stroke-opacity=".3" stroke-width="1.7" fill="none" stroke-linecap="round"/>
            <path d="M298 478 C 316 494 330 516 338 542" stroke="#93a8dd" stroke-opacity=".24" stroke-width="1.4" fill="none" stroke-linecap="round"/>
            <g transform="translate(720 0) scale(-1 1)">
              <path d="M298 478 C 316 494 330 516 338 542 C 344 560 346 580 346 600 C 352 622 356 648 356 672 C 348 656 338 640 330 626 C 322 610 312 590 302 572 C 294 552 288 512 286 490 Z" fill="url(#${u}-lapel)"/>
              <path d="M346 600 C 352 622 356 648 356 672" stroke="#5eead4" stroke-opacity=".3" stroke-width="1.7" fill="none" stroke-linecap="round"/>
            </g>
            <!-- 阴影 / 缝线 / 边缘光 -->
            <path d="M262 512 C 218 554 186 616 176 690" stroke="#0d1730" stroke-opacity=".42" stroke-width="2.2" fill="none"/>
            <path d="M188 656 C 180 708 176 764 176 820" stroke="#0d1730" stroke-opacity=".3" stroke-width="1.6" fill="none"/>
            <path d="M246 528 C 206 570 178 628 168 696" stroke="#5eead4" stroke-opacity=".2" stroke-width="2.6" fill="none" stroke-linecap="round"/>
            <path d="M474 528 C 514 570 542 628 552 696" stroke="#a78bfa" stroke-opacity=".22" stroke-width="2.6" fill="none" stroke-linecap="round"/>
            <path d="M208 548 C 176 592 154 646 146 706" stroke="#0b1530" stroke-opacity=".26" stroke-width="1.4" fill="none"/>
            <path d="M360 700 L 360 820" stroke="#0b1530" stroke-opacity=".32" stroke-width="1.6" fill="none"/>
            <!-- 扣子 -->
            <circle cx="360" cy="706" r="5" fill="#101a32" stroke="#5eead4" stroke-opacity=".45" stroke-width="1.5"/>
            <path d="M353 706 C 357 704 363 704 367 706" stroke="#7ff5e3" stroke-opacity=".35" stroke-width="1" fill="none"/>
            <path class="ava-pin-glow" d="M230 646 L 233 657 L 244 660 L 233 663 L 230 674 L 227 663 L 216 660 L 227 657 Z" fill="#ffd28a" opacity=".42"/>
            <circle class="ava-pin" cx="230" cy="660" r="3.4" fill="#ffcf8a" opacity=".9"/>
          </g>

          <!-- 项链 -->
          <g class="ava-necklace">
            <path d="M344 522 C 350 546 370 546 376 522" stroke="#ffd9a8" stroke-opacity=".6" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            <circle cx="360" cy="548" r="12" fill="url(#${u}-glow-teal)" opacity=".55"/>
            <path d="M360 540 L 367 552 L 360 566 L 353 552 Z" fill="#5eead4" opacity=".92"/>
            <path d="M360 540 L 367 552 L 360 566 L 353 552 Z" fill="none" stroke="#c7fff5" stroke-width="1" opacity=".85"/>
          </g>
        </g>

        <!-- 头 -->
        <g class="ava-head">
          <g class="ava-head-sway">
            <g class="ava-head-tilt">
              <g class="ava-head-nod">

                <!-- 耳朵 -->
                <g class="ava-ears">
                  <ellipse cx="230" cy="306" rx="18" ry="25" fill="url(#${u}-skin)" transform="rotate(-7 230 306)"/>
                  <path d="M226 292 C 234 296 238 304 236 314" stroke="#c9876a" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".65"/>
                  <g transform="translate(720 0) scale(-1 1)">
                    <ellipse cx="230" cy="306" rx="18" ry="25" fill="url(#${u}-skin)" transform="rotate(-7 230 306)"/>
                    <path d="M226 292 C 234 296 238 304 236 314" stroke="#c9876a" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".65"/>
                  </g>
                </g>

                <!-- 脸 -->
                <path class="ava-face" d="M360 166 C 442 164 490 214 488 300 C 486 366 452 428 398 441 C 386 445 334 445 322 441 C 268 428 234 366 232 300 C 230 214 278 164 360 166 Z" fill="url(#${u}-skin)"/>
                <ellipse cx="360" cy="206" rx="60" ry="26" fill="#ffe6d1" opacity=".22"/>
                <path d="M236 292 C 238 248 252 214 278 194 C 260 218 250 254 250 296 C 250 342 260 382 280 410 C 252 394 238 348 236 292 Z" fill="#d38f70" opacity=".18"/>
                <path d="M484 292 C 482 248 468 214 442 194 C 460 218 470 254 470 296 C 470 342 460 382 440 410 C 468 394 482 348 484 292 Z" fill="#d38f70" opacity=".16"/>
                <ellipse cx="360" cy="420" rx="20" ry="7" fill="#ffe6d1" opacity=".14"/>

                <!-- 腮红 + 小雀斑 -->
                <ellipse class="ava-blush ava-blush--l" cx="268" cy="344" rx="31" ry="15" fill="url(#${u}-blush)" transform="rotate(-7 268 344)"/>
                <ellipse class="ava-blush ava-blush--r" cx="452" cy="344" rx="31" ry="15" fill="url(#${u}-blush)" transform="rotate(7 452 344)"/>
                <g class="ava-freckles" fill="#c98363" opacity=".38">
                  <circle cx="270" cy="362" r="1.4"/><circle cx="281" cy="357" r="1.2"/><circle cx="259" cy="356" r="1.2"/>
                  <circle cx="450" cy="362" r="1.4"/><circle cx="439" cy="357" r="1.2"/><circle cx="461" cy="356" r="1.2"/>
                </g>

                <!-- 发型（前） -->
                <g class="ava-hair-front">
                  <!-- 头顶（中分） -->
                  <path d="M360 116 C 248 116 194 190 196 306 C 197 354 204 396 214 428 C 222 362 236 318 258 288 C 280 254 314 231 350 225 C 355 223 365 223 370 225 C 406 231 440 254 464 288 C 485 318 498 362 506 428 C 516 396 523 354 524 306 C 526 190 472 116 360 116 Z" fill="url(#${u}-hair)"/>
                  <!-- 发缝 -->
                  <path d="M360 222 C 359 202 358 180 360 156" stroke="#1c0e08" stroke-width="2.2" opacity=".45" fill="none" stroke-linecap="round"/>
                  




                  <!-- 呆毛 -->
                  <path d="M350 130 C 344 116 348 104 362 96 C 353 106 355 118 362 128 Z" fill="url(#${u}-hair)"/>
                  <!-- 发丝纹理（在发团内部，不压眉眼） -->
                  <path d="M318 240 C 306 224 300 204 302 184" stroke="#170b07" stroke-width="1.6" fill="none" opacity=".22" stroke-linecap="round"/>
                  <path d="M402 240 C 414 224 420 204 418 184" stroke="#170b07" stroke-width="1.6" fill="none" opacity=".22" stroke-linecap="round"/>
                  <path d="M340 238 C 332 218 330 198 334 178" stroke="#170b07" stroke-width="1.4" fill="none" opacity=".16" stroke-linecap="round"/>
                  <path d="M380 238 C 388 218 390 198 386 178" stroke="#170b07" stroke-width="1.4" fill="none" opacity=".16" stroke-linecap="round"/>
                  <!-- 侧发（S 形发绺） -->
                  <path d="M218 292 C 202 340 198 392 206 444 C 212 482 226 510 246 528 C 240 486 238 446 242 408 C 246 368 254 328 266 296 Z" fill="url(#${u}-hair)"/>
                  <g transform="translate(720 0) scale(-1 1)">
                    <path d="M218 292 C 202 340 198 392 206 444 C 212 482 226 510 246 528 C 240 486 238 446 242 408 C 246 368 254 328 266 296 Z" fill="url(#${u}-hair)"/>
                  </g>
                  <!-- 鬓角碎发 -->
                  <path d="M250 328 C 244 368 246 410 254 446 C 256 412 258 376 264 344 Z" fill="#2a170f" opacity=".85"/>
                  <path d="M470 328 C 476 368 474 410 466 446 C 464 412 462 376 456 344 Z" fill="#2a170f" opacity=".85"/>
                  <!-- 垂在肩前的长发（微波浪） -->
                  <path d="M242 424 C 228 482 224 542 232 600 C 238 638 252 664 272 682 C 266 638 266 594 272 550 C 278 506 288 462 298 428 Z" fill="url(#${u}-hair)"/>
                  <g transform="translate(720 0) scale(-1 1)">
                    <path d="M242 424 C 228 482 224 542 232 600 C 238 638 252 664 272 682 C 266 638 266 594 272 550 C 278 506 288 462 298 428 Z" fill="url(#${u}-hair)"/>
                  </g>
                  <!-- 发丝纹理 -->
                  <path d="M262 520 C 258 570 260 620 270 660" stroke="#170b07" stroke-width="1.8" fill="none" opacity=".28" stroke-linecap="round"/>
                  <path d="M458 520 C 462 570 460 620 450 660" stroke="#170b07" stroke-width="1.8" fill="none" opacity=".28" stroke-linecap="round"/>
                  <path d="M234 372 C 230 404 230 436 236 466" stroke="#170b07" stroke-width="2" fill="none" opacity=".4" stroke-linecap="round"/>
                  <path d="M486 372 C 490 404 490 436 484 466" stroke="#170b07" stroke-width="2" fill="none" opacity=".4" stroke-linecap="round"/>
                  <!-- 高光 / 边缘光 -->
                  <path d="M318 152 C 356 138 398 141 432 160" stroke="url(#${u}-hair-gloss)" stroke-width="11" fill="none" stroke-linecap="round" opacity=".58"/>
                  <path d="M286 176 C 258 202 240 242 234 290" stroke="url(#${u}-hair-light)" stroke-width="7" fill="none" stroke-linecap="round" opacity=".42"/>
                  <path d="M434 176 C 462 202 480 242 486 290" stroke="url(#${u}-hair-gloss)" stroke-width="7" fill="none" stroke-linecap="round" opacity=".4"/>
                  <path d="M356 128 C 350 158 351 186 356 212" stroke="url(#${u}-hair-light)" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".42"/>
                  <path d="M300 246 C 286 268 278 294 278 320" stroke="url(#${u}-hair-light)" stroke-width="4" fill="none" stroke-linecap="round" opacity=".28"/>
                  <path d="M420 246 C 434 268 442 294 442 320" stroke="url(#${u}-hair-gloss)" stroke-width="4" fill="none" stroke-linecap="round" opacity=".28"/>
                  <path d="M204 262 C 196 306 197 352 205 396" stroke="#5eead4" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".32"/>
                  <path d="M516 262 C 524 306 523 352 515 396" stroke="#a78bfa" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".34"/>
                  <path d="M244 320 C 238 360 238 400 244 436" stroke="#5eead4" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".2"/>
                  <path d="M476 320 C 482 360 482 400 476 436" stroke="#a78bfa" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".22"/>
                </g>

                <!-- 眼睛 -->
                <g class="ava-eyes">
                  <g class="ava-eye ava-eye--l" transform="translate(312 294)">
                    <g class="ava-eye-open">
                      <path class="ava-eye-white" d="M-27 2 C-24 -15 -12 -23 1 -22 C16 -21 26 -12 27 0 C25 13 14 21 0 21 C-14 21 -25 13 -27 2 Z" fill="url(#${u}-sclera)"/>
                      <path class="ava-eye-lid-shadow" d="M-26 -3 C-22 -19 -10 -26 2 -25 C16 -24 26 -15 27 -3 C18 -12 8 -16 -2 -16 C-12 -16 -22 -11 -26 -3 Z" fill="#a46a5a" opacity=".2"/>
                      <path class="ava-eye-shadow" d="M-30 -4 C-26 -21 -10 -29 4 -27 C19 -25 30 -15 31 -2 C24 -13 12 -19 -1 -19 C-14 -19 -25 -12 -30 -4 Z" fill="#b06a8f" opacity=".16"/>
                      <g class="ava-iris">
                        <g class="ava-iris-drift">
                          <circle r="17.4" fill="url(#${u}-iris)"/>
                          <circle r="17.4" fill="none" stroke="#0b5b52" stroke-width="1.8" opacity=".55"/>
                          <circle r="7.9" cy="1.4" fill="#0b1220"/>
                          <circle r="3.4" cx="-1" cy="1.2" fill="#1a2a3f" opacity=".8"/>
                          <circle r="4.9" cx="-5.8" cy="-6.4" fill="#ffffff" opacity=".96"/>
                          <circle r="2.3" cx="6.4" cy="5.4" fill="#ffffff" opacity=".62"/>
                          <circle r="1.6" cx="-8" cy="6" fill="#a7f3e8" opacity=".8"/>
                        </g>
                      </g>
                      <path class="ava-eye-lidtop" d="M-28 1 C-25 -16 -12 -25 1 -24 C16 -23 27 -13 28 -1" fill="none" stroke="#38201a" stroke-width="5.8" stroke-linecap="round"/>
                      <path class="ava-eye-lash" d="M-27 -2 C-33 0 -37 3 -39 8" fill="none" stroke="#38201a" stroke-width="4.4" stroke-linecap="round"/>
                      <path class="ava-eye-lash" d="M-24 -8 C-31 -9 -36 -6 -39 -2" fill="none" stroke="#38201a" stroke-width="3.4" stroke-linecap="round" opacity=".9"/>
                      <path class="ava-eye-lash" d="M-18 -14 C-24 -16 -29 -15 -33 -11" fill="none" stroke="#38201a" stroke-width="2.6" stroke-linecap="round" opacity=".7"/>
                      <path class="ava-eye-lower" d="M-24 12 C-14 20 12 22 24 13" fill="none" stroke="#a86a52" stroke-width="2" stroke-linecap="round" opacity=".5"/>
                      <path class="ava-eye-lash-low" d="M18 18 C22 16 26 13 28 9" fill="none" stroke="#5a332a" stroke-width="2.2" stroke-linecap="round" opacity=".55"/>
                    </g>
                    <g class="ava-eye-happy">
                      <path d="M-22 9 Q0 -16 22 9" fill="none" stroke="#3a2018" stroke-width="6" stroke-linecap="round"/>
                      <path d="M-25 10 Q-26 5 -23 2" fill="none" stroke="#3a2018" stroke-width="2.6" stroke-linecap="round" opacity=".8"/>
                    </g>
                  </g>
                  <g class="ava-eye ava-eye--r" transform="translate(408 294) scale(-1 1)">
                    <g class="ava-eye-open">
                      <path class="ava-eye-white" d="M-27 2 C-24 -15 -12 -23 1 -22 C16 -21 26 -12 27 0 C25 13 14 21 0 21 C-14 21 -25 13 -27 2 Z" fill="url(#${u}-sclera)"/>
                      <path class="ava-eye-lid-shadow" d="M-26 -3 C-22 -19 -10 -26 2 -25 C16 -24 26 -15 27 -3 C18 -12 8 -16 -2 -16 C-12 -16 -22 -11 -26 -3 Z" fill="#a46a5a" opacity=".2"/>
                      <path class="ava-eye-shadow" d="M-30 -4 C-26 -21 -10 -29 4 -27 C19 -25 30 -15 31 -2 C24 -13 12 -19 -1 -19 C-14 -19 -25 -12 -30 -4 Z" fill="#b06a8f" opacity=".16"/>
                      <g class="ava-iris">
                        <g class="ava-iris-drift">
                          <circle r="17.4" fill="url(#${u}-iris)"/>
                          <circle r="17.4" fill="none" stroke="#0b5b52" stroke-width="1.8" opacity=".55"/>
                          <circle r="7.9" cy="1.4" fill="#0b1220"/>
                          <circle r="3.4" cx="-1" cy="1.2" fill="#1a2a3f" opacity=".8"/>
                          <circle r="4.9" cx="-5.8" cy="-6.4" fill="#ffffff" opacity=".96"/>
                          <circle r="2.3" cx="6.4" cy="5.4" fill="#ffffff" opacity=".62"/>
                          <circle r="1.6" cx="-8" cy="6" fill="#a7f3e8" opacity=".8"/>
                        </g>
                      </g>
                      <path class="ava-eye-lidtop" d="M-28 1 C-25 -16 -12 -25 1 -24 C16 -23 27 -13 28 -1" fill="none" stroke="#38201a" stroke-width="5.8" stroke-linecap="round"/>
                      <path class="ava-eye-lash" d="M-27 -2 C-33 0 -37 3 -39 8" fill="none" stroke="#38201a" stroke-width="4.4" stroke-linecap="round"/>
                      <path class="ava-eye-lash" d="M-24 -8 C-31 -9 -36 -6 -39 -2" fill="none" stroke="#38201a" stroke-width="3.4" stroke-linecap="round" opacity=".9"/>
                      <path class="ava-eye-lash" d="M-18 -14 C-24 -16 -29 -15 -33 -11" fill="none" stroke="#38201a" stroke-width="2.6" stroke-linecap="round" opacity=".7"/>
                      <path class="ava-eye-lower" d="M-24 12 C-14 20 12 22 24 13" fill="none" stroke="#a86a52" stroke-width="2" stroke-linecap="round" opacity=".5"/>
                      <path class="ava-eye-lash-low" d="M18 18 C22 16 26 13 28 9" fill="none" stroke="#5a332a" stroke-width="2.2" stroke-linecap="round" opacity=".55"/>
                    </g>
                    <g class="ava-eye-happy">
                      <path d="M-22 9 Q0 -16 22 9" fill="none" stroke="#3a2018" stroke-width="6" stroke-linecap="round"/>
                      <path d="M-25 10 Q-26 5 -23 2" fill="none" stroke="#3a2018" stroke-width="2.6" stroke-linecap="round" opacity=".8"/>
                    </g>
                  </g>
                </g>

                <!-- 眉毛 -->
                <g class="ava-brows">
                  <g class="ava-brow ava-brow--l" transform="translate(310 253)">
                    <path d="M-26 2 C-14 -7 8 -8 26 1" fill="none" stroke="#452821" stroke-width="6.2" stroke-linecap="round"/>
                  </g>
                  <g class="ava-brow ava-brow--r" transform="translate(410 254) scale(-1 1)">
                    <path d="M-28 7 C-16 -5 10 -8 28 1" fill="none" stroke="#38201a" stroke-width="7.8" stroke-linecap="round"/>
                  </g>
                </g>

                <!-- 鼻子 -->
                <g class="ava-nose">
                  <path d="M356 333 C 350 341 352 348 359 350 C 365 350 370 347 372 343" fill="none" stroke="#d99a7b" stroke-width="2.7" stroke-linecap="round" opacity=".72"/>
                  <ellipse cx="361" cy="348" rx="7" ry="3.2" fill="#d18e6d" opacity=".14"/>
                  <circle cx="364" cy="341" r="2.2" fill="#ffe9d8" opacity=".45"/>
                </g>

                <!-- 嘴：静态表情 -->
                <g class="ava-mouth">
                  <g class="ava-mouth-static">
                    <path class="ava-m ava-m--neutral" d="M334 380 Q360 396 386 380" fill="none" stroke="#a34d46" stroke-width="4.4" stroke-linecap="round"/>
                    <circle class="ava-m ava-m--neutral" cx="333" cy="379" r="1.6" fill="#b26058" opacity=".5"/>
                    <circle class="ava-m ava-m--neutral" cx="387" cy="379" r="1.6" fill="#b26058" opacity=".5"/>
                    <path class="ava-m ava-m--happy" d="M330 375 Q360 403 390 375" fill="none" stroke="#a34d46" stroke-width="4.6" stroke-linecap="round"/>
                    <path class="ava-m ava-m--proud" d="M334 383 Q356 391 378 379 Q386 374 392 372" fill="none" stroke="#a34d46" stroke-width="4.4" stroke-linecap="round"/>
                    <path class="ava-m ava-m--curious" d="M344 381 Q360 390 376 381" fill="none" stroke="#a34d46" stroke-width="4.2" stroke-linecap="round"/>
                    <path class="ava-m ava-m--thinking" d="M341 384 Q360 391 379 382" fill="none" stroke="#a34d46" stroke-width="4.2" stroke-linecap="round"/>
                    <path class="ava-m ava-m--encouraging" d="M331 377 Q360 401 389 377" fill="none" stroke="#a34d46" stroke-width="4.6" stroke-linecap="round"/>
                    <path class="ava-m ava-m--sad" d="M335 391 Q360 374 385 391" fill="none" stroke="#a34d46" stroke-width="4.4" stroke-linecap="round"/>
                    <g class="ava-m ava-m--surprised">
                      <ellipse cx="360" cy="386" rx="9.5" ry="12" fill="#6d2331" stroke="#a34d46" stroke-width="3"/>
                      <ellipse cx="360" cy="396" rx="5.5" ry="3.4" fill="#e8798f" opacity=".85"/>
                    </g>
                  </g>
                  <ellipse class="ava-lip-lower" cx="360" cy="387" rx="14" ry="4.2" fill="#e79b8c" opacity=".26"/>
                  <ellipse class="ava-mouth-lowerlip" cx="360" cy="390" rx="14" ry="4" fill="#f2ab96" opacity="0"/>

                  <!-- 嘴：口型（说话时） -->
                  <g class="ava-mouth-open">
                    <path class="ava-mouth-inner" d="M330 378 Q360 370 390 378 Q386 418 360 422 Q334 418 330 378 Z" fill="url(#${u}-mouth-inner)"/>
                    <path class="ava-mouth-teeth" d="M334 378 Q360 372 386 378 L 384 389 Q360 384 336 389 Z" fill="#fff6ef"/>
                    <ellipse class="ava-mouth-tongue" cx="360" cy="413" rx="17" ry="8.5" fill="#e8798f"/>
                    <path class="ava-mouth-lip" d="M327 377 Q360 368 393 377" fill="none" stroke="#a34d46" stroke-width="5" stroke-linecap="round"/>
                    <path class="ava-mouth-lip-low" d="M334 416 Q360 429 386 416" fill="none" stroke="#a34d46" stroke-width="4" stroke-linecap="round"/>
                  </g>
                </g>

                <!-- 耳麦 -->
                <g class="ava-headset">
                  <path class="ava-headset__band" d="M230 284 C 240 186 292 136 360 136 C 428 136 480 186 490 284" fill="none" stroke="#1a2340" stroke-width="14" stroke-linecap="round"/>
                  <path class="ava-headset__band-glow" d="M230 284 C 240 186 292 136 360 136 C 428 136 480 186 490 284" fill="none" stroke="#5eead4" stroke-width="2.6" stroke-linecap="round" opacity=".35"/>
                  <g class="ava-cup ava-cup--l">
                    <ellipse cx="222" cy="314" rx="21" ry="32" fill="#1a2340" stroke="#2b3a63" stroke-width="2.5"/>
                    <ellipse cx="222" cy="314" rx="13" ry="22" fill="#0f172b"/>
                    <ellipse class="ava-cup__led" cx="222" cy="314" rx="7" ry="12.5" fill="none" stroke="#5eead4" stroke-width="2.6" opacity=".85"/>
                    <circle class="ava-cup__dot" cx="222" cy="314" r="2.6" fill="#5eead4"/>
                  </g>
                  <g class="ava-cup ava-cup--r">
                    <ellipse cx="498" cy="314" rx="21" ry="32" fill="#1a2340" stroke="#2b3a63" stroke-width="2.5"/>
                    <ellipse cx="498" cy="314" rx="13" ry="22" fill="#0f172b"/>
                    <ellipse class="ava-cup__led" cx="498" cy="314" rx="7" ry="12.5" fill="none" stroke="#5eead4" stroke-width="2.6" opacity=".85"/>
                    <circle class="ava-cup__dot" cx="498" cy="314" r="2.6" fill="#5eead4"/>
                  </g>
                  <path class="ava-mic-boom" d="M498 336 C 488 374 458 394 422 394" fill="none" stroke="#1a2340" stroke-width="9" stroke-linecap="round"/>
                  <path class="ava-mic-boom" d="M498 336 C 488 374 458 394 422 394" fill="none" stroke="#2b3a63" stroke-width="3.2" stroke-linecap="round" opacity=".8"/>
                  <g class="ava-mic-tip" transform="translate(414 394) rotate(-6)">
                    <circle r="16" fill="url(#${u}-led)" opacity=".35" class="ava-mic-tip__glow"/>
                    <rect x="-14" y="-7" width="28" height="14" rx="7" fill="#243055" stroke="#5eead4" stroke-opacity=".6" stroke-width="1.6"/>
                    <circle class="ava-mic-led" cx="5" cy="0" r="3.4" fill="#5eead4"/>
                  </g>
                  <circle cx="232" cy="354" r="3.2" fill="#5eead4" opacity=".9"/>
                  <circle cx="232" cy="354" r="8" fill="url(#${u}-led)" opacity=".45"/>
                  <g class="ava-sound" opacity="0">
                    <path d="M452 368 Q466 384 452 400" fill="none" stroke="#5eead4" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>
                    <path d="M466 358 Q486 384 466 410" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" opacity=".55"/>
                    <path d="M480 348 Q506 384 480 420" fill="none" stroke="#5eead4" stroke-width="1.6" stroke-linecap="round" opacity=".35"/>
                  </g>
                </g>

              </g>
            </g>
          </g>
        </g>

        <!-- 挥手的手（wave() 时出现） -->
        <g class="ava-wave-arm">
          <path class="ava-wave-sleeve" d="M548 820 C 540 748 540 678 550 620 C 555 592 568 570 586 554 L 620 574 C 628 610 625 652 616 698 C 606 752 604 788 606 820 Z" fill="url(#${u}-sleeve)"/>
          <path class="ava-wave-cuff" d="M578 558 C 576 540 580 524 590 510 L 630 526 C 624 544 620 560 618 578 Z" fill="#2c3a63"/>
          <path class="ava-wave-cuff-glow" d="M590 512 L 630 528" stroke="#5eead4" stroke-width="2" opacity=".5" stroke-linecap="round"/>
          <g class="ava-wave-hand">
            <ellipse cx="606" cy="486" rx="27" ry="31" fill="url(#${u}-skin)"/>
            <g fill="url(#${u}-skin)">
              <rect x="583" y="438" width="12.5" height="46" rx="6.2" transform="rotate(-4 589 461)"/>
              <rect x="597" y="430" width="13" height="52" rx="6.5"/>
              <rect x="611" y="434" width="12.5" height="48" rx="6.2" transform="rotate(3 617 458)"/>
              <rect x="624" y="446" width="11.5" height="40" rx="5.8" transform="rotate(7 630 466)"/>
              <ellipse cx="638" cy="488" rx="11" ry="17" fill="url(#${u}-skin)" transform="rotate(26 638 488)" opacity=".95"/>
            </g>
            <path d="M592 492 C 600 488 612 488 620 492" stroke="#d18e6d" stroke-width="1.6" fill="none" opacity=".45"/>
            <path d="M596 474 C 600 470 606 470 610 474" stroke="#d18e6d" stroke-width="1.6" fill="none" opacity=".25"/>
          </g>
        </g>

      </g>
    </g>
  </g>
</svg>`;
}

function hudMarkup() {
  return `
<div class="ava-hud" aria-hidden="true">
  <div class="ava-hud__top">
    <div class="ava-nameplate">
      <span class="ava-nameplate__orb"></span>
      <span class="ava-nameplate__text">
        <b class="ava-name">Ava</b>
        <span class="ava-role">AI English Teacher</span>
      </span>
    </div>
    <div class="ava-level">
      <span class="ava-level__label">CEFR</span>
      <b class="ava-level__val">A2</b>
    </div>
  </div>
  <div class="ava-hud__bottom">
    <div class="ava-status">
      <span class="ava-status__dot"></span>
      <span class="ava-status__text">待机</span>
    </div>
    <div class="ava-wave" aria-hidden="true">
      <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
    </div>
  </div>
</div>`;
}

/* ------------------------------------------------------------------ *
 * mountAvatar
 * ------------------------------------------------------------------ */

let instanceSeq = 0;

export function mountAvatar(container, opts = {}) {
  if (!container || container.nodeType !== 1) {
    throw new Error('mountAvatar(container, opts): container 必须是 DOM 元素');
  }
  if (typeof document === 'undefined') {
    throw new Error('mountAvatar(container, opts): 需要在浏览器环境调用');
  }
  ensureStyles();

  // 同一容器重复挂载：先清理旧实例
  if (container.__avaInstance) {
    try { container.__avaInstance.destroy(); } catch { /* ignore */ }
  }

  const uid = 'ava' + (++instanceSeq) + '-' + Math.random().toString(36).slice(2, 7);
  const root = document.createElement('div');
  root.className = 'ava-root' + (opts.background === false ? ' ava-root--bare' : '');
  root.dataset.state = 'idle';
  root.dataset.emotion = 'neutral';
  root.dataset.mouth = 'neutral';
  root.dataset.eyes = 'open';
  root.dataset.speaking = '0';
  root.dataset.viseme = 'rest';
  root.dataset.theme = String(opts.theme || 'teal-violet');
  root.innerHTML = sceneMarkup(uid) + hudMarkup();
  container.appendChild(root);

  /* ---------- 元素引用 ---------- */
  const el = {
    root,
    svg: root.querySelector('.ava-svg'),
    mouthOpen: root.querySelector('.ava-mouth-open'),
    think: root.querySelector('.ava-think'),
    micRing: root.querySelector('.ava-mic-ring'),
    micRingMain: root.querySelector('.ava-mic-ring__main'),
    cupLeds: Array.from(root.querySelectorAll('.ava-cup__led')),
    cupDots: Array.from(root.querySelectorAll('.ava-cup__dot')),
    micLed: root.querySelector('.ava-mic-led'),
    micTipGlow: root.querySelector('.ava-mic-tip__glow'),
    flash: root.querySelector('.ava-flash'),
    confetti: root.querySelector('.ava-confetti'),
    sound: root.querySelector('.ava-sound'),
    statusText: root.querySelector('.ava-status__text'),
    statusDot: root.querySelector('.ava-status__dot'),
    status: root.querySelector('.ava-status'),
    name: root.querySelector('.ava-name'),
    levelChip: root.querySelector('.ava-level'),
    levelVal: root.querySelector('.ava-level__val'),
    wave: root.querySelector('.ava-wave'),
    bars: Array.from(root.querySelectorAll('.ava-wave i')),
    hud: root.querySelector('.ava-hud'),
    glowTeal: root.querySelector('.ava-glow--teal'),
    glowViolet: root.querySelector('.ava-glow--violet'),
    glowWarm: root.querySelector('.ava-glow--warm'),
    glowRose: root.querySelector('.ava-glow--rose'),
    haloRings: root.querySelector('.ava-halo-rings'),
  };

  /* ---------- 状态 ---------- */
  let destroyed = false;
  let state = 'idle';
  let emotionOverride = null;
  let teacherName = 'Ava';
  let level = 'A2';
  let speaking = false;
  let viseme = 'rest';
  let reducedMotion = !!opts.reducedMotion;
  let forcedReduced = !!opts.reducedMotion;

  let speech = {
    active: false,
    text: '',
    segments: [],
    charTimes: null,
    total: 0,
    ttsDuration: 0,
    epoch: 0,
    seed: 0,
    lastWordChar: 0,
  };

  let micTarget = 0;
  let micCurrent = 0;
  let barPhase = 0;
  // v1.4 外部实时振幅（豆包 PCM 播放）→ 口型
  let externalSpeech = { active: false, target: 0, current: 0, lastAt: 0 };

  let rafId = 0;
  let loopTimer = 0;
  let lastTick = 0;
  let blinkTimer = 0;
  let waveTimer = 0;
  let nodTimer = 0;
  let celebrateTimer = 0;
  let cleanTimer = 0;

  const mql = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  /* ---------- 视图同步 ---------- */
  function resolveExpression() {
    if (emotionOverride) return emotionOverride;
    return STATE_META[state] ? STATE_META[state].emotion : 'neutral';
  }

  function render() {
    if (destroyed) return;
    const expr = resolveExpression();
    root.dataset.state = state;
    root.dataset.emotion = expr;
    root.dataset.speaking = speaking ? '1' : '0';
    root.dataset.viseme = viseme;
    root.dataset.mouth = speaking ? 'speaking' : expr;
    const eyesHappy = !speaking && expr === 'happy';
    root.dataset.eyes = eyesHappy ? 'happy' : 'open';
    const meta = STATE_META[state] || STATE_META.idle;
    if (el.statusText) el.statusText.textContent = meta.label;
    const aria = `Ava，AI 英语老师${teacherName && teacherName !== 'Ava' ? '（' + teacherName + '）' : ''}，${meta.aria}`;
    root.setAttribute('aria-label', aria);
    // 说话时的声波
    if (el.sound) el.sound.style.opacity = speaking ? '1' : '0';
  }

  function ensureLoop() {
    if (!rafId && !destroyed) rafId = requestAnimationFrame(tick);
    ensureFallbackTimer();
  }

  function ensureFallbackTimer() {
    if (loopTimer || destroyed) return;
    loopTimer = setInterval(() => {
      if (destroyed) { stopFallbackTimer(); return; }
      // rAF 被 headless / 后台标签页节流时（>70ms 没 tick），用定时器兜底
      if (performance.now() - lastTick > 70) tick();
    }, 60);
  }

  function stopFallbackTimer() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
  }

  function setViseme(v) {
    if (!VISEMES.includes(v)) v = 'rest';
    if (v === viseme) return;
    viseme = v;
    root.dataset.viseme = v;
  }

  /* ---------- 口型循环 ---------- */
  function visemeAt(t) {
    const segs = speech.segments;
    if (!segs.length) return proceduralViseme(performance.now());
    if (t < 0) return 'rest';
    if (t >= speech.total) return proceduralViseme(performance.now());
    // 线性扫描（segments 很短，几十到几百段，缓存上次位置）
    let i = speech._segIdx || 0;
    if (i >= segs.length) i = segs.length - 1;
    while (i < segs.length - 1 && segs[i].t1 <= t) i++;
    while (i > 0 && segs[i].t0 > t) i--;
    speech._segIdx = i;
    return segs[i].v;
  }

  function tick() {
    rafId = 0;
    if (destroyed) return;
    lastTick = performance.now();
    let need = false;
    const now = lastTick;

    // 1) 口型：外部实时振幅优先（豆包 PCM 播放）
    if (externalSpeech.active) {
      if (now - externalSpeech.lastAt > 450) {
        // 外部振幅停止推送 → 释放，回退内置口型引擎
        releaseExternalSpeech();
      } else {
        const target = externalSpeech.target;
        const k = target > externalSpeech.current ? 0.55 : 0.3;
        externalSpeech.current += (target - externalSpeech.current) * k;
        if (Math.abs(target - externalSpeech.current) < 0.004) externalSpeech.current = target;
        root.style.setProperty('--ava-speech-open', externalSpeech.current.toFixed(3));
        need = true;
      }
    }
    // 内置口型引擎（仅在无外部振幅时运行）
    if (!externalSpeech.active) {
      if (speech.active) {
        let v;
        if (speech.segments.length) {
          v = visemeAt(now - speech.epoch);
        } else {
          v = proceduralViseme(now);
        }
        setViseme(v);
        need = true;
      } else if (viseme !== 'rest') {
        setViseme('rest');
      }
    }

    // 2) 麦克风电平（平滑 + 波形条）
    if (Math.abs(micTarget - micCurrent) > 0.002 || micTarget > 0.002 || micCurrent > 0.002) {
      const k = micTarget > micCurrent ? 0.32 : 0.11;
      micCurrent += (micTarget - micCurrent) * k;
      if (Math.abs(micTarget - micCurrent) < 0.003) micCurrent = micTarget;
      applyMic(micCurrent, now);
      need = true;
    } else if (micCurrent !== 0) {
      micCurrent = 0;
      applyMic(0, now);
    }

    if (need) {
      if (!rafId) rafId = requestAnimationFrame(tick);
    } else {
      stopFallbackTimer();
    }
  }

  function applyMic(m, now) {
    if (el.micRing) {
      const s = 1 + m * 0.17;
      el.micRing.style.transform = 'scale(' + s.toFixed(3) + ')';
    }
    if (el.micRingMain) el.micRingMain.style.opacity = (0.14 + m * 0.62).toFixed(3);
    if (el.micLed) el.micLed.style.opacity = (0.35 + m * 0.65).toFixed(3);
    if (el.micTipGlow) el.micTipGlow.style.opacity = (0.18 + m * 0.6).toFixed(3);
    for (let i = 0; i < el.cupLeds.length; i++) {
      el.cupLeds[i].style.opacity = (0.35 + m * 0.65).toFixed(3);
    }
    const t = (now || performance.now()) / 1000;
    for (let i = 0; i < el.bars.length; i++) {
      const wob = Math.abs(Math.sin(t * 6.1 + i * 1.72)) * 0.55
                + Math.abs(Math.cos(t * 10.3 + i * 2.41)) * 0.45;
      const h = 0.16 + wob * (0.22 + m * 0.78);
      el.bars[i].style.transform = 'scaleY(' + h.toFixed(3) + ')';
    }
  }

  /* ---------- 说话 API ---------- */
  function beginSpeech(options) {
    if (destroyed) return api;
    const text = typeof options === 'string'
      ? options
      : (options && typeof options.text === 'string' ? options.text : '');
    const durationMs = options && typeof options === 'object' ? options.durationMs : undefined;
    const plan = buildSpeechPlan(text, durationMs);
    speech = {
      active: true,
      text: String(text || ''),
      segments: plan.segments,
      charTimes: plan.charTimes,
      total: plan.total,
      ttsDuration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
      epoch: performance.now(),
      seed: Math.floor(Math.random() * 7),
      lastWordChar: 0,
      _segIdx: 0,
    };
    speaking = true;
    setViseme('rest');
    if (state !== 'speaking') {
      state = 'speaking';
      emotionOverride = null;
    }
    render();
    ensureLoop();
    return api;
  }

  function wordBoundary(info) {
    if (destroyed || !speech.active) return api;
    const data = info || {};
    let t = null;
    const now = performance.now();
    const textLen = speech.text ? speech.text.length : 0;
    const charIndexUsable = Number.isFinite(data.charIndex) && data.charIndex >= 0 && data.charIndex <= textLen;
    // a) charIndex 属于本次 beginSpeech 的文本 → 直接对齐
    if (charIndexUsable && speech.charTimes && speech.charTimes.length) {
      t = speech.charTimes[Math.min(data.charIndex | 0, speech.charTimes.length - 1)];
    }
    // b) charIndex 可能相对整段回复（应用侧 job.offset）→ 用当前词在本文本中定位
    if (t == null && data.word && speech.text) {
      const needle = String(data.word).toLowerCase();
      const hay = speech.text.toLowerCase();
      let idx = hay.indexOf(needle, speech.lastWordChar);
      if (idx < 0) idx = hay.indexOf(needle);
      if (idx >= 0) {
        speech.lastWordChar = idx + needle.length;
        if (speech.charTimes && speech.charTimes.length) {
          t = speech.charTimes[Math.min(idx, speech.charTimes.length - 1)];
        }
      }
    }
    // c) 最后回退到 TTS elapsedMs，并按计划时长缩放
    if (t == null && Number.isFinite(data.elapsedMs)) {
      t = Math.max(0, Number(data.elapsedMs));
      if (speech.ttsDuration && speech.total) {
        t *= speech.total / speech.ttsDuration;
      }
      t = Math.min(t, speech.total);
    }
    if (t == null || !Number.isFinite(t)) return api;
    // 重同步：把计划时间轴对齐到“当前词”
    speech.epoch = now - t;
    speech._segIdx = 0;
    return api;
  }

  function stopSpeech(returnToIdle) {
    releaseExternalSpeech();
    speaking = false;
    speech.active = false;
    speech.segments = [];
    speech.charTimes = null;
    speech.total = 0;
    speech.ttsDuration = 0;
    speech._segIdx = 0;
    setViseme('rest');
    if (returnToIdle && state === 'speaking') state = 'idle';
    render();
    return api;
  }

  function endSpeech() {
    if (destroyed) return api;
    return stopSpeech(true);
  }

  /* 预览辅助：冻结展示单一 viseme（非 SPEC 契约，方便 QA 截口型） */
  function setVisemePose(value) {
    if (destroyed) return api;
    releaseExternalSpeech();
    if (value == null || value === "rest") {
      speaking = false;
      speech.active = false;
      speech.segments = [];
      speech.charTimes = null;
      setViseme("rest");
      render();
      return api;
    }
    if (!VISEMES.includes(value)) return api;
    speaking = true;
    speech.active = false;
    speech.segments = [];
    speech.charTimes = null;
    viseme = value;
    render();
    return api;
  }

  /* ---------- 庆祝 / 动作 ---------- */
  function burstConfetti() {
    if (!el.confetti || reducedMotion) {
      if (el.flash) {
        el.flash.style.opacity = '0.9';
        setTimeout(() => { if (!destroyed && el.flash) el.flash.style.opacity = '0'; }, 320);
      }
      return;
    }
    const frag = document.createDocumentFragment();
    const colors = ['#5eead4', '#a78bfa', '#ffb86b', '#4ade80', '#fb7185', '#e9eefc'];
    const count = 30;
    for (let i = 0; i < count; i++) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'ava-confetti__piece');
      const wrap = document.createElementNS(NS, 'g');
      wrap.setAttribute('transform', `translate(${330 + Math.random() * 60} ${250 + Math.random() * 60})`);
      let shape;
      const kind = i % 4;
      if (kind === 0) {
        shape = document.createElementNS(NS, 'rect');
        shape.setAttribute('x', '-3.2');
        shape.setAttribute('y', '-5');
        shape.setAttribute('width', '6.4');
        shape.setAttribute('height', '10');
        shape.setAttribute('rx', '2');
      } else if (kind === 1) {
        shape = document.createElementNS(NS, 'circle');
        shape.setAttribute('r', String(3 + Math.random() * 2));
      } else if (kind === 2) {
        shape = document.createElementNS(NS, 'path');
        shape.setAttribute('d', 'M0 -6 C1 -1.6 1.6 -1 6 0 C1.6 1 1 1.6 0 6 C-1 1.6 -1.6 1 -6 0 C-1.6 -1 -1 -1.6 0 -6 Z');
      } else {
        shape = document.createElementNS(NS, 'rect');
        shape.setAttribute('x', '-1.2');
        shape.setAttribute('y', '-6');
        shape.setAttribute('width', '2.4');
        shape.setAttribute('height', '12');
        shape.setAttribute('rx', '1.2');
      }
      shape.setAttribute('fill', colors[i % colors.length]);
      wrap.appendChild(shape);
      g.appendChild(wrap);
      g.style.setProperty('--dx', (Math.random() * 2 - 1) * 250 + 'px');
      g.style.setProperty('--dy1', (-90 - Math.random() * 120) + 'px');
      g.style.setProperty('--dy2', (210 + Math.random() * 220) + 'px');
      g.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      g.style.setProperty('--dur', (1.5 + Math.random() * 1.1) + 's');
      g.style.setProperty('--delay', (Math.random() * 0.18) + 's');
      frag.appendChild(g);
    }
    el.confetti.appendChild(frag);
    if (el.flash) {
      el.flash.style.opacity = '0.85';
      setTimeout(() => { if (!destroyed && el.flash) el.flash.style.opacity = '0'; }, 300);
    }
    clearTimeout(cleanTimer);
    cleanTimer = setTimeout(() => {
      if (!destroyed && el.confetti) el.confetti.textContent = '';
    }, 3200);
  }

  function triggerCelebrate() {
    root.classList.add('is-celebrating');
    burstConfetti();
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(() => {
      if (!destroyed) root.classList.remove('is-celebrating');
    }, 1600);
  }

  /* ---------- 眨眼 ---------- */
  function blink() {
    if (destroyed) return;
    if (root.dataset.eyes === 'happy') return;
    if (root.classList.contains('is-blinking')) return;
    root.classList.add('is-blinking');
    setTimeout(() => {
      if (!destroyed) root.classList.remove('is-blinking');
    }, 150);
  }

  function scheduleBlink(delay) {
    clearTimeout(blinkTimer);
    if (destroyed || reducedMotion) return;
    const wait = typeof delay === 'number' ? delay : 2400 + Math.random() * 3600;
    blinkTimer = setTimeout(() => {
      if (destroyed) return;
      if (!document.hidden) blink();
      scheduleBlink();
    }, wait);
  }

  /* ---------- 公共 API ---------- */
  function setState(next) {
    if (destroyed) return api;
    if (!STATE_META[next]) return api;
    if (next === state) {
      if (next === 'speaking' && !speech.active) {
        speech = { active: true, text: '', segments: [], charTimes: null, total: 0, ttsDuration: 0, epoch: performance.now(), seed: 0, lastWordChar: 0, _segIdx: 0 };
        speaking = true;
        render();
        ensureLoop();
      }
      return api;
    }
    const wasSpeaking = speaking;
    state = next;
    emotionOverride = null;
    if (next === 'speaking') {
      if (!speech.active) {
        speech = { active: true, text: '', segments: [], charTimes: null, total: 0, ttsDuration: 0, epoch: performance.now(), seed: Math.floor(Math.random() * 7), lastWordChar: 0, _segIdx: 0 };
      }
      speaking = true;
    } else if (wasSpeaking) {
      releaseExternalSpeech();
      speaking = false;
      speech.active = false;
      speech.segments = [];
      speech.charTimes = null;
      speech.ttsDuration = 0;
      setViseme('rest');
    }
    render();
    if (next === 'celebrate') triggerCelebrate();
    if (next === 'speaking') ensureLoop();
    return api;
  }

  function setEmotion(name) {
    if (destroyed) return api;
    if (name == null) {
      emotionOverride = null;
      render();
      return api;
    }
    const key = String(name).toLowerCase();
    if (!EMOTIONS.includes(key)) return api;
    emotionOverride = key;
    render();
    return api;
  }

  function releaseExternalSpeech() {
    if (externalSpeech.active) {
      externalSpeech.active = false;
      root.dataset.speechExternal = '0';
      root.style.setProperty('--ava-speech-open', '0');
    }
    externalSpeech.target = 0;
    externalSpeech.current = 0;
    externalSpeech.lastAt = 0;
  }

  /**
   * v1.4 契约扩展：外部实时振幅驱动口型。
   * 豆包 PCM 播放时按音频帧调用（0..1）；调用期间优先于 beginSpeech 的音节估算；
   * 超过 450ms 无新调用会自动释放；endSpeech / 离开 speaking 状态时复位。
   */
  function setSpeechLevel(value) {
    if (destroyed) return api;
    const n = Number(value);
    if (!Number.isFinite(n)) return api;
    const v = Math.min(1, Math.max(0, n));
    const wasActive = externalSpeech.active;
    externalSpeech.active = true;
    externalSpeech.target = v;
    externalSpeech.lastAt = performance.now();
    if (!wasActive) {
      root.dataset.speechExternal = '1';
      if (!speaking) {
        speaking = true;
        if (state !== 'speaking') state = 'speaking';
      }
      render();
    }
    ensureLoop();
    return api;
  }

  function setMicLevel(value) {
    if (destroyed) return api;
    const n = Number(value);
    if (!Number.isFinite(n)) return api;
    micTarget = Math.min(1, Math.max(0, n));
    ensureLoop();
    return api;
  }

  function setLevel(cefr) {
    if (destroyed) return api;
    if (cefr == null || cefr === '') {
      if (el.levelChip) el.levelChip.hidden = true;
      return api;
    }
    const m = String(cefr).trim().toUpperCase().match(/^([ABC][12])$/);
    if (!m) return api;
    level = m[1];
    if (el.levelVal) el.levelVal.textContent = level;
    if (el.levelChip) el.levelChip.hidden = false;
    return api;
  }

  function setTeacherName(name) {
    if (destroyed) return api;
    const raw = typeof name === 'string' ? name.trim().slice(0, 20) : '';
    teacherName = raw || 'Ava';
    if (el.name) el.name.textContent = teacherName;
    render();
    return api;
  }

  function wave() {
    if (destroyed) return api;
    clearTimeout(waveTimer);
    root.classList.remove('is-waving');
    // 强制重启 CSS 动画
    void root.offsetWidth;
    root.classList.add('is-waving');
    waveTimer = setTimeout(() => {
      if (!destroyed) root.classList.remove('is-waving');
    }, 2400);
    return api;
  }

  function nod() {
    if (destroyed) return api;
    clearTimeout(nodTimer);
    root.classList.remove('is-nodding');
    void root.offsetWidth;
    root.classList.add('is-nodding');
    nodTimer = setTimeout(() => {
      if (!destroyed) root.classList.remove('is-nodding');
    }, 900);
    return api;
  }

  function setReducedMotion(on) {
    forcedReduced = !!on;
    applyReducedMotion();
    return api;
  }

  function setHudVisible(on) {
    if (el.hud) el.hud.hidden = !on;
    return api;
  }

  function applyReducedMotion() {
    reducedMotion = forcedReduced || !!(mql && mql.matches);
    root.classList.toggle('ava-reduced', reducedMotion);
    if (reducedMotion) {
      clearTimeout(blinkTimer);
    } else {
      scheduleBlink();
    }
  }

  /* ---------- 尺寸自适应 ---------- */
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => syncSize())
    : null;

  function syncSize() {
    if (destroyed) return;
    const cs = getComputedStyle(container);
    const containerAuto = cs.height === 'auto' || parseFloat(cs.height) < 60;
    if (containerAuto) {
      root.classList.add('ava-root--auto');
    } else {
      root.classList.remove('ava-root--auto');
    }
    const w = root.clientWidth || container.clientWidth || 0;
    root.dataset.size = w > 0 && w < 340 ? 'sm' : (w < 600 ? 'md' : 'lg');
  }

  function onMqlChange() { applyReducedMotion(); }

  /* ---------- 初始化 ---------- */
  function init() {
  if (opts.teacherName) setTeacherName(opts.teacherName);
  if (opts.level) setLevel(opts.level);
  if (opts.hud === false && el.hud) el.hud.hidden = true;
  if (opts.state && STATE_META[opts.state]) {
    state = opts.state;
    if (opts.state === 'celebrate') triggerCelebrate();
  }
  if (opts.emotion && EMOTIONS.includes(String(opts.emotion).toLowerCase())) {
    emotionOverride = String(opts.emotion).toLowerCase();
  }
  applyReducedMotion();
  render();
  applyMic(0, 0);
  syncSize();
  if (ro) {
    try { ro.observe(container); } catch { /* ignore */ }
  }
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onMqlChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onMqlChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', syncSize, { passive: true });
  }
  }

  /* ---------- destroy ---------- */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    externalSpeech.active = false;
    externalSpeech.target = 0;
    externalSpeech.current = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    stopFallbackTimer();
    clearTimeout(blinkTimer);
    clearTimeout(waveTimer);
    clearTimeout(nodTimer);
    clearTimeout(celebrateTimer);
    clearTimeout(cleanTimer);
    if (ro) { try { ro.disconnect(); } catch { /* ignore */ } }
    if (mql) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onMqlChange);
      else if (typeof mql.removeListener === 'function') mql.removeListener(onMqlChange);
    }
    if (typeof window !== 'undefined') window.removeEventListener('resize', syncSize);
    if (root.parentNode) root.parentNode.removeChild(root);
    if (container.__avaInstance === api) delete container.__avaInstance;
  }

  const api = {
    el: root,
    root,
    version: AVATAR_VERSION,
    setState,
    setEmotion,
    beginSpeech,
    wordBoundary,
    endSpeech,
    setMicLevel,
    setSpeechLevel,
    setViseme: setVisemePose,
    setLevel,
    setTeacherName,
    wave,
    nod,
    blink,
    setReducedMotion,
    setHudVisible,
    destroy,
    get state() { return state; },
    get emotion() { return resolveExpression(); },
    get speaking() { return speaking; },
    get speechLevel() { return externalSpeech.active ? externalSpeech.current : 0; },
  };

  init();
  container.__avaInstance = api;
  return api;
}

export default mountAvatar;
