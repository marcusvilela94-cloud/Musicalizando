"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { currentAttempt, currentRound } from "@/lib/game";
import type { RoomState } from "@/lib/types";

/** Controles de dono no celular (aparece só para quem escaneou o QR de dono). */
export function OwnerBar({ state, code, owner }: { state: RoomState; code: string; owner: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = currentRound(state);
  const attempt = currentAttempt(state, round);
  const phase = state.room.phase;

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(friendlyError(e)));
  };
  const btn = "rounded-xl bg-white/15 px-3 py-2 font-display text-base active:bg-white/30";

  // decisão de dúvida aparece sempre (é urgente)
  const doubt = round?.status === "doubt" && attempt?.status === "doubt";

  return (
    <div className="border-t border-white/15 bg-black/50 px-3 py-2">
      {doubt && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm">Valeu?</span>
          <button className={`${btn} flex-1 bg-emerald-500/80`} onClick={() => run(() => api.judge(code, owner, attempt!.id, true))}>👍 Valeu</button>
          <button className={`${btn} flex-1 bg-rose-500/80`} onClick={() => run(() => api.judge(code, owner, attempt!.id, false))}>👎 Não valeu</button>
        </div>
      )}
      <div className="flex items-center gap-2 overflow-x-auto">
        <button className={`${btn} shrink-0`} onClick={() => setOpen((v) => !v)}>👑 {open ? "▾" : "▸"}</button>
        {open && phase === "playing" && round && (
          <>
            <button className={btn} onClick={() => run(() => api.pause(code, owner, !state.room.paused))}>
              {state.room.paused ? "▶" : "⏸"}
            </button>
            {["loading", "playing", "answering", "doubt"].includes(round.status) && (
              <button className={btn} onClick={() => run(() => api.skipRound(code, owner, round.id))}>⏭ Pular</button>
            )}
            {attempt?.status === "open" && (
              <button className={btn} onClick={() => run(() => api.endTurn(code, owner, attempt.id))}>⏹ Encerrar vez</button>
            )}
            {(round.status === "revealed" || round.status === "scoreboard") && (
              <button className={btn} onClick={() => run(() => api.nextRound(code, owner, round.round_no))}>Próxima →</button>
            )}
          </>
        )}
        {open && phase === "lobby" && state.room.settings.teamMode === "teams" && (
          <button className={btn} onClick={() => run(() => api.shuffleTeams(code, owner))}>🎲 Sortear times</button>
        )}
        {open && phase !== "playing" && <span className="text-sm text-white/60">Comece a partida na tela principal.</span>}
      </div>
      {error && <p className="mt-1 text-sm text-rose-300">{error}</p>}
    </div>
  );
}
