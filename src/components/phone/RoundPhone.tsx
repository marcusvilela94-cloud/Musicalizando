"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Spinner, TeamChip } from "@/components/ui";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { currentAttempt, formatSeconds, lateTaps, ranking, roundDelta, teamById } from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import type { PhoneCtx } from "./PhoneApp";

const REASONS: Record<string, string> = {
  locked: "Seu time está bloqueado até outro time errar.",
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

  if (!round || round.status === "loading") {
    return (
      <>
        <p className="font-display text-xl text-white/70">Rodada {state.room.round_no} de {state.room.total_rounds}</p>
        <Spinner label="Preparando a próxima música… 🎧" />
      </>
    );
  }
  const team = ctx.team!;
  const attempt = currentAttempt(state, round);
  const notYet = ctx.me.active_from_round > round.round_no;

  let body: React.ReactNode = null;
  if (round.status === "playing") {
    if (notYet) body = <p className="font-display text-3xl">Você entra na próxima música! 🎧</p>;
    else body = <BuzzButton state={state} ctx={ctx} round={round} onFeedback={setFeedback} />;
  } else if (round.status === "answering" && attempt) {
    body = attempt.team_id === team.id ? <AnswerForm state={state} ctx={ctx} attempt={attempt} /> : <OtherAnswering state={state} ctx={ctx} attempt={attempt} />;
  } else if (round.status === "doubt" && attempt) {
    const t = teamById(state, attempt.team_id);
    body = (
      <>
        <p className="font-display text-4xl">🤔</p>
        <p className="font-display text-3xl">Valeu ou não valeu?</p>
        <p className="text-white/70 text-lg">O dono está decidindo a resposta {attempt.team_id === team.id ? "do seu time" : `de ${t?.name}`}.</p>
        <p className="text-xl">“{[attempt.answer_artist, attempt.answer_title].filter(Boolean).join(" · ")}”</p>
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
      {feedback && <p className="npl-pop absolute bottom-6 left-4 right-4 rounded-2xl bg-black/80 px-4 py-3 text-lg">{feedback}</p>}
    </>
  );
}

function BuzzButton({ state, ctx, round, onFeedback }: { state: RoomState; ctx: PhoneCtx; round: Round; onFeedback: (m: string) => void }) {
  const team = ctx.team!;
  const busy = useRef(false);
  const [pressed, setPressed] = useState(false);
  const locked = round.locked_team_id === team.id;
  const bg = locked ? "#64748b" : team.color;

  const press = async () => {
    if (busy.current || locked) return;
    busy.current = true;
    setPressed(true);
    navigator.vibrate?.(60);
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
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          press();
        }}
        disabled={locked}
        className={`aspect-square w-[min(80vw,55vh)] rounded-full font-display text-6xl font-bold shadow-[0_14px_0_rgba(0,0,0,0.35)] transition active:translate-y-3 active:shadow-[0_2px_0_rgba(0,0,0,0.35)] ${
          locked ? "" : "npl-pulse"
        } ${pressed ? "translate-y-3 shadow-[0_2px_0_rgba(0,0,0,0.35)]" : ""}`}
        style={{ background: bg, color: textOn(bg) }}
      >
        {locked ? "🔒" : "EU SEI!"}
      </button>
      <p className="font-display text-xl text-white/80">
        {locked ? "Bloqueado: espere outro time errar" : round.had_error ? "Roubo vale metade!" : `Rodada ${round.round_no} de ${state.room.total_rounds}`}
      </p>
    </div>
  );
}

function useCountdown(ctx: PhoneCtx, attempt: Attempt, paused: boolean) {
  const now = useNow(ctx.serverNow, 200, !!attempt.deadline);
  const left = attempt.deadline ? Math.max(0, Date.parse(attempt.deadline) - now) : null;
  // tempo acabou: pede ao servidor para conferir (o relógio que vale é o do servidor)
  const deadline = attempt.deadline;
  useEffect(() => {
    if (!deadline || paused) return;
    const ms = Date.parse(deadline) + 1800 - ctx.serverNow();
    const t = setTimeout(() => api.tick(ctx.code).catch(() => {}), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [deadline, paused, ctx]);
  return left;
}

function AnswerForm({ state, ctx, attempt }: { state: RoomState; ctx: PhoneCtx; attempt: Attempt }) {
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const left = useCountdown(ctx, attempt, state.room.paused);
  const both = state.room.settings.scoring === "artist_title";
  const who = state.players.find((p) => p.id === attempt.player_id);
  const team = ctx.team!;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.submitAnswer(ctx.code, ctx.token, attempt.id, both ? artist : "", title);
      if (!r.ok) {
        setMsg(r.reason === "empty" ? "Preencha pelo menos um campo." : r.reason === "timeout" ? "O tempo acabou!" : "Um colega já respondeu.");
      }
    } catch (err) {
      setMsg(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
      <div className="flex items-center justify-between rounded-2xl px-4 py-2" style={{ background: team.color, color: textOn(team.color) }}>
        <span className="font-display text-lg text-left">
          {who?.id === ctx.me.id ? "Você apertou!" : `${who?.nickname ?? "Seu time"} apertou!`}
          <br />
          Conversem e respondam
        </span>
        <span className="font-display text-5xl font-bold tabular-nums">{left !== null ? Math.ceil(left / 1000) : "∞"}</span>
      </div>
      {both && (
        <input
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artista"
          autoComplete="off"
          autoCapitalize="words"
          className="rounded-2xl bg-white px-4 py-4 font-display text-2xl text-violet-950 outline-none focus:ring-4 ring-yellow-300"
        />
      )}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Música"
        autoComplete="off"
        autoFocus={!both}
        className="rounded-2xl bg-white px-4 py-4 font-display text-2xl text-violet-950 outline-none focus:ring-4 ring-yellow-300"
      />
      {both && <p className="text-sm text-white/60">Basta um. Acertar o título vale +50%.</p>}
      <Button type="submit" disabled={busy || (!artist.trim() && !title.trim())} className="text-2xl py-4">
        {busy ? "Enviando…" : "Responder"}
      </Button>
      {msg && <p className="text-rose-300">{msg}</p>}
    </form>
  );
}

function OtherAnswering({ state, ctx, attempt }: { state: RoomState; ctx: PhoneCtx; attempt: Attempt }) {
  const t = teamById(state, attempt.team_id);
  const left = useCountdown(ctx, attempt, state.room.paused);
  const mine = lateTaps(state, attempt).find((l) => l.team?.id === ctx.team?.id);
  if (!t) return null;
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl p-6" style={{ background: t.color, color: textOn(t.color) }}>
      <p className="font-display text-4xl font-bold">{t.name}</p>
      <p className="font-display text-2xl">está respondendo…</p>
      {left !== null && <p className="font-display text-6xl font-bold tabular-nums">{Math.ceil(left / 1000)}</p>}
      {mine && <p className="text-lg opacity-90">Seu time apertou {formatSeconds(mine.ms)}s depois 😬</p>}
    </div>
  );
}

function RevealPhone({ state, ctx, round }: { state: RoomState; ctx: PhoneCtx; round: Round }) {
  const team = ctx.team!;
  const winner = teamById(state, round.winner_team_id);
  const myAttempts = state.attempts.filter((a) => a.round_id === round.id && a.team_id === team.id && a.kind === "turn");
  const won = round.winner_team_id === team.id;
  const erred = myAttempts.some((a) => a.status === "wrong" || a.status === "timeout");
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
            <p className="text-white/70">{round.reveal.artist}</p>
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
