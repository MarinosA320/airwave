/*
 * Airwave voice: push-to-talk radio in the browser (ATC scope and Airwave Pilot).
 *  - While PTT is held, the microphone is sampled at 16 kHz, compressed to 8-bit mu-law and sent in ~100 ms chunks
 *    ({t:'voice', seq, rate, data}). The server relays them to everyone tuned to the same frequency.
 *  - Incoming chunks are played back through a radio filter (300-3000 Hz, a little drive) with a short squelch tail.
 *  - speak(text): optional text-to-speech for typed radio messages and simulated pilots.
 */
(function (root) {
  'use strict';
  const RATE = 16000, CHUNK = 1600; // 100 ms

  // G.711 mu-law
  function muEncode(s) {
    const BIAS = 0x84, CLIP = 32635;
    let sign = (s >> 8) & 0x80; if (sign) s = -s; if (s > CLIP) s = CLIP; s += BIAS;
    let exp = 7; for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
    const mant = (s >> (exp + 3)) & 0x0f;
    return ~(sign | (exp << 4) | mant) & 0xff;
  }
  const MU_TABLE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
    let s = ((mant << 3) + 0x84) << exp; s -= 0x84;
    MU_TABLE[i] = (sign ? -s : s) / 32768;
  }
  const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = str => { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

  class AirwaveVoice {
    // send(msg): sends a protocol message; onState({tx, rx, error}): UI updates
    constructor({ send, onState }) {
      this.send = send; this.onState = onState || (() => {});
      this.ctx = null; this.tx = false; this.seq = 0; this.buf = []; this.speakers = new Map(); this.volume = 0.9;
      this.ttsVoices = [];
      if (root.speechSynthesis) { const load = () => { this.ttsVoices = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); }; load(); speechSynthesis.onvoiceschanged = load; }
    }
    audio() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC();
        this.out = this.ctx.createGain(); this.out.gain.value = this.volume;
        // Radio sound: band-limited, slightly driven.
        const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320;
        const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3100;
        const drive = this.ctx.createWaveShaper(); const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
        drive.curve = curve;
        this.radioIn = hp; hp.connect(lp); lp.connect(drive); drive.connect(this.out); this.out.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    setVolume(v) { this.volume = v; if (this.out) this.out.gain.value = v; }
    // Microphone is opened on first use (the browser asks for permission once).
    async mic() {
      if (this.proc) return true;
      try {
        const ctx = this.audio();
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const src = ctx.createMediaStreamSource(this.stream);
        this.proc = ctx.createScriptProcessor(2048, 1, 1);
        const ratio = ctx.sampleRate / RATE;
        let pos = 0;
        this.proc.onaudioprocess = e => {
          if (!this.tx) return;
          const inp = e.inputBuffer.getChannelData(0);
          // Resample to 16 kHz by averaging (simple and good enough for speech).
          for (; pos < inp.length; pos += ratio) {
            const a = Math.floor(pos), b = Math.min(inp.length - 1, Math.floor(pos + ratio));
            let sum = 0, n = 0; for (let k = a; k <= b; k++) { sum += inp[k]; n++; }
            this.buf.push(Math.max(-1, Math.min(1, sum / n)));
          }
          pos -= inp.length;
          while (this.buf.length >= CHUNK) this.flush(CHUNK);
        };
        src.connect(this.proc); this.proc.connect(ctx.destination); // the processor only runs when connected (it outputs silence)
        return true;
      } catch (e) {
        this.onState({ error: 'Microphone not available: ' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message) });
        return false;
      }
    }
    flush(n) {
      const chunk = this.buf.splice(0, n);
      if (!chunk.length) return;
      const bytes = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) bytes[i] = muEncode(Math.round(chunk[i] * 32767));
      this.send({ t: 'voice', seq: ++this.seq, rate: RATE, data: toB64(bytes) });
    }
    async ptt(on) {
      if (on === this.tx) return;
      if (on) {
        if (!(await this.mic())) return;
        this.tx = true; this.buf = [];
        if (root.speechSynthesis) speechSynthesis.cancel(); // don't talk over yourself
      } else {
        this.tx = false; this.flush(this.buf.length);
        this.send({ t: 'voice', end: true });
      }
      this.onState({ tx: this.tx });
    }
    // Incoming speech from someone on the frequency.
    receive(m) {
      const ctx = this.audio();
      let sp = this.speakers.get(m.from);
      if (!sp) { sp = { next: 0, timer: null }; this.speakers.set(m.from, sp); }
      if (m.data) {
        const bytes = fromB64(m.data), rate = m.rate || RATE;
        const buf = ctx.createBuffer(1, bytes.length, rate), ch = buf.getChannelData(0);
        for (let i = 0; i < bytes.length; i++) ch[i] = MU_TABLE[bytes[i]];
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this.radioIn);
        const now = ctx.currentTime;
        if (sp.next < now + 0.05) sp.next = now + 0.15; // jitter buffer at the start of each transmission
        src.start(sp.next); sp.next += buf.duration;
      }
      clearTimeout(sp.timer);
      this.onState({ rx: m.from });
      const left = Math.max(0, sp.next - ctx.currentTime);
      const done = () => { this.squelch(); this.speakers.delete(m.from); this.onState({ rx: null, rxEnd: m.from }); };
      sp.timer = setTimeout(done, (m.end ? left : left + 0.6) * 1000);
    }
    squelch() {
      const ctx = this.ctx; if (!ctx) return;
      const len = Math.floor(ctx.sampleRate * 0.09), buf = ctx.createBuffer(1, len, ctx.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * 0.18 * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this.radioIn); src.start();
    }
    // Text-to-speech, a steady voice per callsign so different pilots sound different.
    speak(text, who) {
      if (!root.speechSynthesis || !text) return;
      const u = new SpeechSynthesisUtterance(text.replace(/\bFL(\d+)/g, 'flight level $1').replace(/(\d)(\d)(\d)\.(\d)(\d)(\d)/g, '$1 $2 $3 decimal $4 $5'));
      if (this.ttsVoices.length && who) { let h = 0; for (const c of who) h = (h * 31 + c.charCodeAt(0)) >>> 0; u.voice = this.ttsVoices[h % this.ttsVoices.length]; }
      u.rate = 1.12; u.volume = this.volume;
      speechSynthesis.speak(u);
    }
  }
  root.AirwaveVoice = AirwaveVoice;
})(typeof self !== 'undefined' ? self : this);
