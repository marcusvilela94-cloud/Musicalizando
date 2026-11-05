"use client";
import { useEffect, useRef, useState } from "react";
import type { PlayHandle } from "@/lib/audio";
import { turnOpen } from "@/lib/game";
import type { StemName } from "@/lib/types";
import type { TvEngineProps } from "../types";
import { stemUrl, stemsOf } from "./logic";

/** Um comando "Tocar" mais velho que isso não toca de novo (ex.: a TV recarregou). */
const STALE_PLAY_MS = 4000;

/** Soma as faixas numa só (mesmo instante de início = sincronia perfeita). */
function mix(ctx: AudioContext, parts: AudioBuffer[]): AudioBuffer {
  const length = Math.max(...parts.map((b) => b.length));
  const out = ctx.createBuffer(1, length, parts[0].sampleRate);
  const data = out.getChannelData(0);
  for (const b of parts) {
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const k = 1 / b.numberOfChannels;
      for (let i = 0; i < src.length; i++) data[i] += src[i] * k;
    }
  }
  return out;
}

/**
 * Instrumentos: baixa as faixas separadas da rodada (bucket npl_stems) e, a
 * cada "Tocar" / "Repetir" / "Próxima camada" (ou "Próximo trecho"), toca:
 *  - Camadas: a soma das camadas até o estágio atual, a prévia inteira;
 *  - Um só: o instrumento, por 5 / 15 / 30 s.
 * Se as faixas não carregarem, toca a prévia original (o jogo não trava).
 */
export function StemsTvEngine({ round, paused, buffer, audio, serverNow, onPlayingChange }: TvEngineProps) {
  const handled = useRef<{ roundId: string; seq: number } | null>(null);
  const current = useRef<PlayHandle | null>(null);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const s = stemsOf(round);
  const key = s?.key ?? null;
  const needed: StemName[] = s ? (s.variant === "single" ? [s.instrument ?? "drums"] : (s.layers ?? [])) : [];
  const neededKey = needed.join(",");
  const [stems, setStems] = useState<{ key: string; bufs: Partial<Record<StemName, AudioBuffer>>; failed: boolean } | null>(null);

  // baixa e decodifica as faixas da rodada
  useEffect(() => {
    if (!key || !audio.ctx || !neededKey) return;
    let alive = true;
    const ctx = audio.ctx;
    (async () => {
      try {
        const names = neededKey.split(",") as StemName[];
        const bufs = await Promise.all(
          names.map(async (n) => {
            const res = await fetch(stemUrl(key, n));
            if (!res.ok) throw new Error(`faixa ${n}: ${res.status}`);
            return [n, await ctx.decodeAudioData(await res.arrayBuffer())] as const;
          }),
        );
        if (alive) setStems({ key, bufs: Object.fromEntries(bufs), failed: false });
      } catch {
        if (alive) setStems({ key, bufs: {}, failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, neededKey, audio]);

  const ready = !!stems && stems.key === key;
  // um time por vez: a música continua enquanto o time da vez responde
  const open = (round.status === "playing" || turnOpen(round)) && !paused;

  useEffect(() => {
    if (open) return;
    current.current?.stop();
    current.current = null;
    onPlayingRef.current(false);
  }, [open, round.id]);

  // a mistura de cada estágio é calculada uma vez
  const mixes = useRef<{ key: string; byStage: Map<number, AudioBuffer> } | null>(null);

  useEffect(() => {
    if (!s || !ready || !audio.ctx) return;
    if (!handled.current || handled.current.roundId !== round.id) {
      const fresh = !!round.play_at && serverNow() - Date.parse(round.play_at) < STALE_PLAY_MS;
      handled.current = { roundId: round.id, seq: fresh ? round.play_seq - 1 : round.play_seq };
    }
    if (round.play_seq <= handled.current.seq || round.played_stage < 1) return;
    handled.current.seq = round.play_seq;
    if (!open) return;

    const stage = round.played_stage;
    let buf: AudioBuffer | null = null;
    let len = Infinity;
    if (!stems!.failed) {
      if (s.variant === "single") {
        buf = stems!.bufs[s.instrument ?? "drums"] ?? null;
        const isLast = stage >= (s.secs?.length ?? 3);
        len = isLast ? Infinity : (s.secs?.[stage - 1] ?? 5);
      } else {
        if (!mixes.current || mixes.current.key !== s.key) mixes.current = { key: s.key, byStage: new Map() };
        buf = mixes.current.byStage.get(stage) ?? null;
        if (!buf) {
          const parts = (s.layers ?? []).slice(0, stage).map((n) => stems!.bufs[n]).filter(Boolean) as AudioBuffer[];
          if (parts.length) {
            buf = mix(audio.ctx, parts);
            mixes.current.byStage.set(stage, buf);
          }
        }
      }
    }
    buf = buf ?? buffer; // não carregou: a prévia original
    if (!buf) return;

    current.current?.stop();
    onPlayingRef.current(true);
    const dur = Math.min(len, buf.duration);
    const handle: PlayHandle = audio.play(
      buf,
      0,
      dur,
      () => {
        if (current.current === handle) {
          current.current = null;
          onPlayingRef.current(false);
        }
      },
      dur >= buf.duration ? 1.5 : 0,
    );
    current.current = handle;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- s/stems mudam junto com round.id/ready
  }, [ready, buffer, round.id, round.play_seq, round.played_stage, round.play_at, open, audio, serverNow]);

  useEffect(
    () => () => {
      current.current?.stop();
      current.current = null;
    },
    [],
  );
  return null;
}
