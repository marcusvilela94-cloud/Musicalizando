"use client";
// Efeitos sonoros: acerto e erro vêm de arquivos (public/sfx, pré-carregados e
// com o silêncio do início/fim cortado); os demais são sintetizados na hora. Usa o mesmo AudioContext da música, mas com
// uma cadeia própria (volume dos efeitos -> compressor -> saída), separada da música.
import { type AudioManager, sharedAudio } from "./audio";
import type { SfxVolume } from "./types";

type Wave = OscillatorType;

/** Duração (s) de cada efeito, para a música esperar o efeito acabar. */
export const SFX_LEN = { buzz: 0.35, correct: 0.75, wrong: 0.95, tick: 0.08, reveal: 1.1, fanfare: 2.4, bid: 0.45, pass: 0.25, sudden: 2.2, mode: 0.9 } as const;

export type SfxName = keyof typeof SFX_LEN;

const NOTE = (n: number) => 440 * 2 ** ((n - 69) / 12); // MIDI -> Hz

/** Ganho antes do compressor: quanto maior, mais alto (o compressor segura os picos). */
const DRIVE: Record<SfxVolume, number> = { low: 1, medium: 2, high: 3.5 };

/** Efeitos que vêm de arquivo. */
const FILES = { correct: "/sfx/acerto.mp3", wrong: "/sfx/erro.mp3" } as const;
type FileSfx = keyof typeof FILES;
/** Ganho dos arquivos (já vêm normalizados; o volume dos efeitos e o compressor fazem o resto). */
const FILE_GAIN = 0.6;
/** Abaixo disso (≈ −40 dB) conta como silêncio. */
const SILENCE = 0.01;

/** Corta o silêncio do início e do fim de um áudio decodificado. */
function trimSilence(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const loud = (i: number) => chans.some((d) => Math.abs(d[i]) > SILENCE);
  let start = 0;
  while (start < buf.length && !loud(start)) start++;
  let end = buf.length - 1;
  while (end > start && !loud(end)) end--;
  if (start >= end) return buf;
  end = Math.min(buf.length, end + Math.round(buf.sampleRate * 0.01)); // 10 ms de cauda
  const out = ctx.createBuffer(buf.numberOfChannels, end - start, buf.sampleRate);
  chans.forEach((d, c) => out.copyToChannel(d.subarray(start, end), c));
  return out;
}

export class Sfx {
  enabled = true;
  private volume: SfxVolume = "high";
  private bus: { ctx: AudioContext; input: GainNode } | null = null;
  private bytes = new Map<FileSfx, Promise<ArrayBuffer>>();
  private buffers = new Map<FileSfx, { ctx: BaseAudioContext; buf: AudioBuffer }>();
  private decoding = new Map<FileSfx, Promise<void>>();
  constructor(private audio: AudioManager) {}

  /**
   * Baixa os arquivos de acerto/erro e, assim que o áudio estiver liberado,
   * decodifica e corta o silêncio. Chamar ao abrir a sala (e de novo ao liberar o som).
   */
  preload() {
    for (const name of Object.keys(FILES) as FileSfx[]) {
      if (!this.bytes.has(name)) {
        const p = fetch(FILES[name]).then((r) => {
          if (!r.ok) throw new Error(`${FILES[name]}: ${r.status}`);
          return r.arrayBuffer();
        });
        p.catch(() => this.bytes.delete(name));
        this.bytes.set(name, p);
      }
      const ctx = this.audio.ctx;
      if (ctx && this.buffers.get(name)?.ctx !== ctx && !this.decoding.has(name)) {
        const d = this.bytes.get(name)!
          .then((b) => ctx.decodeAudioData(b.slice(0)))
          .then((buf) => void this.buffers.set(name, { ctx, buf: trimSilence(ctx, buf) }))
          .catch(() => {})
          .finally(() => this.decoding.delete(name));
        this.decoding.set(name, d);
      }
    }
  }

  /** Duração real (s) do efeito: a do arquivo já cortado, se carregado. */
  length(name: SfxName) {
    const hit = name === "correct" || name === "wrong" ? this.buffers.get(name) : undefined;
    return hit && hit.ctx === this.audio.ctx ? hit.buf.duration : SFX_LEN[name];
  }

  /** Toca o arquivo; devolve false se ainda não carregou (aí usa o sintetizado). */
  private sample(name: FileSfx) {
    const ctx = this.ctx;
    const hit = this.buffers.get(name);
    if (!ctx || !hit || hit.ctx !== ctx) {
      this.preload();
      return false;
    }
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = hit.buf;
    g.gain.value = FILE_GAIN;
    src.connect(g).connect(this.out(ctx));
    src.start();
    return true;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  setVolume(v: SfxVolume | undefined) {
    this.volume = v ?? "high";
    if (this.bus) this.bus.input.gain.setTargetAtTime(DRIVE[this.volume], this.bus.ctx.currentTime, 0.02);
  }

  /** Entrada da cadeia dos efeitos: ganho (volume) -> compressor/limitador -> saída. */
  private out(ctx: AudioContext) {
    if (this.bus?.ctx !== ctx) {
      const input = ctx.createGain();
      input.gain.value = DRIVE[this.volume];
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.knee.value = 4;
      comp.ratio.value = 20;
      comp.attack.value = 0.002;
      comp.release.value = 0.15;
      input.connect(comp).connect(ctx.destination);
      this.bus = { ctx, input };
    }
    return this.bus.input;
  }

  private get ctx() {
    const c = this.audio.ctx;
    return c && c.state === "running" ? c : null;
  }

  /** Um "bip" com envelope (ataque rápido, decaimento exponencial). */
  private tone(
    freq: number,
    at: number,
    dur: number,
    { type = "sine" as Wave, gain = 0.25, to, filter }: { type?: Wave; gain?: number; to?: number; filter?: number } = {},
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filter;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(this.out(ctx));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Buzina de "errou!" de programa de auditório: grave, áspera, volume constante e corte seco. */
  private buzzer(dur: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const end = t0 + dur;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.012); // ataque quase instantâneo
    g.gain.setValueAtTime(0.3, end - 0.012);
    g.gain.linearRampToValueAtTime(0, end); // corte seco (sem clique)
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 2400;
    f.Q.value = 2; // realça a aspereza perto do corte
    f.connect(g).connect(this.out(ctx));
    // duas ondas graves levemente desafinadas -> batimento "rascante"
    for (const [type, freq, gain] of [["sawtooth", 125, 0.8], ["square", 131, 0.55], ["sawtooth", 62.5, 0.35]] as const) {
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      og.gain.value = gain;
      osc.connect(og).connect(f);
      osc.start(t0);
      osc.stop(end + 0.02);
    }
  }

  play(name: SfxName, opts?: { last?: boolean }) {
    if (!this.enabled || !this.ctx) return;
    switch (name) {
      case "buzz": // "apertou!": dois bipes rápidos subindo
        this.tone(880, 0, 0.12, { type: "square", gain: 0.12 });
        this.tone(1320, 0.12, 0.2, { type: "square", gain: 0.12 });
        break;
      case "correct": // arquivo (reserva: arpejo maior ascendente)
        if (this.sample("correct")) break;
        [72, 76, 79, 84].forEach((n, i) => this.tone(NOTE(n), i * 0.09, 0.4, { type: "triangle", gain: 0.22 }));
        break;
      case "wrong": // arquivo (reserva: buzina de "errou!")
        if (this.sample("wrong")) break;
        this.buzzer(SFX_LEN.wrong);
        break;
      case "tick": // tique-taque (o último segundo é mais agudo)
        this.tone(opts?.last ? 1500 : 1000, 0, 0.06, { type: "square", gain: 0.08, filter: 3000 });
        break;
      case "reveal": // varredura subindo + acorde brilhante
        this.tone(220, 0, 0.6, { type: "sawtooth", gain: 0.08, to: 880, filter: 2500 });
        [79, 83, 86].forEach((n) => this.tone(NOTE(n), 0.5, 0.6, { type: "sine", gain: 0.12 }));
        break;
      case "bid": // martelo do leiloeiro: duas batidas secas + "plim"
        this.tone(180, 0, 0.09, { type: "square", gain: 0.3, to: 70, filter: 1200 });
        this.tone(180, 0.14, 0.09, { type: "square", gain: 0.3, to: 70, filter: 1200 });
        this.tone(NOTE(88), 0.26, 0.2, { type: "triangle", gain: 0.12 });
        break;
      case "pass": // "Pode tocar!": bipe curto descendo
        this.tone(660, 0, 0.18, { type: "sine", gain: 0.14, to: 440 });
        break;
      case "mode": // anúncio do modo: varredura rápida subindo + "ding" duplo
        this.tone(300, 0, 0.35, { type: "sawtooth", gain: 0.07, to: 1200, filter: 3000 });
        this.tone(NOTE(84), 0.3, 0.3, { type: "triangle", gain: 0.2 });
        this.tone(NOTE(91), 0.45, 0.45, { type: "triangle", gain: 0.2 });
        break;
      case "sudden": { // "MORTE SÚBITA!": tambor grave + três acordes menores descendo (dramático)
        for (const at of [0, 0.16, 0.32]) this.tone(70, at, 0.18, { type: "sine", gain: 0.45, to: 40 });
        const chords: [number, number[]][] = [[0.5, [57, 60, 64]], [0.9, [56, 59, 63]], [1.3, [50, 53, 57, 62]]];
        for (const [at, notes] of chords) {
          for (const n of notes) this.tone(NOTE(n), at, at > 1 ? 0.9 : 0.35, { type: "sawtooth", gain: 0.07, filter: 1600 });
          this.tone(NOTE(notes[0] - 12), at, at > 1 ? 0.9 : 0.35, { type: "triangle", gain: 0.14 });
        }
        break;
      }
      case "fanfare": { // fanfarra do pódio
        const seq: [number, number, number][] = [
          [67, 0, 0.18], [72, 0.2, 0.18], [76, 0.4, 0.18], [79, 0.6, 0.45],
          [76, 1.1, 0.16], [79, 1.3, 1.0],
        ];
        for (const [n, at, d] of seq) {
          this.tone(NOTE(n), at, d, { type: "sawtooth", gain: 0.12, filter: 2200 });
          this.tone(NOTE(n - 12), at, d, { type: "triangle", gain: 0.1 });
        }
        break;
      }
    }
  }
}

let shared: Sfx | null = null;
export function sharedSfx() {
  if (!shared) shared = new Sfx(sharedAudio());
  return shared;
}
