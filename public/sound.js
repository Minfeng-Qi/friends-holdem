'use strict';
// 用 Web Audio 现场合成的音效，无需任何音频文件。
const Sfx = (() => {
  let ctx = null;
  let enabled = true;
  try { enabled = localStorage.getItem('pokerSound') !== 'off'; } catch {}

  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    return ctx;
  }
  function resume() { const c = ac(); if (c && c.state === 'suspended') c.resume(); }

  // 基础音：一个带包络的振荡器，可滑音
  function tone(freq, dur, { type = 'sine', gain = 0.2, when = 0, glideTo = null, attack = 0.005 } = {}) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // 噪声：一段过滤白噪声，用于牌/筹码摩擦声
  function noise(dur, { type = 'highpass', freq = 2000, gain = 0.15, when = 0, q = 0.7 } = {}) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + when;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    card()  { noise(0.14, { type: 'highpass', freq: 1800, gain: 0.13 }); },
    deal()  { for (let i = 0; i < 2; i++) noise(0.12, { type: 'highpass', freq: 1600 + i*300, gain: 0.11, when: i*0.06 }); },
    flip()  { noise(0.10, { type: 'bandpass', freq: 2600, gain: 0.16 }); tone(520, 0.08, { type: 'triangle', gain: 0.05 }); },
    chip()  { noise(0.06, { type: 'highpass', freq: 4200, gain: 0.10 }); tone(1300, 0.05, { type: 'square', gain: 0.03, when: 0.005 }); },
    chips() { for (let i = 0; i < 5; i++) { noise(0.05, { type: 'highpass', freq: 3800 + Math.random()*1200, gain: 0.08, when: i*0.05 }); } },
    check() { tone(180, 0.09, { type: 'sine', gain: 0.18 }); tone(150, 0.10, { type: 'sine', gain: 0.14, when: 0.11 }); },
    fold()  { noise(0.22, { type: 'lowpass', freq: 1200, gain: 0.10 }); tone(300, 0.2, { type: 'sine', gain: 0.05, glideTo: 140 }); },
    raise() { SOUNDS.chip(); tone(440, 0.16, { type: 'triangle', gain: 0.10, when: 0.02, glideTo: 720 }); },
    allin() { tone(240, 0.35, { type: 'sawtooth', gain: 0.10, glideTo: 900 }); noise(0.35, { type: 'bandpass', freq: 3000, gain: 0.06 }); tone(1200, 0.25, { type: 'sine', gain: 0.05, when: 0.12 }); },
    win()   { const notes = [523, 659, 784, 1046]; notes.forEach((f, i) => tone(f, 0.5, { type: 'triangle', gain: 0.14, when: i*0.09 })); },
    turn()  { tone(880, 0.12, { type: 'sine', gain: 0.14 }); tone(1174, 0.14, { type: 'sine', gain: 0.12, when: 0.13 }); },
    click() { tone(600, 0.04, { type: 'square', gain: 0.05 }); },
  };

  function play(name) {
    if (!enabled) return;
    resume();
    const fn = SOUNDS[name];
    if (fn) try { fn(); } catch {}
  }
  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem('pokerSound', enabled ? 'on' : 'off'); } catch {}
    if (enabled) resume();
  }
  function isEnabled() { return enabled; }

  return { play, setEnabled, isEnabled, resume };
})();
