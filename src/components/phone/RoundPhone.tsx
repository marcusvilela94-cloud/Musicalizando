"use client";
import { useEffect, useRef, useState } from "react";
import { RoundIntro, TurnHandoff } from "@/components/RoundIntro";
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
  stagePoints,
  teamById,
  tiebreakDecider,
  tiebreakLeft,
  tiebreakOf,
  turnClaims,
  turnOf,
  turnWaiting,
} from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import { contCanAnswer } from "@/modes/continue/logic";
import { quizOf } from "@/modes/quiz/logic";
import { QuizAnswerLine, QuizPhoneQuestion } from "@/modes/quiz/QuizViews";
import { AnswerForm, FoundLine, OtherAnswering, SpeakNow, vibrate } from "./answer";
import type { PhoneCtx } from "./PhoneApp";
import { teamLabel } from "@/lib/icons";

const REASONS: Record<string, string> = {
  locked: "Seu time está bloqueado.",
  paused: "Jogo pausado.",
  closed: "Essa música já fechou.",
  not_yet: "Você joga a partir da próxima música.",
  own_turn: "Seu time já está respondendo!",
  no_team: "Escolha um time primeiro.",
  tiebreak: "Só os times empatados jogam o desempate.",
  turns: "Não é a vez do seu time.",
  choice: "Responda pelos botões das alternativas.",
  music: "Espere a música parar.",
  not_live: "Espere o “Valendo!”.",
  wait: "Espere o “Continuar”.",
  not_played: "Esperem tocar o primeiro trecho.",
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
        <p className="font-display text-xl text-white/70">
          {tiebreakOf(round) ? "☠️ Morte súbita!" : `Rodada ${state.room.round_no} de ${state.room.total_rounds}`}
        </p>
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
  // desempate: quem não está (ou já não está) no páreo só assiste
  const tb = tiebreakOf(round);
  const watching = !!tb && inPlay && !tiebreakLeft(tb).includes(team.id);

  let body: React.ReactNode = null;
  const myTurn = turnOf(round)?.team === team.id;
  if (round.status === "intro") {
    // apresentação: a mesma informação da TV, esperando o "Começar rodada"
    body = (
      <>
        <RoundIntro state={state} round={round} size="phone" />
        <p className="text-white/60">Aguardando “Começar rodada”…</p>
      </>
    );
  } else if (turnWaiting(round)) {
    body = <TurnHandoff state={state} round={round} size="phone" mine={myTurn} />;
  } else if (watching) {
    body = <TiebreakWatch state={state} round={round} out={tb.teams.includes(team.id)} />;
  } else if (ModeView && inPlay) {
    body = notYet ? (
      <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>
    ) : (
      <ModeView state={state} ctx={ctx} round={round} now={now} onFeedback={setFeedback} />
    );
  } else if (round.status === "playing") {
    if (notYet) body = <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>;
    else if (turnClaims(round)) body = <ClaimButton state={state} ctx={ctx} round={round} mine={myTurn} onFeedback={setFeedback} />;
    else body = <BuzzButton state={state} ctx={ctx} round={round} now={now} onFeedback={setFeedback} />;
  } else if (round.status === "answering" && attempt) {
    // um time por vez: sem EU SEI!, o time da vez responde direto
    const turn = turnOf(round);
    const who = turn ? (attempt.steal ? "Passou para vocês! (metade dos pontos)" : "Vez do seu time!") : undefined;
    const quizHint = quizOf(round) ? <QuizPhoneQuestion round={round} now={now} /> : undefined;
    if (attempt.team_id !== team.id) body = <OtherAnswering state={state} ctx={ctx} attempt={attempt} now={now} spoken={spoken} turn={!!turn} />;
    else if (notYet) body = <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>;
    else if (turn && round.mode === "continue" && !contCanAnswer(round, now)) body = <ListenFirst round={round} who={who} />;
    else if (turn && round.mode === "quiz_open" && !round.quiz?.live) body = <ListenFirst round={round} who={who} hint={quizHint} />;
    else if (spoken) body = <SpeakNow state={state} ctx={ctx} attempt={attempt} now={now} title={who} />;
    else body = <AnswerForm key={attempt.id} state={state} ctx={ctx} round={round} attempt={attempt} now={now} who={who} hint={quizHint} />;
  } else if (round.status === "doubt" && attempt) {
    const t = teamById(state, attempt.team_id);
    body = (
      <>
        <p className="font-display text-4xl">🤔</p>
        <p className="font-display text-3xl">Valeu ou não valeu?</p>
        <p className="text-white/70 text-lg">O apresentador está decidindo a resposta {attempt.team_id === team.id ? "do seu time" : `de ${t?.name}`}.</p>
      </>
    );
  } else if (round.status === "revealed" && tb) {
    body = <TiebreakRevealPhone state={state} ctx={ctx} round={round} />;
  } else if (round.status === "revealed") {
    body = <RevealPhone state={state} ctx={ctx} round={round} />;
  } else if (round.status === "scoreboard") {
    body = <ScorePhone state={state} ctx={ctx} round={round} />;
  }

  return (
    <>
      {body}
      {myDecision && (round.status === "playing" || round.status === "answering") && (
        <DecisionToast attempt={myDecision} mode={round.mode} tiebreak={!!tb} />
      )}
      {feedback && <p className="npl-pop absolute bottom-6 left-4 right-4 rounded-2xl bg-black/80 px-4 py-3 text-lg">{feedback}</p>}
    </>
  );
}

function DecisionToast({ attempt, mode, tiebreak }: { attempt: Attempt; mode: string; tiebreak?: boolean }) {
  const ok = attempt.status === "correct";
  const parts = attemptParts(attempt, mode);
  return (
    <div className={`npl-pop absolute left-4 right-4 top-4 z-10 rounded-2xl px-4 py-3 font-display text-2xl ${ok ? "bg-emerald-500" : "bg-rose-600"}`}>
      {ok ? (parts ? `✓ Acertaram ${parts}!` : "✓ Acertaram!") : attempt.status === "timeout" ? "⏱ Tempo esgotado" : "✗ Errou!"}
      {tiebreak && !ok ? " Fora do desempate." : ""}{" "}
      {attempt.points ? (attempt.points > 0 ? `+${attempt.points}` : attempt.points) : ""}
    </div>
  );
}

/** Um time por vez: a resposta só abre quando a música para (continuar) ou no "Valendo!" (quiz). */
function ListenFirst({ round, who, hint }: { round: Round; who?: string; hint?: React.ReactNode }) {
  const cont = round.mode === "continue";
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4">
      {who && <p className="font-display text-3xl font-bold text-yellow-300">{who}</p>}
      {hint}
      <p className="font-display text-5xl">{cont ? "🎧" : "📖"}</p>
      <p className="font-display text-2xl">
        {cont
          ? round.played_stage === 0
            ? "Esperem a música tocar…"
            : "Escutem! A resposta abre quando a música parar."
          : "Leiam a pergunta. O tempo começa no “Valendo!”"}
      </p>
    </div>
  );
}

/**
 * Um time por vez (Clássico / Obra / Instrumentos): o controlador toca os
 * trechos; o time da vez aperta "Responder agora" quando souber (aí o tempo
 * começa e vale o trecho atual). Os outros times assistem.
 */
function ClaimButton({ state, ctx, round, mine, onFeedback }: { state: RoomState; ctx: PhoneCtx; round: Round; mine: boolean; onFeedback: (m: string) => void }) {
  const turn = turnOf(round)!;
  const t = teamById(state, turn.team);
  const busy = useRef(false);
  const [pressed, setPressed] = useState(false);
  const pts = Math.round(stagePoints(round));
  const ready = round.played_stage >= 1;
  if (!mine) {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl p-6" style={{ background: t?.color, color: t ? textOn(t.color) : undefined }}>
        <p className="font-display text-2xl">Vez do time</p>
        <p className="font-display text-4xl font-bold">{t ? teamLabel(t) : "?"}</p>
        <p className="font-display text-xl opacity-90">valendo {pts} pts{turn.factor < 1 ? " (metade)" : ""}</p>
        <p className="text-lg opacity-80">Fiquem de olho: se errarem, a vez pode passar!</p>
      </div>
    );
  }
  const team = ctx.team!;
  const bg = ready ? team.color : "#64748b";
  const press = async () => {
    if (busy.current || !ready) return;
    busy.current = true;
    setPressed(true);
    vibrate(40);
    try {
      const r = await api.turnClaim(ctx.code, ctx.token, round.id);
      if (!r.ok) onFeedback(REASONS[r.reason ?? ""] ?? "Não deu.");
    } catch (e) {
      onFeedback(friendlyError(e));
    } finally {
      busy.current = false;
      setPressed(false);
    }
  };
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <p className="font-display text-3xl font-bold text-yellow-300">{turn.factor < 1 ? "Passou para vocês!" : "Vez do seu time!"}</p>
      <FoundLine state={state} round={round} />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          press();
        }}
        disabled={!ready}
        className={`aspect-square w-[min(80vw,55vh)] rounded-full font-display font-bold shadow-[0_14px_0_rgba(0,0,0,0.35)] transition active:translate-y-3 active:shadow-[0_2px_0_rgba(0,0,0,0.35)] ${
          ready ? "npl-pulse text-5xl" : "text-3xl"
        } ${pressed ? "translate-y-3 shadow-[0_2px_0_rgba(0,0,0,0.35)]" : ""}`}
        style={{ background: bg, color: textOn(bg) }}
      >
        {ready ? (
          <>
            Responder
            <br />
            agora
          </>
        ) : (
          "Esperem o 1º trecho…"
        )}
      </button>
      <p className="font-display text-xl text-white/80">
        Valendo <b className="text-yellow-300">{pts}</b> pts agora{turn.factor < 1 ? " (metade)" : ""} — peçam mais trechos ou respondam
      </p>
    </div>
  );
}

function BuzzButton({ state, ctx, round, now, onFeedback }: { state: RoomState; ctx: PhoneCtx; round: Round; now: number; onFeedback: (m: string) => void }) {
  const team = ctx.team!;
  const busy = useRef(false);
  const [pressed, setPressed] = useState(false);
  const lock = lockInfo(round, team.id, now);
  const lyrics = round.mode === "lyrics";
  const locked = !!lock;
  // continuar a letra: só depois que a música para; quiz no botão: só depois do "Valendo!"
  const waitMusic = round.mode === "continue" && !contCanAnswer(round, now);
  const notLive = round.mode === "quiz_open" && !round.quiz?.live;
  const held = waitMusic || notLive;
  const bg = locked || held ? "#64748b" : team.color;

  const press = async () => {
    if (busy.current || locked || held) return;
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
      <QuizPhoneQuestion round={round} now={now} />
      <FoundLine state={state} round={round} />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          press();
        }}
        disabled={locked || held}
        className={`aspect-square w-[min(80vw,55vh)] rounded-full font-display font-bold shadow-[0_14px_0_rgba(0,0,0,0.35)] transition active:translate-y-3 active:shadow-[0_2px_0_rgba(0,0,0,0.35)] ${
          locked || held ? "text-4xl" : "npl-pulse text-6xl"
        } ${pressed ? "translate-y-3 shadow-[0_2px_0_rgba(0,0,0,0.35)]" : ""}`}
        style={{ background: bg, color: textOn(bg) }}
      >
        {held && !locked ? (
          <>
            EU SEI!
            <br />
            <span className="text-2xl">{notLive ? "Aguardem o “Valendo!”" : round.played_stage === 0 ? "Esperem a música tocar" : "Espere a música parar"}</span>
          </>
        ) : locked ? (
          <>
            🔒
            <br />
            <span className="tabular-nums">{lock!.waiting ? (lyrics ? "Aguardando o próximo verso" : "Aguardando a música") : `Liberado em ${Math.ceil(lock!.ms / 1000)}s`}</span>
          </>
        ) : (
          "EU SEI!"
        )}
      </button>
      <p className="font-display text-xl text-white/80">
        {locked
          ? lock!.waiting
            ? `Seu time errou — a contagem começa quando ${lyrics ? "o próximo verso aparecer" : "a música voltar"}`
            : "Seu time errou — espere a contagem"
          : tiebreakOf(round)
            ? "☠️ Desempate: acerte a música e vença!"
            : `Rodada ${round.round_no} de ${state.room.total_rounds}`}
      </p>
    </div>
  );
}

function RevealPhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round }) {
  const team = ctx.team!;
  const myAttempts = state.attempts.filter((a) => a.round_id === round.id && a.team_id === team.id && a.kind === "turn");
  // alternativas: todos os times que acertaram ganham
  const won =
    round.artist_team_id === team.id || round.title_team_id === team.id || myAttempts.some((a) => a.status === "correct");
  const erred = myAttempts.some((a) => a.status === "wrong" || a.status === "timeout");
  const winner = teamById(state, round.title_team_id ?? round.artist_team_id);
  const delta = roundDelta(state, round).get(team.id) ?? 0;
  const quiz = quizOf(round);
  const noAnswer = round.mode === "quiz_choice" && !myAttempts.length && !round.skipped;
  return (
    <>
      {won ? (
        <p className="npl-pop font-display text-6xl font-bold text-emerald-300">🎉 Acertou!</p>
      ) : erred ? (
        <p className="npl-pop font-display text-6xl font-bold text-rose-300">❌ Errou</p>
      ) : noAnswer ? (
        <p className="font-display text-3xl">⏱ Seu time não respondeu</p>
      ) : winner ? (
        <p className="font-display text-3xl"><TeamChip team={winner} /> acertou</p>
      ) : (
        <p className="font-display text-3xl">{round.skipped ? "Música pulada" : "Ninguém acertou 😅"}</p>
      )}
      {delta !== 0 && <p className="font-display text-5xl font-bold">{delta > 0 ? `+${delta}` : delta} pts</p>}
      <QuizAnswerLine round={round} />
      {round.reveal && !quiz?.hide_song && (
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

/** Desempate: times que não estão no páreo assistem. */
function TiebreakWatch({ state, round, out }: { state: RoomState; round: Round; out: boolean }) {
  const tb = tiebreakOf(round)!;
  return (
    <>
      <p className="font-display text-5xl">👀</p>
      <p className="font-display text-3xl">Assistindo ao desempate</p>
      {out && <p className="text-lg text-rose-300">Seu time errou e está fora do desempate.</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {tiebreakLeft(tb).map((id) => {
          const t = teamById(state, id);
          return t ? <TeamChip key={id} team={t} className="text-lg">{t.name}</TeamChip> : null;
        })}
      </div>
    </>
  );
}

function TiebreakRevealPhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round }) {
  const w = teamById(state, tiebreakDecider(round));
  const mine = w && w.id === ctx.team?.id;
  return (
    <>
      {mine ? (
        <p className="npl-pop font-display text-5xl font-bold text-emerald-300">🏆 Vocês venceram o desempate!</p>
      ) : w ? (
        <p className="font-display text-3xl"><TeamChip team={w} /> venceu o desempate</p>
      ) : (
        <p className="font-display text-3xl">{round.skipped ? "Música pulada" : "Ninguém acertou 😅"}</p>
      )}
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
    </>
  );
}
