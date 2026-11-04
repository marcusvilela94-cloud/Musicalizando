"use client";
import { Equalizer, Spinner } from "@/components/ui";
import { textOn } from "@/lib/colors";
import { isHostStyle, teamById } from "@/lib/game";
import type { AuctionState, RoomState, Round } from "@/lib/types";
import type { PresenterRoundViewProps, TvRoundViewProps } from "../types";
import { auctionOf, entryPlayed, lastAction, listening, queueEntry } from "./logic";
import { BidBoard, HintCard, QueueRow } from "./parts";

const secsLeft = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : null);

/** TV durante a rodada de leilão: dica, lances ao vivo e prova em fila. */
export function AuctionTvView({ state, round, attempt, now, clipPlaying }: TvRoundViewProps) {
  const a = auctionOf(round);
  if (!a) return <Spinner label="Preparando o leilão…" />;
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <HintCard a={a} />
      {a.phase === "bidding" ? (
        <BiddingTv state={state} a={a} now={now} />
      ) : (
        <ProvingTv state={state} round={round} a={a} now={now} clipPlaying={clipPlaying} deadline={attempt?.status === "open" ? attempt.deadline : null} />
      )}
    </div>
  );
}

function BiddingTv({ state, a, now }: { state: RoomState; a: AuctionState; now: number }) {
  const startIn = secsLeft(a.starts_at, now) ?? 0;
  if (startIn > 0) {
    const opener = teamById(state, a.order[0]);
    return (
      <div className="flex flex-col items-center gap-3 font-display">
        <p className="text-4xl text-white/80">Quem consegue com menos segundos?</p>
        <p className="text-8xl font-bold tabular-nums text-yellow-300">{startIn}</p>
        <p className="text-3xl">O leilão começa em 20s{opener ? <> · abre: <b>{opener.name}</b></> : null}</p>
      </div>
    );
  }
  const turn = teamById(state, a.turn);
  const left = secsLeft(a.turn_deadline, now);
  const last = lastAction(a);
  const lastTeam = last ? teamById(state, last.team) : undefined;
  const fresh = last && now - Date.parse(last.at) < 2500;
  const lowTeam = teamById(state, a.low_team);
  return (
    <div className="relative flex w-full flex-col items-center gap-5">
      <p className="font-display text-4xl">
        Menor lance: <b className="text-6xl text-yellow-300 tabular-nums">{a.low}s</b>
        {lowTeam ? <span className="text-white/80"> · {lowTeam.name}</span> : <span className="text-white/60"> · ninguém deu lance</span>}
      </p>
      <BidBoard state={state} a={a} />
      {turn && (
        <div className="flex items-center gap-6 rounded-[2rem] px-8 py-4" style={{ background: turn.color, color: textOn(turn.color) }}>
          <span className="font-display text-4xl">Vez de <b>{turn.name}</b>: lance menor ou “Pode tocar!”</span>
          <span className={`font-display text-7xl font-bold tabular-nums ${left !== null && left <= 5 ? "animate-pulse" : ""}`}>{left}</span>
        </div>
      )}
      {fresh && lastTeam && (
        <div key={`${last.at}`} className="pointer-events-none absolute inset-x-0 -top-6 flex justify-center">
          <div className="npl-pop rounded-[2rem] px-12 py-6 font-display text-6xl font-bold shadow-2xl" style={{ background: lastTeam.color, color: textOn(lastTeam.color) }}>
            {lastTeam.name}: {last.secs !== null ? `${last.secs}s! 🔨` : "Pode tocar!"}
          </div>
        </div>
      )}
    </div>
  );
}

function ProvingTv({
  state,
  round,
  a,
  now,
  clipPlaying,
  deadline,
}: {
  state: RoomState;
  round: Round;
  a: AuctionState;
  now: number;
  clipPlaying: boolean;
  deadline: string | null;
}) {
  const e = queueEntry(a);
  const team = teamById(state, e?.team);
  if (!e || !team) return null;
  const host = isHostStyle(state);
  const spoken = host && state.room.settings.answerMode === "spoken";
  const played = entryPlayed(a);
  const hearing = round.status === "answering" && (clipPlaying || listening(round, a, now));
  const left = secsLeft(deadline, now);
  return (
    <div className="flex w-full flex-col items-center gap-5">
      <QueueRow state={state} a={a} />
      <div className="npl-pop flex w-full max-w-4xl flex-col items-center gap-3 rounded-[2.5rem] p-8 text-center" style={{ background: team.color, color: textOn(team.color) }}>
        <p className="font-display text-8xl font-bold">{team.name}: {e.secs}s!</p>
        {round.status === "playing" && !played && (
          <p className="font-display text-4xl">{host ? "Aguardando o apresentador tocar…" : "Aperte ▶ Tocar"}</p>
        )}
        {hearing && (
          <div className="flex flex-col items-center gap-2">
            <Equalizer className="h-20 [&>span]:w-5" />
            <p className="font-display text-3xl">Ouvindo {e.secs}s…</p>
          </div>
        )}
        {round.status === "answering" && !hearing && (
          <>
            <p className="font-display text-4xl">{spoken ? "Respondendo…" : "digitando a resposta…"}</p>
            {left !== null ? (
              <p className={`font-display text-9xl font-bold tabular-nums ${left <= 5 ? "animate-pulse" : ""}`}>{left}</p>
            ) : (
              <p className="font-display text-3xl opacity-80">sem limite de tempo</p>
            )}
          </>
        )}
        {round.status === "doubt" && <p className="font-display text-4xl">Aguardando o apresentador decidir…</p>}
      </div>
    </div>
  );
}

/** Painel compacto para o celular do apresentador. */
export function AuctionPresenterView({ state, round, now }: PresenterRoundViewProps) {
  const a = auctionOf(round);
  if (!a) return null;
  const turn = teamById(state, a.turn);
  const e = queueEntry(a);
  const eTeam = teamById(state, e?.team);
  const startIn = secsLeft(a.starts_at, now) ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <HintCard a={a} size="phone" />
      {a.phase === "bidding" ? (
        <>
          <p className="text-center font-display text-lg">
            {startIn > 0 ? (
              <>Lances começam em <b>{startIn}s</b></>
            ) : (
              <>Menor lance <b className="text-yellow-300">{a.low}s</b>{turn ? <> · vez de <b>{turn.name}</b> ({secsLeft(a.turn_deadline, now)}s)</> : null}</>
            )}
          </p>
          <BidBoard state={state} a={a} size="phone" />
        </>
      ) : (
        <>
          <QueueRow state={state} a={a} size="phone" />
          {eTeam && e && (
            <p className="rounded-xl px-3 py-2 text-center font-display text-2xl font-bold" style={{ background: eTeam.color, color: textOn(eTeam.color) }}>
              {eTeam.name}: {e.secs}s!{round.status === "playing" && !entryPlayed(a) ? " — toque em ▶ Tocar" : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}
