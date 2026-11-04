"use client";
// Toca as prévias com a Web Audio API para cortes precisos (1 s é 1 s).
// O áudio é baixado com fetch direto da CDN do Deezer (que libera CORS),
// decodificado na memória e descartado — nada é armazenado.
import { deezer } from "./api";

export type PlayHandle = {
  /** Para o som (se ainda tocando) e devolve quantos segundos tocaram. */
  stop: () => number;
};

type Loaded = { buffer: AudioBuffer; artists: string[] };

export class AudioManager {
  ctx: AudioContext | null = null;
  private cache = new Map<number, Promise<Loaded>>();
  private active = new Set<{ src: AudioBufferSourceNode; gain: GainNode; halt: () => void }>();

  get unlocked() {
    return !!this.ctx && this.ctx.state === "running";
  }

  /** Precisa ser chamado num clique (navegadores bloqueiam som automático). */
  async unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state !== "running") await this.ctx.resume();
    // toca um silêncio curtinho para liberar de vez no Safari
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start();
  }

  /** Busca o link atualizado da prévia (expira) e decodifica. Resultado fica em cache por rodada. */
  load(deezerId: number): Promise<Loaded> {
    const hit = this.cache.get(deezerId);
    if (hit) return hit;
    const p = (async () => {
      if (!this.ctx) throw new Error("Áudio não liberado");
      const info = await deezer.track(deezerId);
      const res = await fetch(info.preview);
      if (!res.ok) throw new Error(`Prévia indisponível (${res.status})`);
      const data = await res.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(data);
      return { buffer, artists: info.artists };
    })();
    p.catch(() => this.cache.delete(deezerId));
    this.cache.set(deezerId, p);
    // guarda no máximo 3 músicas decodificadas
    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /** Toca `duration` segundos a partir de `offset`. `onEnd` só dispara se terminar sozinho. */
  play(buffer: AudioBuffer, offset: number, duration: number, onEnd?: () => void, fadeOutSec = 0): PlayHandle {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    src.connect(gain).connect(ctx.destination);
    const startAt = ctx.currentTime;
    const dur = Math.max(0, Math.min(duration, buffer.duration - offset));
    gain.gain.setValueAtTime(1, startAt);
    if (fadeOutSec > 0 && dur > fadeOutSec) {
      gain.gain.setValueAtTime(1, startAt + dur - fadeOutSec);
      gain.gain.linearRampToValueAtTime(0.0001, startAt + dur);
    }
    let stoppedAt: number | null = null;
    let ended = false;
    const entry = {
      src,
      gain,
      halt: () => {
        if (stoppedAt !== null) return;
        stoppedAt = ctx.currentTime;
        try {
          // fade de 40 ms para não estalar
          gain.gain.cancelScheduledValues(stoppedAt);
          gain.gain.setValueAtTime(gain.gain.value, stoppedAt);
          gain.gain.linearRampToValueAtTime(0.0001, stoppedAt + 0.04);
          src.stop(stoppedAt + 0.05);
        } catch {
          /* já parado */
        }
        this.active.delete(entry);
      },
    };
    src.onended = () => {
      this.active.delete(entry);
      if (stoppedAt === null && !ended) {
        ended = true;
        stoppedAt = ctx.currentTime;
        onEnd?.();
      }
    };
    src.start(startAt, offset, dur);
    this.active.add(entry);
    return {
      stop: () => {
        entry.halt();
        return Math.min(dur, (stoppedAt ?? ctx.currentTime) - startAt);
      },
    };
  }

  /** Para tudo na hora (ex.: alguém apertou EU SEI!). */
  stopAll() {
    for (const e of [...this.active]) e.halt();
  }
}
