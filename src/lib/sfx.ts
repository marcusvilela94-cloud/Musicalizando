"use client";
// Efeitos sonoros sintetizados na hora (Web Audio: osciladores + envelopes).
// Nenhum arquivo de áudio externo. Usa o mesmo AudioContext da música.
import { type AudioManager, sharedAudio } from "./audio";

type Wave = OscillatorType;

/** Duração (s) de cada efeito, para a música esperar o efeito acabar. */
export const SFX_LEN = { buzz: 0.35, correct: 0.75, wrong: 0.6, tick: 0.08, reveal: 1.1, fanfare: 2.4 } as const;

export type SfxName = keyof typeof SFX_LEN;

const NOTE = (n: number) => 440 * 2 ** ((n - 69) / 12); // MIDI -> Hz

export class Sfx {
  enabled = true;
  constructor(private audio: AudioManager) {}

  setEnabled(on: boolean) {
    this.enabled = on;
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
    node.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  play(name: SfxName, opts?: { last?: boolean }) {
    if (!this.enabled || !this.ctx) return;
    switch (name) {
      case "buzz": // "apertou!": dois bipes rápidos subindo
        this.tone(880, 0, 0.12, { type: "square", gain: 0.12 });
        this.tone(1320, 0.12, 0.2, { type: "square", gain: 0.12 });
        break;
      case "correct": // arpejo maior ascendente
        [72, 76, 79, 84].forEach((n, i) => this.tone(NOTE(n), i * 0.09, 0.4, { type: "triangle", gain: 0.22 }));
        break;
      case "wrong": // buzina grave curta
        this.tone(130, 0, 0.55, { type: "sawtooth", gain: 0.18, to: 95, filter: 900 });
        this.tone(137, 0, 0.55, { type: "sawtooth", gain: 0.14, to: 100, filter: 900 });
        break;
      case "tick": // tique-taque (o último segundo é mais agudo)
        this.tone(opts?.last ? 1500 : 1000, 0, 0.06, { type: "square", gain: 0.08, filter: 3000 });
        break;
      case "reveal": // varredura subindo + acorde brilhante
        this.tone(220, 0, 0.6, { type: "sawtooth", gain: 0.08, to: 880, filter: 2500 });
        [79, 83, 86].forEach((n) => this.tone(NOTE(n), 0.5, 0.6, { type: "sine", gain: 0.12 }));
        break;
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
