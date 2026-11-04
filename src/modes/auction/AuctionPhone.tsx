"use client";
import { useEffect, useRef, useState } from "react";
import { AnswerForm, OtherAnswering, SpeakNow, vibrate } from "@/components/phone/answer";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { currentAttempt, teamById } from "@/lib/game";
import type { AuctionState, RoomState, Round } from "@/lib/types";
import type { PhoneCtx } from "@/components/phone/PhoneApp";
import type { PhoneRoundViewProps } from "../types";
import { auctionGoal, auctionOf, listening, queueEntry } from "./logic";
import { BidBoard, HintCard } from "./parts";

const REASONS: Record<string, string> = {
  not_your_turn: "Não é a vez do seu time.",
  bad_bid: "O lance tem que ser menor que o atual.",
  not_started: "O leilão ainda não começou.",
  closed: "O leilão já fechou.",
  paused: "Jogo pausado.",
  not_yet: "Você joga a partir da próxima música.",
  no_team: "Escolha um time primeiro.",
};

const secsLeft = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : 0);

/** Celular do jogador na rodada de leilão. */
export function AuctionPhone({ state, ctx, round, now, onFeedback }: PhoneRoundViewProps) {
  const a = auctionOf(round);
  const team = ctx.team!;

  // vibra quando chega a vez do time (lance ou prova)
  const myMoment =
    a?.phase === "bidding" && a.turn === team.id
      ? `bid:${a.log.length}`
      : a?.phase === "proving" && queueEntry(a)?.team === team.id
        ? `prove:${a.qidx}`
        : null;
  const buzzed = useRef<string | null>(null);
  useEffect(() => {
    if (!myMoment || buzzed.current === myMoment) return;
    buzzed.current = myMoment;
    vibrate([120, 60, 120]);
  }, [myMoment]);

  // turno vencido: pede ao servidor para conferir (conta como "Pode tocar!")
  const turnDeadline = a?.phase === "bidding" ? a.turn_deadline : null;
  const paused = state.room.paused;
  useEffect(() => {
    if (!turnDeadline || paused) return;
    const ms = Date.parse(turnDeadline) + 1200 - ctx.serverNow();
    const t = setTimeout(() => api.tick(ctx.code).catch(() => {}), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [turnDeadline, paused, ctx]);

  if (!a) return <Spinner label="Preparando o leilão…" />;
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4">
      <HintCard a={a} size="phone" />
      {a.phase === "bidding" ? (
        <Bidding state={state} ctx={ctx} round={round} a={a} now={now} onFeedback={onFeedback} />
      ) : (
        <Proving state={state} ctx={ctx} round={round} a={a} now={now} />
      )}
    </div>
  );
}

function Bidding({ state, ctx, round, a, now, onFeedback }: { state: RoomState; ctx: PhoneCtx; round: Round; a: AuctionState; now: number; onFeedback: (m: string) => void }) {
  const team = ctx.team!;
  const startIn = secsLeft(a.starts_at, now);
  if (startIn > 0) {
    return (
      <div className="flex flex-col items-center gap-2 font-display">
        <p className="text-2xl">O leilão começa em</p>
        <p className="text-7xl font-bold tabular-nums text-yellow-300">{startIn}</p>
        <p className="text-white/70">Leiam a dica! Começa em 20s.</p>
      </div>
    );
  }
  const left = secsLeft(a.turn_deadline, now);
  const turn = teamById(state, a.turn);
  if (a.turn === team.id) return <BidControls key={`${a.low}:${a.log.length}`} ctx={ctx} round={round} a={a} left={left} onFeedback={onFeedback} />;
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {turn && (
        <div className="flex w-full items-center justify-between rounded-2xl px-4 py-3" style={{ background: turn.color, color: textOn(turn.color) }}>
          <span className="font-display text-xl">Vez de <b>{turn.name}</b></span>
          <span className="font-display text-4xl font-bold tabular-nums">{left}</span>
        </div>
      )}
      <p className="font-display text-xl">
        {a.low_team === team.id ? <>👑 Seu time tem o menor lance: <b>{a.low}s</b></> : <>Menor lance: <b className="text-yellow-300">{a.low}s</b></>}
      </p>
      <BidBoard state={state} a={a} size="phone" />
    </div>
  );
}

/** Vez do time: lance menor (passos de 1 s) ou "Pode tocar!". Vale o primeiro envio do time. */
function BidControls({ ctx, round, a, left, onFeedback }: { ctx: PhoneCtx; round: Round; a: AuctionState; left: number; onFeedback: (m: string) => void }) {
  const team = ctx.team!;
  const max = a.low - 1;
  const [secs, setSecs] = useState(Math.max(1, max));
  const [busy, setBusy] = useState(false);
  const send = async (value: number | null) => {
    if (busy) return;
    setBusy(true);
    vibrate(40);
    try {
      const r = await api.auctionBid(ctx.code, ctx.token, round.id, value);
      if (!r.ok) onFeedback(REASONS[r.reason ?? ""] ?? "Não deu.");
    } catch (e) {
      onFeedback(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const step = "h-16 w-16 rounded-2xl bg-black/25 font-display text-4xl font-bold disabled:opacity-30";
  return (
    <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl p-4" style={{ background: team.color, color: textOn(team.color) }}>
      <div className="flex w-full items-center justify-between">
        <span className="font-display text-2xl font-bold">Sua vez!</span>
        <span className={`font-display text-4xl font-bold tabular-nums ${left <= 5 ? "animate-pulse" : ""}`}>{left}</span>
      </div>
      <p className="font-display text-lg">
        Menor lance agora: <b>{a.low}s</b>. Consegue acertar {auctionGoal(a)} com menos?
      </p>
      {max >= 1 && (
        <>
          <div className="flex items-center gap-4">
            <button className={step} disabled={busy || secs <= 1} onClick={() => setSecs((s) => Math.max(1, s - 1))}>−</button>
            <span className="w-28 text-center font-display text-6xl font-bold tabular-nums">{secs}s</span>
            <button className={step} disabled={busy || secs >= max} onClick={() => setSecs((s) => Math.min(max, s + 1))}>+</button>
          </div>
          <Button className="w-full text-2xl py-4" disabled={busy} onClick={() => send(secs)}>🔨 Dar lance ({secs}s)</Button>
        </>
      )}
      <Button variant="secondary" className="w-full text-2xl py-4 !bg-black/25 !text-white" disabled={busy} onClick={() => send(null)}>
        ▶ Pode tocar!
      </Button>
    </div>
  );
}

function Proving({ state, ctx, round, a, now }: { state: RoomState; ctx: PhoneCtx; round: Round; a: AuctionState; now: number }) {
  const team = ctx.team!;
  const e = queueEntry(a);
  const cur = teamById(state, e?.team);
  const attempt = currentAttempt(state, round);
  const host = state.room.settings.roomStyle === "host";
  const spoken = host && state.room.settings.answerMode === "spoken";
  const hearing = round.status === "answering" && listening(round, a, now);
  const myIdx = a.queue.findIndex((q) => q.team === team.id);
  const mine = e?.team === team.id;
  if (!e || !cur) return null;

  if (mine) {
    if (round.status === "answering" && attempt && !hearing) {
      return spoken ? (
        <SpeakNow state={state} ctx={ctx} attempt={attempt} now={now} />
      ) : (
        <AnswerForm key={attempt.id} state={state} ctx={ctx} round={round} attempt={attempt} now={now} who="Vez do seu time!" />
      );
    }
    const playEnd = round.play_at ? Date.parse(round.play_at) + e.secs * 1000 : 0;
    return (
      <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl p-6" style={{ background: team.color, color: textOn(team.color) }}>
        <p className="font-display text-3xl font-bold">Vez do seu time: {e.secs}s!</p>
        {hearing ? (
          <>
            <p className="font-display text-5xl">🎧 Ouçam!</p>
            <p className="font-display text-6xl font-bold tabular-nums">{Math.max(0, Math.ceil((playEnd - now) / 1000))}</p>
          </>
        ) : round.status === "doubt" ? (
          <p className="font-display text-2xl">O apresentador está decidindo…</p>
        ) : (
          <p className="font-display text-2xl">{host ? "O apresentador vai tocar o trecho." : "Toquem em ▶ Tocar na TV quando estiverem prontos."}</p>
        )}
        <p className="opacity-80">Depois do trecho, vocês têm o tempo de resposta para acertar {auctionGoal(a)}.</p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {round.status === "answering" && attempt && !hearing ? (
        <OtherAnswering state={state} ctx={ctx} attempt={attempt} now={now} spoken={spoken} />
      ) : (
        <div className="flex w-full flex-col items-center gap-2 rounded-3xl p-6" style={{ background: cur.color, color: textOn(cur.color) }}>
          <p className="font-display text-3xl font-bold">{cur.name}: {e.secs}s!</p>
          <p className="font-display text-xl">{hearing ? "🎧 ouvindo o trecho…" : round.status === "doubt" ? "o apresentador está decidindo…" : "vai tentar agora"}</p>
        </div>
      )}
      <p className="font-display text-lg text-white/80">
        {myIdx < 0
          ? ""
          : myIdx < a.qidx
            ? "Seu time já tentou nesta música."
            : `Seu time é o ${myIdx + 1}º da fila (${a.queue[myIdx].secs}s).`}
      </p>
    </div>
  );
}

