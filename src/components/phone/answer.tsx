"use client";
// Peças da vez de resposta no celular, usadas por todos os modos.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { formatSeconds, lateTaps, missingParts, teamById } from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { OBRA_ASK, obraOf } from "@/modes/obra/logic";
import { vocalsOnly } from "@/modes/stems/logic";
import { isQuizMode, quizOf } from "@/modes/quiz/logic";
import type { PhoneCtx } from "./PhoneApp";
import { teamLabel } from "@/lib/icons";

export const vibrate = (p: number | number[]) => {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* sem suporte: ignora */
  }
};

export function FoundLine({ state, round }: { state: RoomState; round: Round }) {
  const f = round.found ?? {};
  if (!f.artist && !f.title) return null;
  const need = missingParts(state, round);
  return (
    <p className="rounded-xl bg-emerald-500/20 px-3 py-2 text-lg">
      {f.artist && <>Artista: <b>{f.artist}</b> ✓ </>}
      {f.title && <>Música: <b>{f.title}</b> ✓ </>}— falta {need.title ? "a música" : "o artista"}
    </p>
  );
}

export function useCountdown(ctx: PhoneCtx, attempt: Attempt, paused: boolean, now: number) {
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

/** Título da vez: "Você apertou!" (clássico) ou outro texto (ex.: "Vez do seu time!"). */
function TurnHeader({ ctx, attempt, left, text, who }: { ctx: PhoneCtx; attempt: Attempt; left: number | null; text: string; who?: string }) {
  const team = ctx.team!;
  return (
    <div className="flex w-full items-center justify-between rounded-2xl px-4 py-2" style={{ background: team.color, color: textOn(team.color) }}>
      <span className="font-display text-lg text-left">
        {who ?? (attempt.player_id === ctx.me.id ? "Você apertou!" : "Seu time apertou!")}
        <br />
        {text}
      </span>
      <span className="font-display text-5xl font-bold tabular-nums">{left !== null ? Math.ceil(left / 1000) : "∞"}</span>
    </div>
  );
}

/** Resposta falada: sem campo de texto. title: "Vez do seu time!" (um time por vez). */
export function SpeakNow({ state, ctx, attempt, now, title }: { state: RoomState; ctx: PhoneCtx; attempt: Attempt; now: number; title?: string }) {
  const left = useCountdown(ctx, attempt, state.room.paused, now);
  const team = ctx.team!;
  return (
    <div className="npl-pop flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl p-6" style={{ background: team.color, color: textOn(team.color) }}>
      <p className="font-display text-5xl">🗣️</p>
      {title && <p className="font-display text-2xl">{title}</p>}
      <p className="font-display text-4xl font-bold">Falem a resposta em voz alta!</p>
      {left !== null ? (
        <p className={`font-display text-8xl font-bold tabular-nums ${left <= 5000 ? "animate-pulse" : ""}`}>{Math.ceil(left / 1000)}</p>
      ) : (
        <p className="font-display text-xl opacity-80">sem limite de tempo</p>
      )}
    </div>
  );
}

/** Resposta digitada (só as partes que faltam). No "Todos jogam", a zona de dúvida vira "Quase!". */
export function AnswerForm({
  state,
  ctx,
  round,
  attempt,
  now,
  who,
  hint,
}: {
  state: RoomState;
  ctx: PhoneCtx;
  round: Round;
  attempt: Attempt;
  now: number;
  who?: string;
  hint?: React.ReactNode;
}) {
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [almost, setAlmost] = useState<{ artist?: string; title?: string } | null>(null);
  const left = useCountdown(ctx, attempt, state.room.paused, now);
  const need = missingParts(state, round);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.submitAnswer(ctx.code, ctx.token, attempt.id, need.artist ? artist : "", need.title ? title : "");
      if (!r.ok) {
        setMsg(r.reason === "empty" ? "Preencha pelo menos um campo." : r.reason === "timeout" ? "O tempo acabou!" : "Um colega já respondeu.");
      } else if (r.result === "almost") {
        setAlmost({ artist: r.artist, title: r.title });
        vibrate([60, 40, 60]);
      } else setAlmost(null);
    } catch (err) {
      setMsg(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (doubt: boolean) =>
    `rounded-2xl bg-white px-4 py-4 font-display text-2xl text-violet-950 outline-none focus:ring-4 ${doubt ? "ring-4 ring-amber-400" : "ring-yellow-300"}`;

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
      <TurnHeader ctx={ctx} attempt={attempt} left={left} text="Conversem e respondam" who={who} />
      {hint}
      <FoundLine state={state} round={round} />
      {almost && (
        <p className="npl-pop rounded-2xl bg-amber-400 px-4 py-3 font-display text-xl text-violet-950">
          {round.mode === "continue" ? "Quase! Confira a linha e envie de novo." : isQuizMode(round.mode) || round.mode === "obra" ? "Quase! Confira a escrita e envie de novo." : <>Quase! Confira a escrita {almost.artist === "doubt" && almost.title === "doubt" ? "dos dois" : almost.artist === "doubt" ? "do artista" : "da música"} e envie de novo.</>}
        </p>
      )}
      {need.artist && (
        <input
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artista"
          autoComplete="off"
          autoCapitalize="words"
          autoFocus={!need.title}
          className={field(almost?.artist === "doubt")}
        />
      )}
      {need.title && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={round.mode === "continue" ? "Continue a letra…" : quizOf(round)?.year ? "Ano (ex.: 1994)" : isQuizMode(round.mode) ? "Sua resposta" : round.mode === "obra" ? (OBRA_ASK[obraOf(round)?.pack ?? ""] ?? "Nome da obra") : "Música"}
          inputMode={quizOf(round)?.year ? "numeric" : undefined}
          autoComplete="off"
          autoFocus={!need.artist}
          className={field(almost?.title === "doubt")}
        />
      )}
      {need.artist && need.title && (
        <p className="text-sm text-white/60">
          {vocalsOnly(round) ? "Basta um. Artista vale 100%, música +50% de bônus." : "Basta um. Artista vale 50%, música 100%, os dois 150%."}
        </p>
      )}
      <Button type="submit" disabled={busy || (!artist.trim() && !title.trim())} className="text-2xl py-4">
        {busy ? "Enviando…" : almost ? "Reenviar" : "Responder"}
      </Button>
      {msg && <p className="text-rose-300">{msg}</p>}
    </form>
  );
}

export function OtherAnswering({
  state,
  ctx,
  attempt,
  now,
  spoken,
  turn,
}: {
  state: RoomState;
  ctx: PhoneCtx;
  attempt: Attempt;
  now: number;
  spoken: boolean;
  /** um time por vez: "Vez do time X" */
  turn?: boolean;
}) {
  const t = teamById(state, attempt.team_id);
  const left = useCountdown(ctx, attempt, state.room.paused, now);
  const mine = lateTaps(state, attempt).find((l) => l.team?.id === ctx.team?.id);
  if (!t) return null;
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl p-6" style={{ background: t.color, color: textOn(t.color) }}>
      {turn && <p className="font-display text-2xl">Vez do time</p>}
      <p className="font-display text-4xl font-bold">{teamLabel(t)}</p>
      <p className="font-display text-2xl">{spoken ? "está respondendo…" : "está digitando…"}</p>
      {left !== null && <p className="font-display text-6xl font-bold tabular-nums">{Math.ceil(left / 1000)}</p>}
      {mine && <p className="text-lg opacity-90">Seu time apertou {formatSeconds(mine.ms)}s depois 😬</p>}
    </div>
  );
}
