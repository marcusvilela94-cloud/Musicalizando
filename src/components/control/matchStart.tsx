"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { PickedTrack, RoomState } from "@/lib/types";

/** Músicas a mais sorteadas para a morte súbita (ficam de reserva no servidor). */
const TIEBREAK_RESERVE = 5;

type Prepared = { tracks: PickedTrack[]; rounds: number; warnings: string[] };

/** Letras: "all" = só modo letra (toda música precisa de letra); "some" = misturado. */
function lyricsNeed(state: RoomState) {
  const s = state.room.settings;
  const pool = s.modeSelection === "random" && s.modePool.length > 0 ? s.modePool : [s.mode];
  return !pool.includes("lyrics") ? "none" : pool.every((m) => m === "lyrics") ? "all" : "some";
}

/** Sorteia as músicas (rota do Next -> Deezer + letras). */
async function prepareMatch(state: RoomState): Promise<Prepared> {
  const { sources, rounds, tiebreak, versionFilter } = state.room.settings;
  const extra = (tiebreak ?? "sudden") === "sudden" ? TIEBREAK_RESERVE : 0;
  const need = lyricsNeed(state);
  const { tracks, warnings: all } = await deezer.build(sources, rounds + extra, versionFilter !== false, need);
  // o aviso de "poucas músicas" só interessa se faltou para as rodadas (não para as reservas)
  const warnings = all.filter((w) => !w.startsWith("Só encontrei") || tracks.length < rounds);
  return { tracks, rounds: Math.min(rounds, tracks.length), warnings };
}

/**
 * Começar / revanche. No modo "Só pela letra", se não houver letra para todas
 * as músicas, pergunta antes: "Só encontramos X músicas com letra…".
 */
export function useMatchStarter(state: RoomState, code: string, token: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<Prepared | null>(null);

  const begin = async (p: Prepared) => {
    await api.startMatch(code, token, p.tracks, p.rounds);
    if (p.warnings.length) setError(p.warnings.join(" "));
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      const p = await prepareMatch(state);
      if (lyricsNeed(state) === "all" && p.tracks.length < state.room.settings.rounds) setShort(p);
      else await begin(p);
    });
  const confirm = () => short && run(async () => {
    const p = short;
    setShort(null);
    await begin(p);
  });
  const backToConfig = () => {
    setShort(null);
    api.setPhase(code, token, "config").catch((e) => setError(friendlyError(e)));
  };
  return { busy, error, short, start, confirm, backToConfig, dismiss: () => setShort(null) };
}

export type MatchStarter = ReturnType<typeof useMatchStarter>;

/** Aviso antes de começar quando faltou letra. */
export function LyricsShortNotice({ m, compact }: { m: MatchStarter; compact?: boolean }) {
  if (!m.short) return null;
  const n = m.short.tracks.length;
  return (
    <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-yellow-300 bg-black/40 p-5 text-center">
      <p className={`font-display ${compact ? "text-xl" : "text-3xl"}`}>
        📝 Só encontramos <b className="text-yellow-300">{n}</b> música{n > 1 ? "s" : ""} com letra nessas playlists.
      </p>
      <div className={`flex flex-wrap justify-center gap-3 ${compact ? "w-full flex-col" : ""}`}>
        <Button className={compact ? "text-xl py-3" : "text-2xl px-8 py-3"} disabled={m.busy} onClick={m.confirm}>
          Jogar com {n}
        </Button>
        <Button variant="secondary" className="text-xl" onClick={m.backToConfig}>
          Trocar as playlists
        </Button>
      </div>
    </div>
  );
}
