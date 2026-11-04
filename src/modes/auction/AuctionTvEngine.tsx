"use client";
import { useEffect, useRef } from "react";
import type { PlayHandle } from "@/lib/audio";
import type { TvEngineProps } from "../types";
import { auctionOf, queueEntry } from "./logic";

/** Um comando "Tocar" mais velho que isso não toca de novo (ex.: a TV recarregou). */
const STALE_PLAY_MS = 4000;

/**
 * Prova em fila: cada "Tocar" incrementa round.play_seq e a TV toca
 * exatamente o lance do time da vez (Y segundos) a partir do início da
 * prévia, uma vez só. Para na hora se o time responder, se a vez passar
 * para o próximo da fila ou se o jogo pausar.
 */
export function AuctionTvEngine({ round, paused, buffer, audio, serverNow, onPlayingChange }: TvEngineProps) {
  const handled = useRef<{ roundId: string; seq: number } | null>(null);
  const current = useRef<PlayHandle | null>(null);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const a = auctionOf(round);
  const entry = queueEntry(a);
  const qidx = a?.qidx ?? -1;
  const secs = entry?.secs ?? 0;
  // o trecho só vale enquanto a vez (criada no "Tocar") está aberta
  const open = round.status === "answering" && !paused && !!a && a.played === qidx;

  useEffect(() => {
    if (open) return;
    current.current?.stop();
    current.current = null;
    onPlayingRef.current(false);
  }, [open, round.id, qidx]);

  useEffect(() => {
    if (!buffer) return;
    if (!handled.current || handled.current.roundId !== round.id) {
      const fresh = !!round.play_at && serverNow() - Date.parse(round.play_at) < STALE_PLAY_MS;
      handled.current = { roundId: round.id, seq: fresh ? round.play_seq - 1 : round.play_seq };
    }
    if (round.play_seq <= handled.current.seq) return;
    handled.current.seq = round.play_seq;
    if (!open || secs <= 0) return;

    current.current?.stop();
    onPlayingRef.current(true);
    const handle: PlayHandle = audio.play(buffer, 0, Math.min(secs, buffer.duration), () => {
      if (current.current === handle) {
        current.current = null;
        onPlayingRef.current(false);
      }
    });
    current.current = handle;
  }, [buffer, round.id, round.play_seq, round.play_at, open, secs, audio, serverNow]);

  useEffect(
    () => () => {
      current.current?.stop();
      current.current = null;
    },
    [],
  );

  return null;
}
