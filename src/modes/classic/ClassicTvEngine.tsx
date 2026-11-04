"use client";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { PlayHandle } from "@/lib/audio";
import type { TvEngineProps } from "../types";
import { CLASSIC_STAGES } from "./stages";

const GAP_MS = 1500; // pausa curta entre os trechos

/**
 * Toca o trecho do estágio atual (sempre do início da prévia) e, ao fim do
 * trecho + pausa, pede ao servidor o próximo estágio. Se alguém aperta o
 * botão, o som para; se o time erra, continua exatamente de onde parou.
 */
export function ClassicTvEngine({ code, owner, round, paused, attemptCount, buffer, audio }: TvEngineProps) {
  const pos = useRef({ roundId: "", stage: 0, offset: 0 });

  useEffect(() => {
    if (!buffer || round.status !== "playing" || paused || !audio.unlocked) return;
    const st = pos.current;
    if (st.roundId !== round.id || st.stage !== round.stage) {
      st.roundId = round.id;
      st.stage = round.stage;
      st.offset = 0;
    }
    const stage = CLASSIC_STAGES[Math.max(0, Math.min(CLASSIC_STAGES.length - 1, round.stage - 1))];
    const dur = Math.min(stage.seconds, buffer.duration);
    let handle: PlayHandle | null = null;
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const advance = async (tries = 3) => {
      try {
        await api.advanceStage(code, owner, round.id, round.stage);
      } catch {
        if (!cancelled && tries > 1) gapTimer = setTimeout(() => advance(tries - 1), 1000);
      }
    };
    const startGap = () => {
      gapTimer = setTimeout(() => !cancelled && advance(), GAP_MS);
    };

    if (st.offset < dur - 0.02) {
      const from = st.offset;
      handle = audio.play(buffer, from, dur - from, () => {
        st.offset = dur;
        handle = null;
        if (!cancelled) startGap();
      });
      const h = handle;
      return () => {
        cancelled = true;
        clearTimeout(gapTimer);
        if (handle === h) st.offset = Math.min(dur, from + h.stop());
      };
    }
    startGap();
    return () => {
      cancelled = true;
      clearTimeout(gapTimer);
    };
  }, [buffer, round.id, round.stage, round.status, paused, attemptCount, code, owner, audio]);

  return null;
}
