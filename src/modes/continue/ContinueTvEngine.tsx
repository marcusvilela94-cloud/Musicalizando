"use client";
import { useEffect, useRef } from "react";
import type { PlayHandle } from "@/lib/audio";
import type { TvEngineProps } from "../types";
import { contClip, contOf } from "./logic";

/** Um comando "Tocar" mais velho que isso não toca de novo (ex.: a TV recarregou). */
const STALE_PLAY_MS = 4000;

/**
 * Cada "Tocar" / "Repetir" incrementa round.play_seq: a TV toca do INÍCIO da
 * 1ª linha completa da prévia e para sozinha 0,3 s antes da linha
 * escondida. Para na hora se alguém apertar EU SEI! ou o jogo pausar.
 */
export function ContinueTvEngine({ round, paused, buffer, audio, serverNow, onPlayingChange }: TvEngineProps) {
  const handled = useRef<{ roundId: string; seq: number } | null>(null);
  const current = useRef<PlayHandle | null>(null);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const c = contOf(round);
  const open = round.status === "playing" && !paused;

  useEffect(() => {
    if (open) return;
    current.current?.stop();
    current.current = null;
    onPlayingRef.current(false);
  }, [open, round.id]);

  const from = c ? contClip(c).from : 0;
  const to = c ? contClip(c).to : 0;
  useEffect(() => {
    if (!buffer || !c) return;
    if (!handled.current || handled.current.roundId !== round.id) {
      const fresh = !!round.play_at && serverNow() - Date.parse(round.play_at) < STALE_PLAY_MS;
      handled.current = { roundId: round.id, seq: fresh ? round.play_seq - 1 : round.play_seq };
    }
    if (round.play_seq <= handled.current.seq) return;
    handled.current.seq = round.play_seq;
    if (!open) return;
    current.current?.stop();
    onPlayingRef.current(true);
    const handle: PlayHandle = audio.play(buffer, from, Math.max(0.2, to - from), () => {
      if (current.current === handle) {
        current.current = null;
        onPlayingRef.current(false);
      }
    });
    current.current = handle;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toca a cada comando novo
  }, [buffer, round.id, round.play_seq, round.play_at, open, from, to, audio, serverNow]);

  useEffect(
    () => () => {
      current.current?.stop();
      current.current = null;
    },
    [],
  );
  return null;
}
