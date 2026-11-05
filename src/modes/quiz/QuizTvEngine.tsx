"use client";
import { useEffect, useRef } from "react";
import type { PlayHandle } from "@/lib/audio";
import { turnOpen } from "@/lib/game";
import type { TvEngineProps } from "../types";
import { quizOf } from "./logic";

/** Um comando "Tocar" mais velho que isso não toca de novo (ex.: a TV recarregou). */
const STALE_PLAY_MS = 4000;

/**
 * Quizzes: a prévia inteira toca ao fundo enquanto a pergunta está na tela.
 *  - Quiz aberto: "Tocar"/"Repetir" do dono (como no clássico); para quando alguém aperta EU SEI!.
 *  - Alternativas: toca sozinha quando a rodada abre (play_seq = 1).
 *  - Pergunta da capa (play = false): silêncio (tocar entregaria a resposta).
 */
export function QuizTvEngine({ round, paused, buffer, audio, serverNow, onPlayingChange }: TvEngineProps) {
  const handled = useRef<{ roundId: string; seq: number } | null>(null);
  const current = useRef<PlayHandle | null>(null);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const silent = quizOf(round)?.play === false;
  // um time por vez: a música continua enquanto o time da vez responde
  const open = (round.status === "playing" || turnOpen(round)) && !paused && !silent;

  useEffect(() => {
    if (open) return;
    current.current?.stop();
    current.current = null;
    onPlayingRef.current(false);
  }, [open, round.id]);

  useEffect(() => {
    if (!buffer) return;
    if (!handled.current || handled.current.roundId !== round.id) {
      const fresh = !!round.play_at && serverNow() - Date.parse(round.play_at) < STALE_PLAY_MS;
      handled.current = { roundId: round.id, seq: fresh ? round.play_seq - 1 : round.play_seq };
    }
    if (round.play_seq <= handled.current.seq) return;
    handled.current.seq = round.play_seq;
    if (!open) return;
    current.current?.stop();
    onPlayingRef.current(true);
    const handle: PlayHandle = audio.play(
      buffer,
      0,
      buffer.duration,
      () => {
        if (current.current === handle) {
          current.current = null;
          onPlayingRef.current(false);
        }
      },
      1.5,
    );
    current.current = handle;
  }, [buffer, round.id, round.play_seq, round.play_at, open, audio, serverNow]);

  useEffect(
    () => () => {
      current.current?.stop();
      current.current = null;
    },
    [],
  );
  return null;
}
