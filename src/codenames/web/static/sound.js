// Sound effects, all synthesised with WebAudio (no audio files).

let ctx = null;
let out = null;
let muted = localStorage.getItem("codenames.muted") === "1";
let volume = Number(localStorage.getItem("codenames.volume") ?? 0.8);
let noiseBuffer = null;
// The effects are written at modest per-sound gains; this lifts them to a loud level at full volume.
const BOOST = 5;

export const isMuted = () => muted;
export const getVolume = () => volume;

export function setMuted(value) {
  muted = value;
  localStorage.setItem("codenames.muted", value ? "1" : "0");
}

export function setVolume(value) {
  volume = Math.min(1, Math.max(0, value));
  localStorage.setItem("codenames.volume", String(volume));
  if (out) out.gain.setTargetAtTime(volume * BOOST, ctx.currentTime, 0.02);
}

// Browsers only start audio after a user gesture.
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    out = ctx.createGain();
    out.gain.value = volume * BOOST;
    out.connect(limiter).connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

function ready() {
  return !muted && volume > 0 && ctx && ctx.state === "running";
}

function tone(freq, dur, { type = "sine", gain = 0.07, at = 0, slide = 0 } = {}) {
  if (!ready()) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  amp.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.08));
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(dur, { gain = 0.06, at = 0, freq = 2500, q = 0.9, slide = 0, type = "bandpass" } = {}) {
  if (!ready()) return;
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (slide) filter.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  filter.Q.value = q;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(amp).connect(out);
  src.start(t);
  src.stop(t + dur + 0.05);
}

const flip = (at = 0) => noise(0.12, { gain: 0.07, freq: 3200, at, slide: 0.5 });

export const sfx = {
  deal: (n = 25) => {
    for (let i = 0; i < n; i++) noise(0.05, { gain: 0.035, freq: 2800 + (i % 3) * 400, at: i * 0.035 });
  },
  mark: () => tone(1320, 0.05, { type: "triangle", gain: 0.03 }),
  clue: () => {
    tone(660, 0.14, { type: "triangle", gain: 0.05 });
    tone(990, 0.22, { type: "triangle", gain: 0.05, at: 0.11 });
  },
  agent: () => {
    flip();
    [784, 988, 1319].forEach((f, i) => tone(f, 0.16, { type: "triangle", gain: 0.05, at: 0.12 + i * 0.07 }));
  },
  enemy: () => {
    flip();
    tone(330, 0.32, { type: "sawtooth", gain: 0.025, at: 0.12, slide: 0.6 });
  },
  civilian: () => {
    flip();
    tone(440, 0.18, { type: "sine", gain: 0.05, at: 0.12, slide: 0.85 });
  },
  assassin: () => {
    flip();
    tone(90, 1.1, { type: "sine", gain: 0.16, at: 0.1, slide: 0.45 });
    noise(0.9, { gain: 0.12, freq: 400, at: 0.1, type: "lowpass", q: 0.5 });
    tone(55, 0.9, { type: "square", gain: 0.03, at: 0.15 });
  },
  turn: () => noise(0.45, { gain: 0.05, freq: 600, slide: 6, q: 1.5 }),
  yourTurn: () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: "triangle", gain: 0.05, at: i * 0.09 })),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.24, { type: "triangle", gain: 0.06, at: i * 0.11 })),
  lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, { type: "triangle", gain: 0.05, at: i * 0.16 })),
  tick: () => tone(1250, 0.03, { type: "square", gain: 0.018 }),
  error: () => tone(170, 0.16, { type: "sawtooth", gain: 0.03 }),
  chat: () => tone(880, 0.07, { gain: 0.03 }),
  pop: () => tone(600, 0.08, { type: "sine", gain: 0.04, slide: 1.6 }),
};
