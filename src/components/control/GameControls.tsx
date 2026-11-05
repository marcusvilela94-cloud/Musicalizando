"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { currentAttempt, currentRound, ranking, teamById, tiebreakDecider, tiebreakLeft, tiebreakOf } from "@/lib/game";
import type { Attempt, RoomState } from "@/lib/types";
import { getMode } from "@/modes";
import { auctionOf, entryPlayed, queueEntry } from "@/modes/auction/logic";

/** Ações de quem comanda a partida (TV no "Todos jogam" ou celular do apresentador). */
export function useGameActions(state: RoomState, code: string, token: string) {
  const [error, setError] = useState<string | null>(null);
  const round = currentRound(state);
  const attempt = currentAttempt(state, round);
  const paused = state.room.paused;
  const stages = getMode(round?.mode).stages;
  const st = round?.status;
  const open = !!round && round.status === "playing" && !paused;
  const lastStage = !!round && round.stage >= stages.length;
  // Leilão: "Tocar" só na prova em fila, uma vez por time
  const auction = auctionOf(round);
  const auctionPlay = !!auction && auction.phase === "proving" && !entryPlayed(auction);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(friendlyError(e)));
  };
  const can = {
    play: auction ? open && auctionPlay : open,
    next: open && !auction && !lastStage,
    reveal: open && !auction && lastStage,
    pause: !!round && state.room.phase === "playing",
    skip: !!round && ["loading", "playing", "answering", "doubt"].includes(round.status),
    endTurn: attempt?.status === "open",
    scoreboard: st === "revealed",
    nextRound: st === "revealed" || st === "scoreboard",
  };
  const actions = {
    play: () =>
      can.play &&
      run(() =>
        auction ? api.auctionPlay(code, token, round!.id, auction.qidx) : api.play(code, token, round!.id, round!.stage, false),
      ),
    next: () => can.next && run(() => api.play(code, token, round!.id, round!.stage, true)),
    reveal: () => can.reveal && run(() => api.endRound(code, token, round!.id)),
    togglePause: () => can.pause && run(() => api.pause(code, token, !paused)),
    skip: () => can.skip && run(() => api.skipRound(code, token, round!.id)),
    endTurn: () => can.endTurn && run(() => api.endTurn(code, token, attempt!.id)),
    scoreboard: () => can.scoreboard && run(() => api.showScoreboard(code, token, round!.id)),
    nextRound: () => can.nextRound && run(() => api.nextRound(code, token, round!.round_no)),
    finish: () => {
      if (window.confirm("Encerrar a partida agora?")) run(() => api.finishMatch(code, token));
    },
  };
  return { round, attempt, paused, stages, auction, can, actions, error, setError, run };
}

export type GameActions = ReturnType<typeof useGameActions>;

/** Botões de controle. `size="tv"` = botões grandes com a dica do atalho de teclado. */
export function GameControls({ g, state, size = "phone" }: { g: GameActions; state: RoomState; size?: "tv" | "phone" }) {
  const { round, can, actions, paused, stages, auction } = g;
  if (!round) return null;
  const tv = size === "tv";
  const k = (key: string) => (tv ? <kbd className="ml-2 rounded bg-black/25 px-1.5 text-sm opacity-70">{key}</kbd> : null);
  const nextStage = stages[round.stage]; // estágio seguinte (índice = estágio atual)
  const isLastRound = state.room.round_no >= state.room.total_rounds;
  // depois da última música: empate no 1º lugar + morte súbita -> rodada extra
  const tb = tiebreakOf(round);
  const topTie = ranking(state.teams).filter((x) => x.pos === 1).length >= 2;
  const nextLabel = tb
    ? tiebreakDecider(round) || tiebreakLeft(tb).length < 2
      ? "🏁 Ver resultado"
      : "☠️ Mais uma música de desempate →"
    : isLastRound
      ? (state.room.settings.tiebreak ?? "sudden") === "sudden" && topTie
        ? "☠️ Morte súbita →"
        : "🏁 Ver resultado"
      : "Próxima música →";
  const big = tv ? "text-2xl px-6 py-3" : "text-xl py-4 flex-1 min-w-[45%]";
  const small = tv ? "" : "flex-1";

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex flex-wrap gap-2 ${tv ? "justify-center" : ""}`}>
        {round.status === "playing" && auction && (
          auction.phase === "bidding" ? (
            <p className={`font-display text-white/70 ${tv ? "text-2xl" : "text-lg text-center w-full"}`}>🔨 Leilão em andamento nos celulares…</p>
          ) : (
            <Button className={big} disabled={!can.play} onClick={actions.play}>
              ▶ Tocar{queueEntry(auction) ? ` (${teamById(state, queueEntry(auction)!.team)?.name ?? "?"}: ${queueEntry(auction)!.secs}s)` : ""}
              {k("espaço")}
            </Button>
          )
        )}
        {round.status === "playing" && !auction && (
          <>
            <Button className={big} disabled={!can.play} onClick={actions.play}>
              {round.played_stage === round.stage ? "🔁 Repetir" : "▶ Tocar"}
              {k(round.played_stage === round.stage ? "R" : "espaço")}
            </Button>
            {round.stage >= stages.length ? (
              <Button variant="danger" className={big} disabled={!can.reveal} onClick={actions.reveal}>
                🏳️ Revelar (ninguém acertou)
              </Button>
            ) : (
              <Button variant="secondary" className={big} disabled={!can.next} onClick={actions.next}>
                ⏭ Próximo trecho{nextStage ? ` (${nextStage.seconds}s · ${nextStage.points})` : ""}
                {k("→")}
              </Button>
            )}
          </>
        )}
        {can.scoreboard && (
          <Button variant="secondary" className={big} onClick={actions.scoreboard}>📊 Placar</Button>
        )}
        {can.nextRound && (
          <Button className={big} onClick={actions.nextRound}>
            {nextLabel}
            {k("→")}
          </Button>
        )}
        {can.endTurn && (
          <Button variant="secondary" className={big} onClick={actions.endTurn}>⏹ Encerrar vez (erro)</Button>
        )}
      </div>
      <div className={`flex flex-wrap gap-2 ${tv ? "justify-center" : ""}`}>
        <Button variant="secondary" className={small} disabled={!can.pause} onClick={actions.togglePause}>
          {paused ? "▶ Continuar" : "⏸ Pausar"}
          {k("P")}
        </Button>
        {can.skip && (
          <Button variant="secondary" className={small} onClick={actions.skip}>⏭ Pular música</Button>
        )}
        <Button variant="ghost" className={small} onClick={actions.finish}>Encerrar partida</Button>
      </div>
      {g.error && <p className="text-center text-rose-300">{g.error}</p>}
    </div>
  );
}

/**
 * Inverter decisão / Contestar: escolhe o que a tentativa realmente acertou
 * (o servidor refaz a pontuação).
 */
export function OverrideButtons({
  state,
  attempt,
  code,
  token,
  onError,
}: {
  state: RoomState;
  attempt: Attempt;
  code: string;
  token: string;
  onError: (m: string) => void;
}) {
  // Leilão: só uma parte vale (a da dica)
  const r = state.rounds.find((x) => x.id === attempt.round_id);
  const hint = auctionOf(r)?.hint;
  // desempate: só a música vale
  const both = !hint && !tiebreakOf(r) && state.room.settings.scoring === "artist_title";
  const art = attempt.artist_result === "ok";
  const tit = attempt.title_result === "ok";
  const set = (a: boolean, t: boolean) => api.overrideParts(code, token, attempt.id, a, t).catch((e) => onError(friendlyError(e)));
  const opts: [string, boolean, boolean][] = both
    ? [["Só artista", true, false], ["Só música", false, true], ["Os dois", true, true], ["Não valeu", false, false]]
    : hint === "genre"
      ? [["Valeu", true, false], ["Não valeu", false, false]]
      : [["Valeu", false, true], ["Não valeu", false, false]];
  return (
    <div className="flex flex-wrap gap-1">
      {opts.map(([label, a, t]) => {
        const current = (both || hint ? a === art : true) && t === tit;
        return (
          <button
            key={label}
            disabled={current}
            onClick={() => set(a, t)}
            className={`rounded-lg px-2 py-1 text-sm ${current ? "bg-yellow-300 text-violet-950" : "bg-white/15 hover:bg-white/25"}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
