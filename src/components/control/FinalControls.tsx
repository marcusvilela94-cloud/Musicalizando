"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { RoomState } from "@/lib/types";
import { LyricsShortNotice, PrepareProgress, useMatchStarter } from "./matchStart";

/** Revanche / mudar times / configurações (TV no "Todos jogam" ou apresentador). */
export function FinalControls({ state, code, token, compact }: { state: RoomState; code: string; token: string; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const m = useMatchStarter(state, code, token);
  const busy = m.busy;
  const votes = state.players.filter((p) => p.wants_rematch).length;
  const rematch = () => m.start();
  const phase = (p: "lobby" | "config") => api.setPhase(code, token, p).catch((e) => setError(friendlyError(e)));
  return (
    <div className="flex flex-col items-center gap-3">
      {(error ?? m.error) && <p className="text-rose-300 text-lg">{error ?? m.error}</p>}
      <PrepareProgress m={m} compact={compact} />
      <LyricsShortNotice m={m} compact={compact} />
      <div className={`flex flex-wrap justify-center gap-3 ${compact ? "w-full flex-col" : ""}`}>
        <Button className={compact ? "text-2xl py-4" : "text-3xl px-10 py-5"} disabled={busy} onClick={rematch}>
          {busy ? "Sorteando…" : "🔁 Revanche (mesmos times)"}
        </Button>
        <Button variant="secondary" className="text-xl" onClick={() => phase("lobby")}>Mudar times</Button>
        <Button variant="secondary" className="text-xl" onClick={() => phase("config")}>⚙️ Configurações</Button>
      </div>
      {votes > 0 && <p className="text-white/70 text-xl">{votes} jogador{votes > 1 ? "es querem" : " quer"} jogar de novo!</p>}
    </div>
  );
}
