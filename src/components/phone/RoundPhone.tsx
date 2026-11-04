"use client";
import { useEffect, useRef, useState } from "react";
import { Spinner, TeamChip } from "@/components/ui";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import {
  attemptParts,
  currentAttempt,
  formatSeconds,
  lockInfo,
  artistCredits,
  ranking,
  recentDecision,
  roundDelta,
  teamById,
} from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import { AnswerForm, FoundLine, OtherAnswering, SpeakNow, vibrate } from "./answer";
import type { PhoneCtx } from "./PhoneApp";

const REASONS: Record<string, string> = {
  locked: "Seu time está bloqueado.",
  paused: "Jogo pausado.",
  closed: "Essa música já fechou.",
  not_yet: "Você joga a partir da próxima música.",
  own_turn: "Seu time já está respondendo!",
  no_team: "Escolha um time primeiro.",
};

export function RoundPhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round | null }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  const attempt = currentAttempt(state, round);
  // vibra o celular do time que ganhou a vez
  const myTurnId = attempt && attempt.status === "open" && attempt.team_id === ctx.team?.id ? attempt.id : null;
  const vibrated = useRef<string | null>(null);
  useEffect(() => {
    if (!myTurnId || vibrated.current === myTurnId) return;
    vibrated.current = myTurnId;
    vibrate([120, 60, 120]);
  }, [myTurnId]);

  const now = useNow(ctx.serverNow, 250);

  if (!round || round.status === "loading") {
    return (
      <>
        <p className="font-display text-xl text-white/70">Rodada {state.room.round_no} de {state.room.total_rounds}</p>
        <Spinner label="Preparando a próxima música… 🎧" />
      </>
    );
  }
  const team = ctx.team!;
  const notYet = ctx.me.active_from_round > round.round_no;
  const spoken = state.room.settings.roomStyle === "host" && state.room.settings.answerMode === "spoken";
  const mine = recentDecision(state, round, now);
  const myDecision = mine && mine.team_id === team.id ? mine : undefined;

  const ModeView = getMode(round.mode).PhoneRoundView;
  const inPlay = round.status === "playing" || round.status === "answering" || round.status === "doubt";

  let body: React.ReactNode = null;
  if (ModeView && inPlay) {
    body = notYet ? (
      <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>
    ) : (
      <ModeView state={state} ctx={ctx} round={round} now={now} onFeedback={setFeedback} />
    );
  } else if (round.status === "playing") {
    if (notYet) body = <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>;
    else body = <BuzzButton state={state} ctx={ctx} round={round} now={now} onFeedback={setFeedback} />;
  } else if (round.status === "answering" && attempt) {
    if (attempt.team_id !== team.id) body = <OtherAnswering state={state} ctx={ctx} attempt={attempt} now={now} spoken={spoken} />;
    else if (spoken) body = <SpeakNow state={state} ctx={ctx} attempt={attempt} now={now} />;
    else body = <AnswerForm key={attempt.id} state={state} ctx={ctx} round={round} attempt={attempt} now={now} />;
  } else if (round.status === "doubt" && attempt) {
    const t = teamById(state, attempt.team_id);
    body = (
      <>
        <p className="font-display text-4xl">🤔</p>
        <p className="font-display text-3xl">Valeu ou não valeu?</p>
        <p className="text-white/70 text-lg">O apresentador está decidindo a resposta {attempt.team_id === team.id ? "do seu time" : `de ${t?.name}`}.</p>
      </>
    );
  } else if (round.status === "revealed") {
    body = <RevealPhone state={state} ctx={ctx} round={round} />;
  } else if (round.status === "scoreboard") {
    body = <ScorePhone state={state} ctx={ctx} round={round} />;
  }

  return (
    <>
      {body}
      {myDecision && round.status === "playing" && <DecisionToast attempt={myDecision} />}
      {feedback && <p className="npl-pop absolute bottom-6 left-4 right-4 rounded-2xl bg-black/80 px-4 py-3 text-lg">{feedback}</p>}
    </>
  );
}

function DecisionToast({ attempt }: { attempt: Attempt }) {
  const ok = attempt.status === "correct";
  return (
    <div className={`npl-pop absolute left-4 right-4 top-4 rounded-2xl px-4 py-3 font-display text-2xl ${ok ? "bg-emerald-500" : "bg-rose-600"}`}>
      {ok ? `✓ Acertaram ${attemptParts(attempt)}!` : attempt.status === "timeout" ? "⏱ Tempo esgotado" : "✗ Errou!"}{" "}
      {attempt.points ? (attempt.points > 0 ? `+${attempt.points}` : attempt.points) : ""}
    </div>
  );
}

function BuzzButton({ state, ctx, round, now, onFeedback }: { state: RoomState; ctx: PhoneCtx; round: Round; now: number; onFeedback: (m: string) => void }) {
  const team = ctx.team!;
  const busy = useRef(false);
  const [pressed, setPressed] = useState(false);
  const lock = lockInfo(round, team.id, now);
  const locked = !!lock;
  const bg = locked ? "#64748b" : team.color;

  const press = async () => {
    if (busy.current || locked) return;
    busy.current = true;
    setPressed(true);
    vibrate(40);
    try {
      const r = await api.buzz(ctx.code, ctx.token, round.id);
      if (!r.ok) {
        if (r.reason === "taken") {
          const t = teamById(state, r.team_id);
          onFeedback(`${t?.name ?? "Outro time"} foi mais rápido — você apertou ${formatSeconds(r.behind_ms ?? 0)}s depois.`);
        } else onFeedback(REASONS[r.reason ?? ""] ?? "Não deu.");
      }
    } catch (e) {
      onFeedback(friendlyError(e));
    } finally {
      busy.current = false;
      setPressed(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <FoundLine state={state} round={round} />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          press();
        }}
        disabled={locked}
        className={`aspect-square w-[min(80vw,55vh)] rounded-full font-display font-bold shadow-[0_14px_0_rgba(0,0,0,0.35)] transition active:translate-y-3 active:shadow-[0_2px_0_rgba(0,0,0,0.35)] ${
          locked ? "text-4xl" : "npl-pulse text-6xl"
        } ${pressed ? "translate-y-3 shadow-[0_2px_0_rgba(0,0,0,0.35)]" : ""}`}
        style={{ background: bg, color: textOn(bg) }}
      >
        {locked ? (
          <>
            🔒
            <br />
            <span className="tabular-nums">{lock!.waiting ? "Aguardando a música" : `Liberado em ${Math.ceil(lock!.ms / 1000)}s`}</span>
          </>
        ) : (
          "EU SEI!"
        )}
      </button>
      <p className="font-display text-xl text-white/80">
        {locked ? (lock!.waiting ? "Seu time errou — a contagem começa quando a música voltar" : "Seu time errou — espere a contagem") : `Rodada ${round.round_no} de ${state.room.total_rounds}`}
      </p>
    </div>
  );
}

function RevealPhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round }) {
  const team = ctx.team!;
  const myAttempts = state.attempts.filter((a) => a.round_id === round.id && a.team_id === team.id && a.kind === "turn");
  const won = round.artist_team_id === team.id || round.title_team_id === team.id;
  const erred = myAttempts.some((a) => a.status === "wrong" || a.status === "timeout");
  const winner = teamById(state, round.title_team_id ?? round.artist_team_id);
  const delta = roundDelta(state, round).get(team.id) ?? 0;
  return (
    <>
      {won ? (
        <p className="npl-pop font-display text-6xl font-bold text-emerald-300">🎉 Acertou!</p>
      ) : erred ? (
        <p className="npl-pop font-display text-6xl font-bold text-rose-300">❌ Errou</p>
      ) : winner ? (
        <p className="font-display text-3xl"><TeamChip team={winner} /> acertou</p>
      ) : (
        <p className="font-display text-3xl">{round.skipped ? "Música pulada" : "Ninguém acertou 😅"}</p>
      )}
      {delta !== 0 && <p className="font-display text-5xl font-bold">{delta > 0 ? `+${delta}` : delta} pts</p>}
      {round.reveal && (
        <div className="flex items-center gap-3 rounded-2xl bg-white/10 p-3 text-left">
          {round.reveal.cover && (
            // eslint-disable-next-line @next/next/no-img-element -- capa do Deezer
            <img src={round.reveal.cover} alt="" className="h-16 w-16 rounded-xl" />
          )}
          <div>
            <p className="font-display text-xl font-semibold">{round.reveal.title}</p>
            <p className="text-white/70">{artistCredits(round.reveal)}</p>
          </div>
        </div>
      )}
      <p className="text-white/70">Seu time: <b className="text-white">{team.score} pts</b></p>
    </>
  );
}

function ScorePhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round }) {
  const mine = ranking(state.teams).find((r) => r.team.id === ctx.team?.id);
  const delta = roundDelta(state, round).get(ctx.team?.id ?? "") ?? 0;
  if (!mine) return null;
  return (
    <div className="npl-pop w-full max-w-sm rounded-3xl p-6" style={{ background: mine.team.color, color: textOn(mine.team.color) }}>
      <p className="font-display text-xl">Seu time está em</p>
      <p className="font-display text-8xl font-bold">{mine.pos}º</p>
      <p className="font-display text-3xl font-bold">{mine.team.score} pts</p>
      {delta !== 0 && <p className="font-display text-xl opacity-80">nesta rodada: {delta > 0 ? `+${delta}` : delta}</p>}
      <p className="mt-2 opacity-80">de {state.teams.length} times</p>
    </div>
  );
}
