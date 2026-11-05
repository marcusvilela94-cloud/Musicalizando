"use client";
import { useEffect, useRef } from "react";
import type { PlayHandle } from "@/lib/audio";
import { turnOpen } from "@/lib/game";
import type { TvEngineProps } from "../types";
import { CLASSIC_STAGES } from "./stages";

/** Um comando "Tocar" mais velho que isso não toca de novo (ex.: a TV recarregou). */
const STALE_PLAY_MS = 4000;

/**
 * Nada avança sozinho: cada "Tocar" / "Repetir" / "Próximo trecho" do celular
 * do dono incrementa round.play_seq e a TV toca o trecho do estágio atual,
 * começando no ponto sorteado para aquele estágio (round.offsets). O último
 * estágio toca a prévia inteira. Se alguém aperta EU SEI! ou o dono pausa, o
 * som para e só volta quando o dono mandar tocar de novo.
 */
export function ClassicTvEngine({ round, paused, buffer, audio, serverNow, onPlayingChange }: TvEngineProps) {
  const handled = useRef<{ roundId: string; seq: number } | null>(null);
  const current = useRef<PlayHandle | null>(null);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingRef.current = onPlayingChange;
  }, [onPlayingChange]);

  // um time por vez: a música continua enquanto o time da vez responde
  const open = (round.status === "playing" || turnOpen(round)) && !paused;

  // rodada fechou (alguém apertou), pausou ou trocou de música: silêncio
  useEffect(() => {
    if (open) return;
    current.current?.stop();
    current.current = null;
    onPlayingRef.current(false);
  }, [open, round.id]);

  useEffect(() => {
    if (!buffer) return;
    if (!handled.current || handled.current.roundId !== round.id) {
      // primeira vez que vemos esta rodada: só toca se o comando acabou de chegar
      const fresh = !!round.play_at && serverNow() - Date.parse(round.play_at) < STALE_PLAY_MS;
      handled.current = { roundId: round.id, seq: fresh ? round.play_seq - 1 : round.play_seq };
    }
    if (round.play_seq <= handled.current.seq || round.played_stage < 1) return;
    handled.current.seq = round.play_seq;
    if (!open) return;

    const idx = Math.min(CLASSIC_STAGES.length - 1, round.played_stage - 1);
    const isLast = idx === CLASSIC_STAGES.length - 1;
    const len = isLast ? buffer.duration : Math.min(CLASSIC_STAGES[idx].seconds, buffer.duration);
    const offset = isLast ? 0 : Math.max(0, Math.min(round.offsets[idx] ?? 0, buffer.duration - len));

    current.current?.stop();
    onPlayingRef.current(true);
    const handle: PlayHandle = audio.play(
      buffer,
      offset,
      len,
      () => {
        if (current.current === handle) {
          current.current = null;
          onPlayingRef.current(false);
        }
      },
      isLast ? 1.5 : 0,
    );
    current.current = handle;
  }, [buffer, round.id, round.play_seq, round.played_stage, round.play_at, round.offsets, open, audio, serverNow]);

  // saiu da tela: para o som
  useEffect(
    () => () => {
      current.current?.stop();
      current.current = null;
    },
    [],
  );

  return null;
}
